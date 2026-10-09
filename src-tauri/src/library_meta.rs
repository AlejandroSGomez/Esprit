//! Per-paper library metadata: several project tags, a read/unread marker and
//! the user's note, kept in `Bib/.esprit-biblioteca.json` next to the PDFs.
//! Papers saved from the radar also show the radar sheet (idea, key points,
//! why it matters), resolved natively from the radar register by the saved
//! file name, so older additions get it too. Keys are paths relative to the configured library
//! computed natively; the frontend only ever sends opaque catalogue handles.
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Component, Path},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const REGISTER_NAME: &str = ".esprit-biblioteca.json";
const VERSION: u8 = 1;
const MAX_ENTRIES: usize = 2_000;
const MAX_REGISTER_BYTES: usize = 8 * 1_048_576;
pub const MAX_NOTE_CHARS: usize = 8_000;
const MAX_TAGS: usize = 10;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    /// Path relative to the configured library, `/`-separated.
    pub key: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub read: bool,
    #[serde(default)]
    pub note: String,
    pub updated_ms: u64,
    /// File name the radar saved it under, kept when the user renames the
    /// PDF so its radar sheet stays linked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radar_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uid: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Register {
    pub version: u8,
    pub revision: u64,
    pub entries: Vec<Entry>,
}

/// One writer at a time for the register (edits, radar additions, moves).
static LOCK: Mutex<()> = Mutex::new(());

/// What the radar showed when the paper was recommended.
#[derive(Clone, Debug, Serialize)]
pub struct RadarSheet {
    pub title: String,
    pub authors: Vec<String>,
    pub published: String,
    pub tldr: String,
    pub takeaways: Vec<String>,
    pub why_relevant: String,
    pub summary: String,
    pub project: String,
    pub concrete_use: String,
    pub relevance_score: u8,
    pub source_id: String,
}

/// Merged view for one paper; `tags` falls back to the folder's collection.
#[derive(Clone, Debug, Serialize)]
pub struct PaperMeta {
    pub uid: Option<String>,
    pub collection: String,
    pub tags: Vec<String>,
    pub read: bool,
    pub note: String,
    pub updated_ms: u64,
    pub radar: Option<RadarSheet>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_millis() as u64).unwrap_or_default()
}

fn register_path() -> Result<std::path::PathBuf, String> {
    Ok(super::verified_library_root(&*super::config::current()?)?.join(REGISTER_NAME))
}

pub fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 1_024
        && key.to_ascii_lowercase().ends_with(".pdf")
        && !key.contains('\0')
        && Path::new(key).components().all(|component| matches!(component, Component::Normal(_)))
}

/// the configured library-relative key for a canonical path inside the library root.
pub fn key_for(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let parts: Vec<&str> = relative.components().map(|component| match component {
        Component::Normal(value) => value.to_str(),
        _ => None,
    }).collect::<Option<_>>()?;
    let key = parts.join("/");
    valid_key(&key).then_some(key)
}

fn validate_register(register: &Register) -> Result<(), String> {
    if register.version != VERSION || register.entries.len() > MAX_ENTRIES {
        return Err("El registro de la biblioteca no es válido".into());
    }
    let mut keys = std::collections::HashSet::new();
    for entry in &register.entries {
        if !valid_key(&entry.key) || !keys.insert(entry.key.as_str()) {
            return Err("El registro de la biblioteca tiene una entrada no válida".into());
        }
        validate_fields(&entry.tags, &entry.note)?;
    }
    Ok(())
}

fn validate_fields(tags: &[String], note: &str) -> Result<(), String> {
    if tags.len() > MAX_TAGS || tags.iter().any(|tag| tag.is_empty() || tag.len()>80 || !tag.bytes().all(|b| b.is_ascii_alphanumeric() || b==b'-' || b==b'_')) {
        return Err("Etiqueta de biblioteca no válida".into());
    }
    let mut seen = std::collections::HashSet::new();
    if !tags.iter().all(|tag| seen.insert(tag)) {
        return Err("Etiqueta repetida".into());
    }
    if note.chars().count() > MAX_NOTE_CHARS || note.contains('\0') {
        return Err(format!("La nota admite hasta {MAX_NOTE_CHARS} caracteres"));
    }
    Ok(())
}

pub fn load_from(path: &Path) -> Result<Register, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Register { version: VERSION, ..Default::default() }),
        Err(error) => return Err(format!("No se pudo leer el registro de la biblioteca: {error}")),
        Ok(metadata) if !metadata.is_file() || metadata.len() > MAX_REGISTER_BYTES as u64 => {
            return Err("El registro de la biblioteca no es un archivo normal o es demasiado grande".into())
        }
        Ok(_) => {}
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let mut text = String::new();
    options
        .open(path)
        .and_then(|file| file.take(MAX_REGISTER_BYTES as u64 + 1).read_to_string(&mut text))
        .map_err(|error| format!("No se pudo leer el registro de la biblioteca: {error}"))?;
    let register: Register = serde_json::from_str(&text).map_err(|error| format!("El registro de la biblioteca está dañado; no se sobrescribirá: {error}"))?;
    validate_register(&register)?;
    Ok(register)
}

fn write_to(path: &Path, register: &Register) -> Result<(), String> {
    validate_register(register)?;
    let bytes = serde_json::to_vec_pretty(register).map_err(|error| error.to_string())?;
    let parent = path.parent().ok_or("Ruta del registro no válida")?;
    let temporary = parent.join(format!(".esprit-biblioteca.{}.tmp", super::new_plan_id()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.custom_flags(libc::O_NOFOLLOW);
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("No se pudo guardar el registro de la biblioteca: {error}"))
}

pub fn merged(entry: Option<&Entry>, collection: &str, radar: Option<RadarSheet>) -> PaperMeta {
    let default_tags = || vec![collection.to_string()];
    match entry {
        Some(entry) => PaperMeta {
            uid: entry.uid.clone(),
            collection: collection.into(),
            tags: entry.tags.clone(),
            read: entry.read,
            note: entry.note.clone(),
            updated_ms: entry.updated_ms,
            radar,
        },
        None => PaperMeta { uid: None, collection: collection.into(), tags: default_tags(), read: false, note: String::new(), updated_ms: 0, radar },
    }
}

/// Loads the register for an overview; a damaged file is reported, never rewritten.
pub fn load_for_overview() -> (HashMap<String, Entry>, Option<String>) {
    match register_path().and_then(|path| load_from(&path)) {
        Ok(register) => (register.entries.into_iter().map(|entry| (entry.key.clone(), entry)).collect(), None),
        Err(error) => (HashMap::new(), Some(error)),
    }
}

pub struct Patch {
    pub tags: Option<Vec<String>>,
    pub read: Option<bool>,
    pub note: Option<String>,
}

pub fn apply_patch(register: &mut Register, key: &str, collection: &str, patch: Patch, now: u64) -> Result<Entry, String> {
    if !valid_key(key) {
        return Err("Paper de Bib no válido".into());
    }
    let index = match register.entries.iter().position(|entry| entry.key == key) {
        Some(index) => index,
        None => {
            if register.entries.len() >= MAX_ENTRIES {
                return Err("El registro de la biblioteca está lleno".into());
            }
            register.entries.push(Entry { key: key.into(), tags: vec![collection.into()], read: false, note: String::new(), updated_ms: now, radar_name: None, uid: None });
            register.entries.len() - 1
        }
    };
    let entry = &mut register.entries[index];
    let mut next = entry.clone();
    if let Some(tags) = patch.tags { next.tags = tags; }
    if let Some(read) = patch.read { next.read = read; }
    if let Some(note) = patch.note { next.note = note.trim_end().to_string(); }
    validate_fields(&next.tags, &next.note)?;
    next.updated_ms = now.max(entry.updated_ms + 1);
    *entry = next;
    register.revision += 1;
    Ok(entry.clone())
}

pub fn update(key: &str, collection: &str, patch: Patch) -> Result<Entry, String> {
    if patch.tags.as_ref().is_some_and(|tags| tags.iter().any(|tag| tag != "general" && !super::config::current().is_ok_and(|cfg| cfg.project(tag).is_some()))) { return Err("Etiqueta no configurada".into()); }
    let _guard = LOCK.lock().map_err(|_| "La biblioteca está ocupada")?;
    let path = register_path()?;
    let mut register = load_from(&path)?;
    let entry = apply_patch(&mut register, key, collection, patch, now_ms())?;
    write_to(&path, &register)?;
    Ok(entry)
}

/// Keeps a paper's tags, marker and note when Esprit moves it between collections.
pub fn rename_key(from: &str, to: &str) -> Result<(), String> {
    relink(from, to, None, "general")
}

/// Moves an entry to a new key. `radar_name` (the old file name of a radar
/// paper) keeps its sheet linked after a rename, creating the entry if needed.
pub fn relink(from: &str, to: &str, radar_name: Option<String>, collection: &str) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|_| "La biblioteca está ocupada")?;
    let path = register_path()?;
    let mut register = load_from(&path)?;
    if !valid_key(to) || register.entries.iter().any(|entry| entry.key == to) {
        return Ok(());
    }
    match register.entries.iter_mut().find(|entry| entry.key == from) {
        Some(entry) => {
            entry.key = to.into();
            if entry.radar_name.is_none() { entry.radar_name = radar_name; }
        }
        None if radar_name.is_some() => {
            if register.entries.len() >= MAX_ENTRIES { return Ok(()); }
            register.entries.push(Entry { key: to.into(), tags: vec![collection.into()], read: false, note: String::new(), updated_ms: now_ms(), radar_name, uid: None });
        }
        None => return Ok(()),
    }
    register.revision += 1;
    write_to(&path, &register)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_stay_inside_bib() {
        assert!(valid_key("Projects/Example/paper.pdf"));
        assert!(!valid_key("../outside.pdf"));
        assert!(!valid_key("/etc/passwd.pdf"));
        assert!(!valid_key("Projects/notes.md"));
        let root = Path::new("/tmp/Bib");
        assert_eq!(key_for(root, Path::new("/tmp/Bib/Projects/A/x.pdf")).as_deref(), Some("Projects/A/x.pdf"));
        assert_eq!(key_for(root, Path::new("/tmp/Other/x.pdf")), None);
    }

    #[test]
    fn register_round_trips_and_refuses_symlinks() {
        let root = std::env::temp_dir().join(format!("esprit-library-meta-{}", super::super::new_plan_id()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join(REGISTER_NAME);
        let mut register = load_from(&path).unwrap();
        apply_patch(&mut register, "a.pdf", "general", Patch { tags: None, read: Some(true), note: Some("Nota".into()) }, 1).unwrap();
        write_to(&path, &register).unwrap();
        assert_eq!(load_from(&path).unwrap().entries[0].note, "Nota");
        #[cfg(unix)]
        {
            let link = root.join("link.json");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert!(load_from(&link).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }
}

/// Created only when a paper is linked; renames/moves carry this identity with metadata.
pub fn ensure_uid(key: &str, collection: &str) -> Result<String, String> {
    let _guard = LOCK.lock().map_err(|_| "La biblioteca está ocupada")?;
    let path = register_path()?;
    let mut register = load_from(&path)?;
    if let Some(uid) = register.entries.iter().find(|e| e.key == key).and_then(|e| e.uid.clone()) { return Ok(uid); }
    apply_patch(&mut register, key, collection, Patch { tags: None, read: None, note: None }, now_ms())?;
    let uid = super::new_plan_id();
    register.entries.iter_mut().find(|e| e.key == key).unwrap().uid = Some(uid.clone());
    write_to(&path, &register)?;
    Ok(uid)
}
