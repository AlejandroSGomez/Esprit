//! Human-readable project notes; drafts stay in app data until a reviewed save.
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};

use super::config::{self, Resolved};

/// Encabezados que añade una reunión al STATE.md de su proyecto.
const STATE_ACTIONS_HEADING: &str = "Próximas acciones";
const STATE_DECISIONS_HEADING: &str = "Decisiones recientes";
const STATE_UPDATED_PREFIX: &str = "> Última actualización:";
const LIMIT: usize = 96 * 1024;
const PREFIX: &str = "<!-- esprit-note ";
const FIELD: &str = "<!-- esprit-field ";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Note {
    pub id: String,
    pub kind: String,
    pub project: String,
    pub title: String,
    pub date: String,
    pub fields: BTreeMap<String, String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    version: u8,
    id: String,
    kind: String,
    project: String,
    title: String,
    date: String,
}
#[derive(Serialize)]
pub struct Overview {
    pub notes: Vec<Note>,
    pub warnings: Vec<String>,
}
#[derive(Serialize)]
pub struct Preview {
    pub plan_id: String,
    pub destination: String,
    pub before: String,
    pub after: String,
    /// Only for archiving: the project's STATE.md links this meeting.
    pub state_link: bool,
}
struct Plan {
    root: PathBuf,
    path: PathBuf,
    original: Option<String>,
    content: String,
    created: Instant,
    /// When set, the reviewed note moves here instead of being rewritten.
    archive_to: Option<PathBuf>,
}
#[derive(Default)]
pub struct ResearchStore(Arc<Mutex<HashMap<String, Plan>>>);
#[derive(Default)]
pub struct DraftLock(pub Arc<Mutex<()>>);

fn fields(kind: &str) -> Result<&'static [(&'static str, &'static str)], String> {
    match kind {
        "meeting" => Ok(&[
            ("participants", "Participantes"),
            ("agenda", "Agenda y preguntas"),
            ("references", "Figuras y referencias"),
            ("notes", "Notas"),
            ("decisions", "Acuerdos"),
            ("actions", "Próximas acciones"),
        ]),
        "reading" => Ok(&[
            ("source", "Paper"),
            ("idea", "Idea aprovechable"),
            ("question", "Pregunta abierta"),
            ("application", "Aplicación al proyecto"),
        ]),
        "waiting" => Ok(&[
            ("source", "Fuente"),
            ("owner", "De quién depende"),
            ("since", "Desde cuándo"),
            ("unblocks", "Qué desbloquea"),
            ("meanwhile", "Qué puedo avanzar mientras tanto"),
        ]),
        _ => Err("Tipo de nota no permitido".into()),
    }
}
/// La nota nombra un proyecto con formato de slug; la carpeta real (y su
/// autorización) sale de la configuración al leer o escribir.
fn valid_project(project: &str) -> bool {
    config::valid_slug(project)
}

fn validate(note: &Note, draft: bool) -> Result<(), String> {
    let allowed = fields(&note.kind)?;
    if (!draft && (!valid_project(&note.project) || note.title.trim().is_empty()))
        || (!note.project.is_empty() && !valid_project(&note.project))
        || note.title.len() > 600
        || note.date.len() > 10
        || (!note.date.is_empty() && !super::valid_iso_date(&note.date))
        || (!note.id.is_empty() && super::validate_plan_id(&note.id).is_err())
        || note
            .fields
            .keys()
            .any(|key| !allowed.iter().any(|(k, _)| k == key))
        || note
            .fields
            .values()
            .any(|v| v.len() > 24_000 || (!draft && v.contains("<!-- esprit-")))
        || note.title.contains(['\n', '\r'])
        || (!draft && note.title.contains("<!--"))
        || serde_json::to_vec(note).map_err(|e| e.to_string())?.len() > LIMIT
    {
        return Err("La nota tiene campos no válidos o supera el límite de tamaño".into());
    }
    Ok(())
}
fn render(note: &Note) -> Result<String, String> {
    validate(note, false)?;
    let metadata = Metadata {
        version: 1,
        id: note.id.clone(),
        kind: note.kind.clone(),
        project: note.project.clone(),
        title: note.title.clone(),
        date: note.date.clone(),
    };
    let mut output = format!(
        "{PREFIX}{} -->\n# {}\n\n{}\n",
        serde_json::to_string(&metadata).map_err(|e| e.to_string())?,
        note.title,
        note.date
    );
    for (key, label) in fields(&note.kind)? {
        output.push_str(&format!(
            "\n{FIELD}{key} -->\n## {label}\n\n{}\n<!-- esprit-end -->\n",
            note.fields.get(*key).map(String::as_str).unwrap_or("")
        ));
    }
    if output.len() > LIMIT {
        return Err("La nota supera 96 KB".into());
    }
    Ok(output)
}
fn parse(text: &str) -> Result<Note, String> {
    let first = text.lines().next().unwrap_or("");
    let json = first
        .strip_prefix(PREFIX)
        .and_then(|s| s.strip_suffix(" -->"))
        .ok_or("Cabecera de nota no reconocida")?;
    let metadata: Metadata = serde_json::from_str(json).map_err(|_| "Cabecera de nota dañada")?;
    if metadata.version != 1 {
        return Err("Versión de nota no compatible".into());
    }
    let mut values = BTreeMap::new();
    for (key, label) in fields(&metadata.kind)? {
        let marker = format!("{FIELD}{key} -->\n## {label}\n\n");
        if text.matches(&marker).count() != 1 {
            return Err("Los campos de la nota cambiaron; ábrela en Proyectos".into());
        }
        let value = text
            .split_once(&marker)
            .unwrap()
            .1
            .split_once("\n<!-- esprit-end -->")
            .ok_or("Nota incompleta")?
            .0;
        values.insert(key.to_string(), value.to_string());
    }
    let note = Note {
        id: metadata.id,
        kind: metadata.kind,
        project: metadata.project,
        title: metadata.title,
        date: metadata.date,
        fields: values,
    };
    validate(&note, false)?;
    // Refuse to discard manual edits outside the editable blocks.
    if render(&note)? != text {
        return Err("La nota se editó fuera de sus campos; consérvala desde Proyectos".into());
    }
    Ok(note)
}
fn folder(kind: &str) -> Result<&'static str, String> {
    match kind {
        "meeting" => Ok("meetings"),
        "reading" => Ok("readings"),
        "waiting" => Ok("waiting"),
        _ => Err("Tipo de nota no válido".into()),
    }
}
fn checked_path(root: &Path, path: &Path) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Destino fuera del proyecto")?;
    let mut current = root.to_path_buf();
    for part in relative.components() {
        if !matches!(part, std::path::Component::Normal(_)) {
            return Err("Ruta de nota no válida".into());
        }
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err("No se permiten enlaces simbólicos en las notas".into())
            }
            Ok(m) if current != path && !m.is_dir() => {
                return Err("La carpeta de notas no es un directorio".into())
            }
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}
fn read(path: &Path, max: usize) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
        Ok(m) if !m.is_file() || m.file_type().is_symlink() || m.len() > max as u64 => {
            return Err("El archivo no es regular o supera el límite de lectura".into())
        }
        _ => (),
    }
    let file = super::open_regular_file_readonly(path, "la nota")?;
    let mut text = String::new();
    file.take(max as u64 + 1)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    if text.len() > max {
        return Err("El archivo supera el límite de lectura".into());
    }
    Ok(Some(text))
}
fn publish(plan: &Plan) -> Result<(), String> {
    checked_path(&plan.root, &plan.path)?;
    if read(&plan.path, LIMIT)? != plan.original {
        return Err("El archivo cambió desde la revisión. Prepara una nueva propuesta; no se ha sobrescrito.".into());
    }
    let parent = plan.path.parent().ok_or("Destino no válido")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    checked_path(&plan.root, &plan.path)?;
    let temp = parent.join(format!(".esprit-note-{}.tmp", super::new_plan_id()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temp).map_err(|e| e.to_string())?;
        file.write_all(plan.content.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        if plan.original.is_some() {
            fs::set_permissions(
                &temp,
                fs::metadata(&plan.path)
                    .map_err(|e| e.to_string())?
                    .permissions(),
            )
            .map_err(|e| e.to_string())?;
        }
        checked_path(&plan.root, &plan.path)?;
        if read(&plan.path, LIMIT)? != plan.original {
            return Err("El archivo cambió durante el guardado".into());
        }
        if plan.original.is_none() {
            // Exclusive publication, including a file created after the check.
            fs::hard_link(&temp, &plan.path).map_err(|e| e.to_string())?;
            fs::remove_file(&temp).map_err(|e| e.to_string())?;
        } else {
            fs::rename(&temp, &plan.path).map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
/// Archiving moves a note out of the catalogue without destroying it: the file
/// keeps its bytes under `docs/esprit/archive/`, which the overview never scans.
fn archive_path(root: &Path, note: &Note) -> Result<PathBuf, String> {
    super::validate_plan_id(&note.id)?;
    let path = root
        .join("docs/esprit/archive")
        .join(folder(&note.kind)?)
        .join(format!("{}.md", note.id));
    checked_path(root, &path)?;
    Ok(path)
}
fn archive(plan: &Plan) -> Result<(), String> {
    let target = plan.archive_to.as_ref().ok_or("Destino de archivo no válido")?;
    checked_path(&plan.root, &plan.path)?;
    checked_path(&plan.root, target)?;
    if plan.original.is_none() || read(&plan.path, LIMIT)? != plan.original {
        return Err("La nota cambió desde la revisión. Vuelve a abrirla; no se ha movido.".into());
    }
    let parent = target.parent().ok_or("Destino de archivo no válido")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    checked_path(&plan.root, target)?;
    // Exclusive: never replaces an archived note with the same identifier.
    fs::hard_link(&plan.path, target).map_err(|e| e.to_string())?;
    if let Err(error) = fs::remove_file(&plan.path) {
        let _ = fs::remove_file(target);
        return Err(error.to_string());
    }
    Ok(())
}
fn prepare_archive(cfg: &Resolved, note: Note, plans: &mut HashMap<String, Plan>) -> Result<Preview, String> {
    if note.id.is_empty() {
        return Err("Solo se pueden borrar notas ya guardadas".into());
    }
    let root = super::verified_project_root(cfg, &note.project)?;
    let path = note_path(&root, &note)?;
    let original = read(&path, LIMIT)?.ok_or("La nota ya no está disponible")?;
    if parse(&original)? != note {
        return Err("La nota cambió desde que se listó. Actualiza Reuniones antes de borrarla.".into());
    }
    let target = archive_path(&root, &note)?;
    if read(&target, LIMIT)?.is_some() {
        return Err("Ya existe una copia archivada con este identificador".into());
    }
    let marker = format!("<!-- esprit-meeting:{} -->", note.id);
    let state_link = checked_path(&root, &root.join("STATE.md")).is_ok()
        && read(&root.join("STATE.md"), LIMIT)
            .ok()
            .flatten()
            .is_some_and(|text| text.contains(&marker));
    plans.retain(|_, p| p.created.elapsed() < Duration::from_secs(600));
    if plans.len() >= 16 {
        return Err("Hay demasiadas revisiones pendientes; espera a que caduquen".into());
    }
    let plan_id = super::new_plan_id();
    let reply = Preview {
        plan_id: plan_id.clone(),
        destination: target
            .strip_prefix(&cfg.workspace)
            .unwrap_or(&target)
            .to_string_lossy()
            .into_owned(),
        before: original.clone(),
        after: String::new(),
        state_link,
    };
    plans.insert(
        plan_id,
        Plan {
            root,
            path,
            original: Some(original),
            content: String::new(),
            created: Instant::now(),
            archive_to: Some(target),
        },
    );
    Ok(reply)
}
fn note_path(root: &Path, note: &Note) -> Result<PathBuf, String> {
    super::validate_plan_id(&note.id)?;
    let path = root
        .join("docs/esprit")
        .join(folder(&note.kind)?)
        .join(format!("{}.md", note.id));
    checked_path(root, &path)?;
    Ok(path)
}
fn overview(cfg: &Resolved) -> Overview {
    let mut result = Overview {
        notes: vec![],
        warnings: vec![],
    };
    let mut total_bytes = 0;
    for project in cfg.projects().iter().map(|project| project.slug.as_str()) {
        let root = match super::verified_project_root(cfg, project) {
            Ok(root) => root,
            Err(_) => {
                result
                    .warnings
                    .push(format!("{project}: raíz no disponible"));
                continue;
            }
        };
        for kind in ["meeting", "reading", "waiting"] {
            let directory = root.join("docs/esprit").join(folder(kind).unwrap());
            if let Err(e) = checked_path(&root, &directory) {
                result.warnings.push(format!("{project}: {e}"));
                continue;
            }
            let entries = match fs::read_dir(&directory) {
                Ok(v) => v,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    result
                        .warnings
                        .push(format!("{project}: no se pudo leer {kind}"));
                    continue;
                }
            };
            let mut paths = vec![];
            for entry in entries.take(257) {
                if let Ok(entry) = entry {
                    paths.push(entry.path());
                }
            }
            if paths.len() > 256 {
                result.warnings.push(format!(
                    "{project}/{kind}: catálogo limitado a 256 entradas"
                ));
            }
            paths.sort_by_key(|path| {
                std::cmp::Reverse(fs::symlink_metadata(path).and_then(|m| m.modified()).ok())
            });
            paths.truncate(256);
            for path in paths {
                if result.notes.len() >= 512 || total_bytes >= 4 * 1024 * 1024 {
                    result.warnings.push("Catálogo de notas limitado a 512 notas o 4 MB. Las demás siguen en sus proyectos.".into());
                    return result;
                }
                if path.extension().and_then(|s| s.to_str()) != Some("md") {
                    continue;
                }
                match read(&path, LIMIT)
                    .and_then(|text| parse(&text.ok_or("Nota no disponible")?))
                    .and_then(|note| {
                        if note.project != project
                            || note.kind != kind
                            || note_path(&root, &note)? != path
                        {
                            return Err("Identidad de nota incoherente".into());
                        }
                        Ok(note)
                    }) {
                    Ok(note) => {
                        total_bytes += serde_json::to_vec(&note).map(|v| v.len()).unwrap_or(LIMIT);
                        result.notes.push(note);
                    }
                    Err(e) => result.warnings.push(format!(
                        "{project}/{}: {e}",
                        path.file_name().unwrap_or_default().to_string_lossy()
                    )),
                }
            }
        }
    }
    result
        .notes
        .sort_by(|a, b| b.date.cmp(&a.date).then(b.id.cmp(&a.id)));
    result
}
fn meetings_config() -> Result<std::sync::Arc<Resolved>, String> {
    let cfg = config::current()?;
    if !cfg.meetings_enabled() {
        return Err("Reuniones no está activado en la configuración".into());
    }
    Ok(cfg)
}

#[tauri::command]
pub async fn research_overview() -> Result<Overview, String> {
    let cfg = meetings_config()?;
    tauri::async_runtime::spawn_blocking(move || overview(&cfg))
        .await
        .map_err(|e| e.to_string())
}

fn add_state_section(before: &str, heading: &str, block: &str) -> Result<String, String> {
    let marker = format!("## {heading}\n");
    let starts: Vec<_> = before
        .match_indices(&marker)
        .filter(|(index, _)| *index == 0 || before.as_bytes()[index - 1] == b'\n')
        .collect();
    if starts.len() > 1 {
        return Err(format!(
            "Hay varias secciones {heading}; revisa el estado en Proyectos"
        ));
    }
    if let Some((start, _)) = starts.first() {
        let content_start = start + marker.len();
        let insertion = before[content_start..]
            .find("\n## ")
            .map(|index| content_start + index)
            .unwrap_or(before.len());
        Ok(format!(
            "{}\n\n{}\n{}",
            before[..insertion].trim_end(),
            block,
            &before[insertion..]
        ))
    } else {
        Ok(format!("{}\n\n{marker}\n{block}\n", before.trim_end()))
    }
}
fn meeting_state_proposal(before: &str, note: &Note, today: &str) -> Result<String, String> {
    let marker = format!("<!-- esprit-meeting:{} -->", note.id);
    if before.contains(&marker) {
        return Err(
            "Esta reunión ya está incorporada al estado. Revisa allí cualquier corrección.".into(),
        );
    }
    let mut result = before.to_string();
    let date = if note.date.is_empty() {
        "sin fecha registrada"
    } else {
        &note.date
    };
    let reference = format!(
        "[Reunión: {}](docs/esprit/meetings/{}.md) · {date}",
        note.title.replace('[', "\\[").replace(']', "\\]"),
        note.id
    );
    let mut included_marker = false;
    for (key, heading) in [
        ("actions", STATE_ACTIONS_HEADING),
        ("decisions", STATE_DECISIONS_HEADING),
    ] {
        let value = note
            .fields
            .get(key)
            .map(String::as_str)
            .unwrap_or("")
            .trim();
        if value.is_empty() {
            continue;
        }
        let body = value
            .lines()
            .map(|line| format!("    {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        let block = format!(
            "{}- {reference}\n\n{body}",
            if included_marker {
                String::new()
            } else {
                format!("{marker}\n")
            }
        );
        result = add_state_section(&result, heading, &block)?;
        included_marker = true;
    }
    if !included_marker {
        return Err("No hay acuerdos ni acciones registrados para el estado".into());
    }
    let metadata: Vec<_> = result
        .lines()
        .filter(|line| line.starts_with(STATE_UPDATED_PREFIX))
        .collect();
    if metadata.len() > 1 {
        return Err(
            "El estado contiene varias fechas de actualización; revísalo en Proyectos".into(),
        );
    }
    if let Some(line) = metadata.first() {
        result = result.replacen(*line, &format!("{STATE_UPDATED_PREFIX} {today}"), 1);
    } else {
        result = format!("{STATE_UPDATED_PREFIX} {today}\n\n{result}");
    }
    Ok(result)
}

fn prepare(
    cfg: &Resolved,
    mut note: Note,
    expected: Option<Note>,
    state_update: bool,
    plans: &mut HashMap<String, Plan>,
) -> Result<Preview, String> {
    validate(&note, false)?;
    let root = super::verified_project_root(cfg, &note.project)?;
    let is_new = note.id.is_empty();
    if is_new {
        note.id = super::new_plan_id();
    }
    let mut path = note_path(&root, &note)?;
    let mut original = read(&path, LIMIT)?;
    if !is_new {
        let current = parse(original.as_deref().ok_or("La nota ya no está disponible")?)?;
        if expected.as_ref() != Some(&current) {
            return Err("La nota cambió desde que la abriste. Conserva tu borrador y recarga antes de revisar.".into());
        }
    } else if original.is_some() {
        return Err("Ya existe una nota en el destino".into());
    }
    let content = if state_update {
        if is_new || note.kind != "meeting" {
            return Err("Guarda primero los acuerdos de una reunión".into());
        }
        let current = parse(original.as_deref().ok_or("Reunión no disponible")?)?;
        if current != note {
            return Err("Guarda los cambios de la reunión antes de preparar el estado".into());
        }
        let decisions = note
            .fields
            .get("decisions")
            .map(String::as_str)
            .unwrap_or("")
            .trim();
        let actions = note
            .fields
            .get("actions")
            .map(String::as_str)
            .unwrap_or("")
            .trim();
        if decisions.is_empty() && actions.is_empty() {
            return Err("Registra al menos un acuerdo o una próxima acción".into());
        }
        path = root.join("STATE.md");
        checked_path(&root, &path)?;
        original = read(&path, LIMIT)?;
        let before = original.as_deref().ok_or(
            "Este proyecto no tiene STATE.md; abre Proyectos para elegir su documento de estado",
        )?;
        let today = super::current_local_minute(cfg.time_zone())?;
        meeting_state_proposal(before, &note, &today[..10])?
    } else {
        render(&note)?
    };
    if content.len() > LIMIT {
        return Err("La propuesta supera 96 KB".into());
    }
    plans.retain(|_, p| p.created.elapsed() < Duration::from_secs(600));
    if plans.len() >= 16 {
        return Err("Hay demasiadas revisiones pendientes; espera a que caduquen".into());
    }
    let plan_id = super::new_plan_id();
    let reply = Preview {
        plan_id: plan_id.clone(),
        destination: path
            .strip_prefix(&cfg.workspace)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned(),
        before: original.clone().unwrap_or_default(),
        after: content.clone(),
        state_link: false,
    };
    plans.insert(
        plan_id,
        Plan {
            root,
            path,
            original,
            content,
            created: Instant::now(),
            archive_to: None,
        },
    );
    Ok(reply)
}
#[tauri::command]
pub async fn research_prepare(
    note: Note,
    expected: Option<Note>,
    state_update: bool,
    store: State<'_, ResearchStore>,
) -> Result<Preview, String> {
    let cfg = meetings_config()?;
    let store = Arc::clone(&store.0);
    tauri::async_runtime::spawn_blocking(move || {
        prepare(
            &cfg,
            note,
            expected,
            state_update,
            &mut *store
                .lock()
                .map_err(|_| "No se pudo preparar la revisión")?,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Prepares moving a saved note to the project's archive; `research_apply`
/// performs it only after the reviewed confirmation.
#[tauri::command]
pub async fn research_prepare_archive(
    note: Note,
    store: State<'_, ResearchStore>,
) -> Result<Preview, String> {
    let cfg = meetings_config()?;
    let store = Arc::clone(&store.0);
    tauri::async_runtime::spawn_blocking(move || {
        prepare_archive(
            &cfg,
            note,
            &mut *store
                .lock()
                .map_err(|_| "No se pudo preparar la revisión")?,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn research_apply(
    plan_id: String,
    confirmed: bool,
    store: State<'_, ResearchStore>,
) -> Result<Overview, String> {
    if !confirmed {
        return Err("La escritura requiere confirmación final después de la revisión".into());
    }
    let cfg = meetings_config()?;
    let store = Arc::clone(&store.0);
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = store
            .lock()
            .map_err(|_| "No se pudo recuperar la revisión")?;
        let plan = guard
            .get(&plan_id)
            .ok_or("La revisión ya no está disponible")?;
        if plan.created.elapsed() >= Duration::from_secs(600) {
            return Err("La revisión caducó. Prepara otra.".into());
        }
        if plan.archive_to.is_some() {
            archive(plan)?;
        } else {
            publish(plan)?;
        }
        guard.remove(&plan_id);
        Ok(overview(&cfg))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn research_cancel(plan_id: String, store: State<'_, ResearchStore>) -> Result<(), String> {
    store
        .0
        .lock()
        .map_err(|_| "No se pudo cerrar la revisión")?
        .remove(&plan_id);
    Ok(())
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Drafts {
    pub revision: u64,
    pub notes: BTreeMap<String, Note>,
    pub bases: BTreeMap<String, Option<Note>>,
}
fn draft_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("research-drafts.json"))
}
fn load_drafts(path: &Path) -> Result<Drafts, String> {
    let drafts = match read(path, 2 * 1024 * 1024)? {
        Some(text) => serde_json::from_str(&text)
            .map_err(|_| "No se pudieron leer los borradores; se conserva el archivo original")?,
        None => Drafts::default(),
    };
    validate_drafts(&drafts)?;
    Ok(drafts)
}
fn validate_drafts(drafts: &Drafts) -> Result<(), String> {
    if drafts.notes.len() > 48 {
        return Err("Hay más de 48 borradores; guarda algunas notas antes de crear más".into());
    }
    if drafts.bases.len() != drafts.notes.len() {
        return Err("Falta la versión original de un borrador".into());
    }
    for (id, note) in &drafts.notes {
        super::validate_plan_id(id)?;
        validate(note, true)?;
        let base = drafts
            .bases
            .get(id)
            .ok_or("Falta la versión original del borrador")?;
        if let Some(base) = base {
            validate(base, false)?;
            if base.id != note.id || base.project != note.project || base.kind != note.kind {
                return Err("Identidad del borrador incoherente".into());
            }
        } else if !note.id.is_empty() {
            return Err("No se conoce la versión original de la nota".into());
        }
    }
    if serde_json::to_vec(drafts).map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024 {
        return Err("Los borradores superan 2 MB".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn research_load_drafts(
    app: AppHandle,
    lock: State<'_, DraftLock>,
) -> Result<Drafts, String> {
    let path = draft_path(&app)?;
    let lock = Arc::clone(&lock.0);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| "Borradores ocupados")?;
        load_drafts(&path)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn research_save_drafts(
    app: AppHandle,
    drafts: Drafts,
    lock: State<'_, DraftLock>,
) -> Result<u64, String> {
    let path = draft_path(&app)?;
    let lock = Arc::clone(&lock.0);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| "Borradores ocupados")?;
        validate_drafts(&drafts)?; let current = load_drafts(&path)?;
        if current.revision != drafts.revision { return Err("Los borradores cambiaron en otra ventana. No se han sobrescrito; conserva una copia de tus notas.".into()); }
        let next = Drafts { revision: current.revision.checked_add(1).ok_or("Revisión no válida")?, notes: drafts.notes, bases: drafts.bases };
        let root = path.parent().ok_or("Destino de borradores no válido")?.to_path_buf();
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        // The same exact-content guard, with a larger bound for the draft set.
        let original = read(&path, 2 * 1024 * 1024)?;
        let temp = root.join(format!(".research-drafts-{}.tmp", super::new_plan_id()));
        let result = (|| {
            let mut options = OpenOptions::new(); options.write(true).create_new(true);
            #[cfg(unix)] options.mode(0o600);
            let mut file = options.open(&temp).map_err(|e| e.to_string())?;
            file.write_all(&serde_json::to_vec(&next).map_err(|e| e.to_string())?).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
            if read(&path, 2 * 1024 * 1024)? != original { return Err("El archivo de borradores cambió durante el guardado".into()); }
            fs::rename(&temp, &path).map_err(|e| e.to_string())?; Ok(next.revision)
        })();
        if result.is_err() { let _ = fs::remove_file(temp); } result
    }).await.map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct IndexPaper {
    name: String,
    folder: String,
}
#[tauri::command]
pub async fn research_library_index() -> Result<Vec<IndexPaper>, String> {
    let cfg = config::current()?;
    tauri::async_runtime::spawn_blocking(move || {
        // An isolated catalogue avoids invalidating a PDF already open in Library.
        let catalog = super::build_library_overview(&cfg, Arc::new(Mutex::new(HashMap::new())))?;
        Ok(catalog
            .papers
            .into_iter()
            .map(|paper| IndexPaper {
                name: paper.name,
                folder: paper.folder,
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct DraftExport {
    saved: bool,
    filename: Option<String>,
}
#[tauri::command]
pub async fn research_export_drafts(drafts: Drafts) -> Result<DraftExport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_drafts(&drafts)?;
        let script = "var app = Application.currentApplication(); app.includeStandardAdditions = true; app.chooseFileName({withPrompt: 'Exportar borradores de investigación', defaultName: 'esprit-borradores-investigacion.json'}).toString();";
        let output = std::process::Command::new("/usr/bin/osascript").args(["-l", "JavaScript", "-e", script]).stdin(std::process::Stdio::null()).output().map_err(|_| "No se pudo abrir el diálogo de exportación")?;
        if !output.status.success() {
            if String::from_utf8_lossy(&output.stderr).contains("-128") { return Ok(DraftExport { saved: false, filename: None }); }
            return Err("No se pudo seleccionar el destino de exportación".into());
        }
        let target = PathBuf::from(String::from_utf8(output.stdout).map_err(|_| "Destino no válido")?.trim());
        if !target.is_absolute() || target.extension().and_then(|v| v.to_str()) != Some("json") { return Err("Elige un archivo nuevo terminado en .json".into()); }
        let mut options = OpenOptions::new(); options.write(true).create_new(true);
        #[cfg(unix)] options.mode(0o600);
        let mut file = options.open(&target).map_err(|_| "No se pudo crear la copia. Elige un nombre nuevo para conservar los archivos existentes.")?;
        let result = file.write_all(&serde_json::to_vec_pretty(&drafts).map_err(|e| e.to_string())?).and_then(|_| file.sync_all());
        if result.is_err() { drop(file); let _ = fs::remove_file(&target); return Err("No se pudo completar la copia".into()); }
        Ok(DraftExport { saved: true, filename: target.file_name().and_then(|v| v.to_str()).map(str::to_string) })
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(kind: &str) -> Note {
        Note {
            id: "ab12-cd34".into(),
            kind: kind.into(),
            project: "tesis".into(),
            title: "Pregunta científica".into(),
            date: "2026-09-07".into(),
            fields: fields(kind)
                .unwrap()
                .iter()
                .map(|(key, _)| {
                    (
                        key.to_string(),
                        format!("Contenido {key}\n\n## Subtítulo\n$\\alpha$"),
                    )
                })
                .collect(),
        }
    }
    fn scratch() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "esprit-research-test-{}",
            super::super::new_plan_id()
        ));
        fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn markdown_round_trips_every_field_without_duplicate_hidden_content() {
        for kind in ["meeting", "reading", "waiting"] {
            let note = fixture(kind);
            let text = render(&note).unwrap();
            assert_eq!(parse(&text).unwrap(), note);
            assert_eq!(
                text.matches("Contenido agenda").count(),
                usize::from(kind == "meeting")
            );
        }
    }
    #[test]
    fn manual_edits_outside_blocks_and_reserved_markers_are_never_silently_lost() {
        let mut note = fixture("meeting");
        let text = render(&note).unwrap();
        assert!(parse(&format!("{text}\nManual note outside fields")).is_err());
        assert!(parse(&text.replace("## Acuerdos", "## Changed")).is_err());
        note.fields
            .insert("notes".into(), "<!-- esprit-end -->".into());
        assert!(render(&note).is_err());
        note = fixture("reading");
        note.fields.insert("command".into(), "not allowed".into());
        assert!(validate(&note, false).is_err());
        note = fixture("reading");
        note.id = "../../outside".into();
        assert!(render(&note).is_err());
    }
    #[test]
    fn reviewed_publication_is_exclusive_and_checks_original_bytes() {
        let root = scratch();
        let path = root.join("docs/esprit/meetings/ab12.md");
        let mut plan = Plan {
            root: root.clone(),
            path: path.clone(),
            original: None,
            content: "First note".into(),
            created: Instant::now(),
            archive_to: None,
        };
        publish(&plan).unwrap();
        assert!(publish(&plan).is_err());
        plan.original = Some("First note".into());
        plan.content = "Reviewed change".into();
        fs::write(&path, "External change").unwrap();
        assert!(publish(&plan).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "External change");
        plan.original = Some("External change".into());
        publish(&plan).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "Reviewed change");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn state_proposal_updates_known_sections_without_rewriting_existing_content() {
        let note = fixture("meeting");
        let before = "# Estado del proyecto\n> Última actualización: 2026-08-01\n\n## Próximas acciones\n\n- Acción existente\n\n## Referencias\n\nReferencias originales\n";
        let proposal = meeting_state_proposal(before, &note, "2026-09-07").unwrap();
        assert!(proposal.contains("> Última actualización: 2026-09-07"));
        assert!(proposal.contains("- Acción existente"));
        assert!(proposal.contains("Referencias originales"));
        assert!(
            proposal.find("Contenido actions").unwrap() < proposal.find("## Referencias").unwrap()
        );
        assert!(proposal.contains("## Decisiones recientes"));
        assert!(proposal.contains("Contenido decisions"));
        assert_eq!(proposal.matches("<!-- esprit-meeting:").count(), 1);
        assert!(meeting_state_proposal(&proposal, &note, "2026-09-08").is_err());
        let mut empty = note;
        empty.fields.clear();
        assert!(meeting_state_proposal(before, &empty, "2026-09-07").is_err());
    }
    #[test]
    fn draft_text_can_be_recovered_even_when_it_cannot_yet_be_published() {
        let mut note = fixture("meeting");
        note.fields.insert("notes".into(), "A pasted example: <!-- esprit-end -->".into());
        assert!(validate(&note, true).is_ok());
        assert!(render(&note).is_err());
        note.date = "2026-02-29".into(); assert!(validate(&note, true).is_err());
        note.date = "2028-02-29".into(); assert!(validate(&note, true).is_ok());
    }
    #[test]
    fn draft_recovery_preserves_the_original_revision_for_later_review() {
        let base = fixture("meeting");
        let mut edited = base.clone();
        edited
            .fields
            .insert("notes".into(), "Unsaved final keystroke x".into());
        let drafts = Drafts {
            revision: 7,
            notes: BTreeMap::from([("aa-bb".into(), edited.clone())]),
            bases: BTreeMap::from([("aa-bb".into(), Some(base.clone()))]),
        };
        let root = scratch();
        let path = root.join("drafts.json");
        fs::write(&path, serde_json::to_vec(&drafts).unwrap()).unwrap();
        let recovered = load_drafts(&path).unwrap();
        assert_eq!(recovered.revision, 7);
        assert_eq!(recovered.notes["aa-bb"], edited);
        assert_eq!(recovered.bases["aa-bb"], Some(base));
        let mut corrupt = recovered;
        corrupt.bases.clear();
        assert!(validate_drafts(&corrupt).is_err());
        fs::write(&path, b"{broken").unwrap();
        assert!(load_drafts(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{broken");
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn archiving_moves_the_reviewed_note_without_overwriting_or_losing_it() {
        let root = scratch();
        let path = root.join("docs/esprit/meetings/ab12.md");
        let target = root.join("docs/esprit/archive/meetings/ab12.md");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "Reviewed meeting").unwrap();
        let mut plan = Plan {
            root: root.clone(),
            path: path.clone(),
            original: Some("Reviewed meeting".into()),
            content: String::new(),
            created: Instant::now(),
            archive_to: Some(target.clone()),
        };
        fs::write(&path, "Edited elsewhere").unwrap();
        assert!(archive(&plan).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "Edited elsewhere");
        assert!(!target.exists());
        plan.original = Some("Edited elsewhere".into());
        archive(&plan).unwrap();
        assert!(!path.exists());
        assert_eq!(fs::read_to_string(&target).unwrap(), "Edited elsewhere");
        fs::write(&path, "Edited elsewhere").unwrap();
        assert!(archive(&plan).is_err(), "an existing archived copy is never replaced");
        assert_eq!(fs::read_to_string(&path).unwrap(), "Edited elsewhere");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn symlink_parents_and_replaced_files_are_rejected() {
        use std::os::unix::fs::symlink;
        let root = scratch();
        let outside = scratch();
        symlink(&outside, root.join("docs")).unwrap();
        let mut plan = Plan {
            root: root.clone(),
            path: root.join("docs/esprit/note.md"),
            original: None,
            content: "No escape".into(),
            created: Instant::now(),
            archive_to: None,
        };
        assert!(publish(&plan).is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        let target = outside.join("original.md");
        fs::write(&target, "Original").unwrap();
        symlink(&target, root.join("note.md")).unwrap();
        plan.path = root.join("note.md");
        plan.original = Some("Original".into());
        assert!(publish(&plan).is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "Original");
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
