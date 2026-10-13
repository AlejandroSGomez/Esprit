//! Optional local quick notes, with optimistic revisions and reviewed deletion.
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;


const VERSION: u8 = 1;
const MAX_NOTES: usize = 500;
const MAX_REGISTER_BYTES: usize = 4 * 1_048_576;
const MAX_TITLE_CHARS: usize = 160;
const MAX_BODY_CHARS: usize = 12_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MeetingLink {
    pub project: String,
    pub id: String,
    #[serde(default)]
    pub title: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct QuickNote {
    pub id: String,
    pub category: String,
    pub title: String,
    pub body: String,
    pub created_ms: u64,
    pub updated_ms: u64,
    #[serde(default)]
    pub meeting: Option<MeetingLink>,
    #[serde(default)]
    pub logged_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Register {
    pub version: u8,
    pub revision: u64,
    pub notes: Vec<QuickNote>,
}

#[derive(Default)]
pub struct QuickNotesLock(pub Mutex<()>);

#[derive(Serialize)]
pub struct NoteView {
    #[serde(flatten)]
    pub note: QuickNote,
    /// The Logout has read the current content.
    pub logged: bool,
    pub meeting_exists: bool,
    pub deletable: bool,
    pub delete_reason: String,
}

#[derive(Serialize)]
pub struct View {
    pub revision: u64,
    pub notes: Vec<NoteView>,
}

#[derive(Deserialize)]
pub struct SaveRequest {
    #[serde(default)]
    pub id: Option<String>,
    pub category: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub meeting: Option<MeetingLink>,
    pub expected_revision: u64,
}

#[derive(Deserialize)]
pub struct LoggedEntry {
    pub id: String,
    pub updated_ms: u64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_millis() as u64).unwrap_or_default()
}

fn register_path() -> Result<PathBuf,String> { super::optional_register_path("notes", "quick-notes.json") }

pub(super) fn valid_category(value: &str) -> bool {
    matches!(value, "general" | "burocracia") || super::config::current().is_ok_and(|cfg| cfg.project(value).is_some())
}

fn validate_note(note: &QuickNote) -> Result<(), String> {
    super::validate_plan_id(&note.id)?;
    if !valid_category(&note.category) {
        return Err("Categoría de nota no válida".into());
    }
    if note.title.chars().count() > MAX_TITLE_CHARS || note.title.contains(['\n', '\r']) {
        return Err(format!("El título admite hasta {MAX_TITLE_CHARS} caracteres en una línea"));
    }
    if note.body.chars().count() > MAX_BODY_CHARS {
        return Err(format!("La nota admite hasta {MAX_BODY_CHARS} caracteres"));
    }
    if note.title.trim().is_empty() && note.body.trim().is_empty() {
        return Err("Escribe algo en la nota".into());
    }
    if let Some(meeting) = &note.meeting {
        super::validate_plan_id(&meeting.id)?;
        if !super::config::current().is_ok_and(|cfg| cfg.meetings_enabled() && cfg.project(&meeting.project).is_some()) || meeting.title.chars().count() > 600 {
            return Err("La reunión vinculada no es válida".into());
        }
    }
    Ok(())
}

fn validate_register(register: &Register) -> Result<(), String> {
    if register.version != VERSION || register.notes.len() > MAX_NOTES {
        return Err("El registro de notas rápidas no es válido".into());
    }
    let mut ids = std::collections::HashSet::new();
    for note in &register.notes {
        validate_note(note)?;
        if !ids.insert(note.id.as_str()) {
            return Err("El registro de notas rápidas repite una nota".into());
        }
    }
    Ok(())
}

fn load_from(path: &Path) -> Result<Register, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Register { version: VERSION, revision: 0, notes: Vec::new() })
        }
        Err(error) => return Err(format!("No se pudo leer las notas rápidas: {error}")),
        Ok(metadata) if !metadata.is_file() || metadata.len() > MAX_REGISTER_BYTES as u64 => {
            return Err("El archivo de notas rápidas no es un archivo normal o es demasiado grande".into())
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
        .map_err(|error| format!("No se pudo leer las notas rápidas: {error}"))?;
    let register: Register = serde_json::from_str(&text).map_err(|error| format!("Las notas rápidas no son válidas: {error}"))?;
    validate_register(&register)?;
    Ok(register)
}

fn write_to(path: &Path, register: &Register) -> Result<(), String> {
    validate_register(register)?;
    let bytes = serde_json::to_vec_pretty(register).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_REGISTER_BYTES {
        return Err("Las notas rápidas superan el tamaño máximo".into());
    }
    let parent = path.parent().ok_or("Ruta de notas no válida")?;
    let temporary = parent.join(format!(".quick-notes.{}.tmp", super::new_plan_id()));
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
    result.map_err(|error| format!("No se pudieron guardar las notas rápidas: {error}"))
}

fn meeting_exists(link: &MeetingLink) -> bool {
    let Ok(cfg) = super::config::current() else { return true };
    if !cfg.meetings_enabled() { return true; }
    let Ok(root) = super::verified_project_root(&cfg, &link.project) else { return true };
    let path = root.join("docs/esprit/meetings").join(format!("{}.md", link.id));
    // An unreadable location counts as present: never unlock a deletion by error.
    match fs::symlink_metadata(path) {
        Ok(_) => true,
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

/// Always deletable; the text is a warning shown in the confirmation.
fn deletion(note: &QuickNote, meeting_present: bool) -> (bool, String) {
    let mut warnings = Vec::new();
    if !note.logged_ms.is_some_and(|logged| logged >= note.updated_ms) {
        warnings.push("Aún no la ha leído el Logout, así que no llegará a tu cierre del día.");
    }
    if note.meeting.is_some() && meeting_present {
        warnings.push("Está vinculada a una reunión; la reunión se conserva.");
    }
    (true, warnings.join(" "))
}

fn view_with(register: &Register, exists: impl Fn(&MeetingLink) -> bool) -> View {
    let mut notes: Vec<NoteView> = register
        .notes
        .iter()
        .map(|note| {
            let present = note.meeting.as_ref().is_some_and(&exists);
            let (deletable, delete_reason) = deletion(note, present);
            NoteView {
                logged: note.logged_ms.is_some_and(|logged| logged >= note.updated_ms),
                meeting_exists: present,
                deletable,
                delete_reason,
                note: note.clone(),
            }
        })
        .collect();
    notes.sort_by(|left, right| right.note.updated_ms.cmp(&left.note.updated_ms));
    View { revision: register.revision, notes }
}

fn save_into(register: &mut Register, request: SaveRequest, now: u64) -> Result<String, String> {
    if request.expected_revision != register.revision {
        return Err("Las notas cambiaron en otro sitio; recarga antes de guardar.".into());
    }
    let id = match request.id.as_deref().filter(|value| !value.is_empty()) {
        Some(existing) => {
            let note = register.notes.iter_mut().find(|note| note.id == existing).ok_or("La nota ya no existe")?;
            let mut next = note.clone();
            next.category = request.category;
            next.title = request.title.trim().to_string();
            next.body = request.body.trim_end().to_string();
            next.meeting = request.meeting;
            if next != *note {
                next.updated_ms = now.max(note.updated_ms + 1);
            }
            validate_note(&next)?;
            *note = next;
            existing.to_string()
        }
        None => {
            if register.notes.len() >= MAX_NOTES {
                return Err(format!("Hay {MAX_NOTES} notas rápidas; borra alguna ya anotada antes de crear otra."));
            }
            let note = QuickNote {
                id: super::new_plan_id(),
                category: request.category,
                title: request.title.trim().to_string(),
                body: request.body.trim_end().to_string(),
                created_ms: now,
                updated_ms: now,
                meeting: request.meeting,
                logged_ms: None,
            };
            validate_note(&note)?;
            let id = note.id.clone();
            register.notes.push(note);
            id
        }
    };
    register.revision += 1;
    Ok(id)
}

fn delete_from(register: &mut Register, id: &str, expected_revision: u64, exists: impl Fn(&MeetingLink) -> bool) -> Result<(), String> {
    if expected_revision != register.revision {
        return Err("Las notas cambiaron en otro sitio; recarga antes de borrar.".into());
    }
    let index = register.notes.iter().position(|note| note.id == id).ok_or("La nota ya no existe")?;
    let _ = exists; // Deletion is always allowed; the meeting itself is never touched.
    register.notes.remove(index);
    register.revision += 1;
    Ok(())
}

fn mark_logged_into(register: &mut Register, entries: &[LoggedEntry], now: u64) -> usize {
    let mut marked = 0;
    for entry in entries {
        // Only the exact version the Logout read; later edits stay pending.
        if let Some(note) = register.notes.iter_mut().find(|note| note.id == entry.id && note.updated_ms == entry.updated_ms) {
            note.logged_ms = Some(now.max(note.updated_ms));
            marked += 1;
        }
    }
    if marked > 0 {
        register.revision += 1;
    }
    marked
}

#[tauri::command]
pub async fn quick_notes_load(lock: State<'_, QuickNotesLock>) -> Result<View, String> {
    let _guard = lock.0.lock().map_err(|_| "Las notas están ocupadas")?;
    Ok(view_with(&load_from(&register_path()?)?, meeting_exists))
}

#[tauri::command]
pub async fn quick_notes_save(request: SaveRequest, lock: State<'_, QuickNotesLock>) -> Result<View, String> {
    let _guard = lock.0.lock().map_err(|_| "Las notas están ocupadas")?;
    let path = register_path()?;
    let mut register = load_from(&path)?;
    save_into(&mut register, request, now_ms())?;
    write_to(&path, &register)?;
    Ok(view_with(&register, meeting_exists))
}

#[tauri::command]
pub async fn quick_notes_delete(id: String, expected_revision: u64, confirmed: bool, lock: State<'_, QuickNotesLock>) -> Result<View, String> {
    if !confirmed {
        return Err("Confirma antes de borrar la nota".into());
    }
    let _guard = lock.0.lock().map_err(|_| "Las notas están ocupadas")?;
    let path = register_path()?;
    let mut register = load_from(&path)?;
    delete_from(&mut register, &id, expected_revision, meeting_exists)?;
    write_to(&path, &register)?;
    Ok(view_with(&register, meeting_exists))
}

#[tauri::command]
pub async fn quick_notes_mark_logged(entries: Vec<LoggedEntry>, lock: State<'_, QuickNotesLock>) -> Result<View, String> {
    if entries.len() > MAX_NOTES {
        return Err("Demasiadas notas en el Logout".into());
    }
    let _guard = lock.0.lock().map_err(|_| "Las notas están ocupadas")?;
    let path = register_path()?;
    let mut register = load_from(&path)?;
    if mark_logged_into(&mut register, &entries, now_ms()) > 0 {
        write_to(&path, &register)?;
    }
    Ok(view_with(&register, meeting_exists))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: Option<String>, revision: u64) -> SaveRequest {
        SaveRequest { id, category: "general".into(), title: "Café con Matteo".into(), body: "Recordar $g_{TMS}$".into(), meeting: None, expected_revision: revision }
    }

    #[test]
    fn logout_marks_only_the_version_it_read_and_notes_delete_on_request() {
        let mut register = Register { version: VERSION, ..Default::default() };
        let id = save_into(&mut register, request(None, 0), 1_000).unwrap();
        assert!(deletion(&register.notes[0], false).1.contains("Logout"), "pending notes warn before deletion");
        let updated = register.notes[0].updated_ms;
        assert_eq!(mark_logged_into(&mut register, &[LoggedEntry { id: id.clone(), updated_ms: updated }], 2_000), 1);
        let mut edit = request(Some(id.clone()), register.revision);
        edit.body = "Recordar el protocolo".into();
        save_into(&mut register, edit, 3_000).unwrap();
        assert!(!view_with(&register, |_| false).notes[0].logged, "an edit after the Logout is pending again");
        assert_eq!(mark_logged_into(&mut register, &[LoggedEntry { id: id.clone(), updated_ms: updated }], 4_000), 0, "a stale version is not marked");
        let current = register.notes[0].updated_ms;
        mark_logged_into(&mut register, &[LoggedEntry { id: id.clone(), updated_ms: current }], 5_000);
        let revision = register.revision;
        assert!(delete_from(&mut register, &id, revision, |_| false).is_ok());
        assert!(register.notes.is_empty());
    }

    #[test]
    fn meeting_notes_can_be_deleted_and_warn_about_the_meeting() {
        let mut register = Register { version: VERSION, ..Default::default() };
        let id = save_into(&mut register, request(None, 0), 1_000).unwrap();
        register.notes[0].meeting = Some(MeetingLink { project: "tesis".into(), id: "abc-123".into(), title: "Reunión".into() });
        assert!(deletion(&register.notes[0], true).1.contains("reunión"));
        assert!(delete_from(&mut register, &id, 1, |_| true).is_ok(), "Deleting a linked note preserves the meeting");
    }

    #[test]
    fn rejects_stale_revisions_bad_categories_and_empty_notes() {
        let mut register = Register { version: VERSION, ..Default::default() };
        assert!(save_into(&mut register, request(None, 7), 1).is_err());
        let mut bad = request(None, 0);
        bad.category = "personal".into();
        assert!(save_into(&mut register, bad, 1).is_err());
        let mut empty = request(None, 0);
        empty.title = " ".into();
        empty.body = "\n".into();
        assert!(save_into(&mut register, empty, 1).is_err());
        let mut meeting_in_general = request(None, 0);
        meeting_in_general.meeting = Some(MeetingLink { project: "burocracia".into(), id: "abc".into(), title: String::new() });
        assert!(save_into(&mut register, meeting_in_general, 1).is_err(), "meetings live in research projects");
    }

    #[test]
    fn register_round_trips_atomically_and_refuses_symlinks() {
        let root = std::env::temp_dir().join(format!("esprit-quick-{}", super::super::new_plan_id()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("quick-notes.json");
        let mut register = load_from(&path).unwrap();
        save_into(&mut register, request(None, 0), 10).unwrap();
        write_to(&path, &register).unwrap();
        assert_eq!(load_from(&path).unwrap().notes.len(), 1);
        #[cfg(unix)]
        {
            let link = root.join("link.json");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert!(load_from(&link).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }
}
