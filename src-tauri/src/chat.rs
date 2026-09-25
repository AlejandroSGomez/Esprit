//! Local conversations and bounded CLI event projection. Raw CLI events, tool
//! arguments/results, stderr and thread identifiers never cross the native bridge.
use super::{
    checked_engine, checked_project, config, configure_codex_profile, engine_binary, epoch_millis,
    ChatEngine, CodexProfile,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(unix)]
use std::os::unix::{fs::OpenOptionsExt, process::CommandExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
const DEEP_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max", "ultra"];
const MAX_CONVERSATIONS: usize = 200;
const MAX_STORE_BYTES: u64 = 1_000_000;
const MAX_LINE_BYTES: usize = 1_048_576;
const MAX_STREAM_BYTES: usize = 16 * 1_048_576;
const MAX_TEXT_BYTES: usize = 240_000;
const RUN_TIMEOUT: Duration = Duration::from_secs(1800);

#[derive(Clone, Serialize)]
pub struct Model {
    value: &'static str,
    label: &'static str,
    note: &'static str,
    efforts: &'static [&'static str],
    default_effort: &'static str,
}
// One reviewed catalogue drives both native validation and the frontend picker.
// Codex capabilities verified against the installed CLI catalogue on 2026-09-22
// (codex-cli 0.155): Astra and Sol reach Ultra, Luna stops at Max.
const CODEX_MODELS: &[Model] = &[
    Model {
        value: "gpt-6-astra",
        label: "Astra",
        note: "GPT-6 · máxima capacidad",
        efforts: DEEP_EFFORTS,
        default_effort: "medium",
    },
    Model {
        value: "gpt-6-sol",
        label: "Sol",
        note: "GPT-6 · equilibrado",
        efforts: DEEP_EFFORTS,
        default_effort: "medium",
    },
    Model {
        value: "gpt-6-luna",
        label: "Luna",
        note: "GPT-6 · rápido y ligero",
        efforts: EFFORTS,
        default_effort: "medium",
    },
];
/// Retired Codex models and their successor. Stored conversations and
/// preferences that still name one keep working instead of failing validation;
/// no retired model is ever dispatched. Every successor accepts the same efforts.
const RETIRED_CODEX_MODELS: &[(&str, &str)] = &[
    ("gpt-5.6-luna", "gpt-6-luna"),
    ("gpt-5.6-terra", "gpt-6-sol"),
    ("gpt-5.6-sol", "gpt-6-sol"),
];
const CLAUDE_MODELS: &[Model] = &[
    Model {
        value: "haiku",
        label: "Haiku",
        note: "Rápido y ligero",
        efforts: EFFORTS,
        default_effort: "medium",
    },
    Model {
        value: "sonnet",
        label: "Sonnet",
        note: "Equilibrado",
        efforts: EFFORTS,
        default_effort: "medium",
    },
    Model {
        value: "opus",
        label: "Opus 5.5",
        note: "Mayor profundidad",
        efforts: EFFORTS,
        default_effort: "medium",
    },
    Model {
        value: "fable",
        label: "Fable",
        note: "Alternativa de Claude",
        efforts: EFFORTS,
        default_effort: "medium",
    },
];
const MAX_SKILLS: usize = 24;
const MAX_SKILL_FRONTMATTER_BYTES: u64 = 16 * 1024;

/// Nombre de skill permitido: `^[a-z0-9-]{1,48}$`.
fn valid_skill_name(name: &str) -> bool {
    (1..=48).contains(&name.len())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// Descripción del frontmatter YAML (`description: …`) de un SKILL.md, acotada.
fn skill_description(text: &str) -> Option<String> {
    let mut lines = text.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines {
        let line = line.trim_end();
        if line.trim() == "---" {
            break;
        }
        if let Some(value) = line.strip_prefix("description:") {
            let value = value.trim().trim_matches(|character| character == '"' || character == '\'');
            let clean: String = value
                .chars()
                .filter(|character| !character.is_control())
                .take(300)
                .collect();
            return (!clean.trim().is_empty()).then(|| clean.trim().to_string());
        }
    }
    None
}

/// Skills del selector: `<workspace>/.claude/skills/<nombre>/SKILL.md`.
fn discover_skills(workspace: &Path) -> Vec<Value> {
    let root = workspace.join(".claude/skills");
    let Ok(metadata) = fs::symlink_metadata(&root) else {
        return Vec::new();
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .filter(|name| valid_skill_name(name))
        .collect();
    names.sort();
    let mut skills = Vec::new();
    for name in names {
        if skills.len() >= MAX_SKILLS {
            break;
        }
        let directory = root.join(&name);
        let skill = directory.join("SKILL.md");
        let valid = fs::symlink_metadata(&directory)
            .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
            && fs::symlink_metadata(&skill)
                .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink());
        if !valid {
            continue;
        }
        let mut text = String::new();
        let description = fs::File::open(&skill)
            .and_then(|file| {
                file.take(MAX_SKILL_FRONTMATTER_BYTES).read_to_string(&mut text)
            })
            .ok()
            .and_then(|_| skill_description(&text))
            .unwrap_or_default();
        skills.push(json!({"name": name, "label": name, "description": description}));
    }
    skills
}

/// Etiqueta visible de una skill leída con `cat …/.claude/skills/<n>/SKILL.md`.
/// Solo sale el nombre validado; nunca la orden ni la ruta.
fn skill_from_command(command: &str) -> Option<String> {
    let rest = command.strip_prefix("cat ")?.trim().trim_matches(|character| character == '\'' || character == '"');
    let before = rest.strip_suffix("/SKILL.md")?;
    let (prefix, name) = before.rsplit_once('/')?;
    (prefix.ends_with("/.claude/skills") && valid_skill_name(name)).then(|| name.to_string())
}

pub(super) fn profile(
    engine: ChatEngine,
    model: &str,
    effort: &str,
) -> std::result::Result<CodexProfile, String> {
    let (models, model) = if engine == ChatEngine::Codex {
        let current = RETIRED_CODEX_MODELS
            .iter()
            .find(|(retired, _)| *retired == model)
            .map_or(model, |(_, successor)| *successor);
        (CODEX_MODELS, current)
    } else {
        (CLAUDE_MODELS, model)
    };
    let model = models
        .iter()
        .find(|item| item.value == model)
        .ok_or("El modelo no está permitido en Esprit")?;
    let effort = model
        .efforts
        .iter()
        .copied()
        .find(|value| *value == effort)
        .ok_or("Ese razonamiento no está disponible para el modelo seleccionado")?;
    Ok(CodexProfile {
        model: model.value,
        effort,
    })
}

/// Every Codex model is a `gpt-` slug and no Claude one is, the same rule the
/// frontend history validator applies.
pub(super) fn engine_for_model(model: &str) -> ChatEngine {
    if model.starts_with("gpt-") {
        ChatEngine::Codex
    } else {
        ChatEngine::Claude
    }
}

/// The catalogue keeps the stable `opus` identifier that stored preferences and
/// history use, but the CLI receives a pinned id: the bare alias follows
/// whatever the installed Claude Code considers the latest Opus.
pub(super) fn claude_cli_model(model: &str) -> &str {
    match model {
        "opus" => "claude-opus-5-5",
        other => other,
    }
}

fn catalog_for(cfg: Option<&config::Resolved>) -> Value {
    let mut engines = Vec::new();
    let claude = cfg.is_some_and(|cfg| cfg.config.tools.claude.is_some());
    let codex = cfg.is_some_and(|cfg| cfg.config.tools.codex.is_some());
    if claude {
        engines.push(json!({"value":"claude","label":"Claude","models":CLAUDE_MODELS}));
    }
    if codex {
        engines.push(json!({"value":"codex","label":"Codex","models":CODEX_MODELS}));
    }
    let skills = cfg.map(|cfg| discover_skills(&cfg.workspace)).unwrap_or_default();
    let default_engine = if claude { Some("claude") } else if codex { Some("codex") } else { None };
    json!({"engines": engines, "skills": skills, "default_engine": default_engine})
}

/// Catálogo de motores (Claude siempre que `tools.claude` esté configurado;
/// Codex solo si `tools.codex` lo está) y skills del workspace.
#[tauri::command]
pub fn chat_catalog() -> Value {
    let cfg = config::current().ok();
    catalog_for(cfg.as_deref())
}

#[derive(Clone, Debug, Serialize)]
pub struct ChatError {
    pub code: &'static str,
    pub message: String,
}
impl ChatError {
    pub(super) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
type Result<T> = std::result::Result<T, ChatError>;
fn storage_error() -> ChatError {
    ChatError::new(
        "STORAGE_ERROR",
        "No se pudo leer o guardar el historial nativo. Se conserva el archivo anterior.",
    )
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Conversation {
    pub id: String,
    pub engine: String,
    pub context: String,
    pub model: String,
    pub effort: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub status: String,
    pub legacy_key: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
struct Record {
    #[serde(flatten)]
    public: Conversation,
    thread_id: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
struct Store {
    version: u32,
    conversations: Vec<Record>,
    #[serde(default)]
    warnings: Vec<String>,
}
impl Default for Store {
    fn default() -> Self {
        Self {
            version: 2,
            conversations: vec![],
            warnings: vec![],
        }
    }
}
#[derive(Default)]
pub struct ChatStore(Mutex<Option<Store>>);
#[derive(Clone, Serialize)]
pub struct Overview {
    version: u32,
    conversations: Vec<Conversation>,
    warnings: Vec<String>,
}

fn random_id() -> Result<String> {
    let mut bytes = [0u8; 16];
    fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|_| storage_error())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
/// Contexto guardado: `general` o un slug con el formato de proyecto. La
/// carpeta real solo se resuelve (y se autoriza) al consultar, desde la
/// configuración; así un proyecto retirado no invalida el historial.
pub(super) fn context_allowed(context: &str) -> bool {
    context == "general" || config::valid_slug(context)
}
fn valid_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn store_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| storage_error())?
        .join("chat-conversations.json"))
}
fn read_bounded(path: &Path) -> Result<Option<Vec<u8>>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(storage_error()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_STORE_BYTES
    {
        return Err(storage_error());
    }
    let mut content = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(MAX_STORE_BYTES + 1).read_to_end(&mut content))
        .map_err(|_| storage_error())?;
    if content.len() as u64 > MAX_STORE_BYTES {
        return Err(storage_error());
    }
    Ok(Some(content))
}
fn write_store(path: &Path, store: &Store) -> Result<()> {
    let parent = path.parent().ok_or_else(storage_error)?;
    fs::create_dir_all(parent).map_err(|_| storage_error())?;
    let temp = parent.join(format!(".chat-conversations-{}.tmp", random_id()?));
    let bytes = serde_json::to_vec(store).map_err(|_| storage_error())?;
    if bytes.len() as u64 > MAX_STORE_BYTES {
        return Err(storage_error());
    }
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let result = (|| {
        let mut file = options.open(&temp).map_err(|_| storage_error())?;
        file.write_all(&bytes).map_err(|_| storage_error())?;
        file.sync_all().map_err(|_| storage_error())?;
        fs::rename(&temp, path).map_err(|_| storage_error())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
fn validated_store(bytes: &[u8]) -> Result<Store> {
    let store: Store = serde_json::from_slice(bytes).map_err(|_| storage_error())?;
    if store.version != 2 || store.conversations.len() > MAX_CONVERSATIONS {
        return Err(storage_error());
    }
    let mut ids = HashSet::new();
    for record in &store.conversations {
        let item = &record.public;
        let engine = checked_engine(Some(&item.engine)).map_err(|_| storage_error())?;
        if !valid_id(&item.id)
            || !ids.insert(&item.id)
            || !context_allowed(&item.context)
            || profile(engine, &item.model, &item.effort).is_err()
            || !["new", "ready", "expired"].contains(&item.status.as_str())
            || record.thread_id.as_deref().is_some_and(|id| !valid_id(id))
            || (item.status == "ready" && record.thread_id.is_none())
            || (item.status == "new" && record.thread_id.is_some())
        {
            return Err(storage_error());
        }
    }
    let mut store = store;
    // A retired model is shown and resumed as its successor; the file itself
    // is only rewritten by the next ordinary save.
    for record in &mut store.conversations {
        let engine = checked_engine(Some(&record.public.engine)).map_err(|_| storage_error())?;
        let current = profile(engine, &record.public.model, &record.public.effort).map_err(|_| storage_error())?;
        record.public.model = current.model.into();
    }
    Ok(store)
}
fn migrate_legacy(bytes: &[u8]) -> Result<Store> {
    #[derive(Deserialize)]
    struct LegacyRecord {
        id: String,
        updated: u64,
    }
    #[derive(Deserialize)]
    struct Legacy {
        version: u32,
        sessions: HashMap<String, LegacyRecord>,
    }
    let legacy: Legacy = serde_json::from_slice(bytes).map_err(|_| storage_error())?;
    if legacy.version != 1 || legacy.sessions.len() > MAX_CONVERSATIONS {
        return Err(storage_error());
    }
    let mut store = Store::default();
    let mut skipped = 0;
    let mut entries: Vec<_> = legacy.sessions.into_iter().collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    for (key, record) in entries {
        let pieces: Vec<_> = key.split("::").collect();
        if pieces.len() != 4 || !context_allowed(pieces[1]) || !valid_id(&record.id) {
            skipped += 1;
            continue;
        }
        let Ok(engine) = checked_engine(Some(pieces[0])) else {
            skipped += 1;
            continue;
        };
        let Ok(current) = profile(engine, pieces[2], pieces[3]) else {
            skipped += 1;
            continue;
        };
        store.conversations.push(Record {
            public: Conversation {
                id: random_id()?,
                engine: pieces[0].into(),
                context: pieces[1].into(),
                model: current.model.into(),
                effort: pieces[3].into(),
                created_at: record.updated,
                updated_at: record.updated,
                status: "ready".into(),
                legacy_key: Some(key),
            },
            thread_id: Some(record.id),
        });
    }
    if skipped > 0 {
        store.warnings.push(format!("{skipped} sesiones anteriores no tenían un perfil válido; se conserva su archivo original."));
    }
    Ok(store)
}
fn ensure_loaded<'a>(slot: &'a mut Option<Store>, path: &Path) -> Result<&'a mut Store> {
    if slot.is_none() {
        let store = if let Some(bytes) = read_bounded(path)? {
            validated_store(&bytes)?
        } else {
            let legacy_path = path.with_file_name("chat-sessions.json");
            let migrated = if let Some(bytes) = read_bounded(&legacy_path)? {
                migrate_legacy(&bytes)?
            } else {
                Store::default()
            };
            // Publish first; never give the frontend unstable migration IDs.
            write_store(path, &migrated)?;
            migrated
        };
        *slot = Some(store);
    }
    slot.as_mut().ok_or_else(storage_error)
}
#[tauri::command]
pub fn chat_conversations(app: AppHandle, state: State<'_, ChatStore>) -> Result<Overview> {
    let path = store_path(&app)?;
    let mut slot = state.0.lock().map_err(|_| storage_error())?;
    let store = ensure_loaded(&mut slot, &path)?;
    Ok(Overview {
        version: 2,
        conversations: store
            .conversations
            .iter()
            .map(|r| r.public.clone())
            .collect(),
        warnings: store.warnings.clone(),
    })
}
#[tauri::command]
pub fn chat_create_conversation(
    app: AppHandle,
    engine: String,
    project: Option<String>,
    model: String,
    effort: String,
    state: State<'_, ChatStore>,
) -> Result<Conversation> {
    let engine = checked_engine(Some(&engine)).map_err(|m| ChatError::new("INVALID_PROFILE", m))?;
    let checked =
        profile(engine, &model, &effort).map_err(|m| ChatError::new("INVALID_PROFILE", m))?;
    let cfg = config::current().map_err(|m| ChatError::new("CONFIG_REQUIRED", m))?;
    engine_binary(&cfg, engine).map_err(|m| ChatError::new("ENGINE_UNAVAILABLE", m))?;
    checked_project(&cfg, project.as_deref()).map_err(|m| ChatError::new("INVALID_CONTEXT", m))?;
    let path = store_path(&app)?;
    let mut slot = state.0.lock().map_err(|_| storage_error())?;
    let store = ensure_loaded(&mut slot, &path)?;
    if store.conversations.len() >= MAX_CONVERSATIONS {
        return Err(ChatError::new(
            "HISTORY_FULL",
            "Se ha alcanzado el límite de 200 conversaciones locales; el historial se conserva.",
        ));
    }
    let item = Conversation {
        id: random_id()?,
        engine: engine.as_str().into(),
        context: project.unwrap_or_else(|| "general".into()),
        model: checked.model.into(),
        effort: checked.effort.into(),
        created_at: epoch_millis(),
        updated_at: epoch_millis(),
        status: "new".into(),
        legacy_key: None,
    };
    let mut updated = store.clone();
    updated.conversations.push(Record {
        public: item.clone(),
        thread_id: None,
    });
    write_store(&path, &updated)?;
    *store = updated;
    Ok(item)
}

#[derive(Default)]
struct RunControl {
    cancelled: AtomicBool,
    pid: AtomicI32,
}
struct ActiveRun {
    conversation_id: String,
    control: Arc<RunControl>,
}
#[derive(Default)]
pub struct ChatRuns(Mutex<HashMap<String, ActiveRun>>, Mutex<HashSet<String>>);
struct RunLease<'a>(&'a ChatRuns, String);
impl Drop for RunLease<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0 .0.lock() {
            active.remove(&self.1);
        }
    }
}
struct OwnedChild {
    child: std::process::Child,
    control: Arc<RunControl>,
}
impl std::ops::Deref for OwnedChild {
    type Target = std::process::Child;
    fn deref(&self) -> &Self::Target {
        &self.child
    }
}
impl std::ops::DerefMut for OwnedChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.child
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let pid = self.control.pid.swap(0, Ordering::SeqCst);
        if pid > 0 {
            signal_group(pid, libc::SIGKILL);
            let _ = self.child.wait();
        }
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct RunEvent {
    run_id: String,
    conversation_id: String,
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
}
fn event(run: &str, conversation: &str, kind: &'static str, state: &'static str) -> RunEvent {
    RunEvent {
        run_id: run.into(),
        conversation_id: conversation.into(),
        kind,
        text: None,
        label: None,
        state: Some(state),
        item_id: None,
        code: None,
    }
}
fn signal_group(pid: i32, signal: i32) {
    if pid > 0 {
        unsafe {
            libc::kill(-pid, signal);
        }
    }
}
#[tauri::command]
pub fn chat_cancel_run(run_id: String, runs: State<'_, ChatRuns>) -> Result<bool> {
    if !valid_id(&run_id) {
        return Err(ChatError::new(
            "INVALID_REQUEST",
            "Identificador de consulta no válido.",
        ));
    }
    let active = runs
        .0
        .lock()
        .map_err(|_| ChatError::new("RUN_FAILED", "No se pudo acceder a la consulta activa."))?;
    if let Some(run) = active.get(&run_id) {
        run.control.cancelled.store(true, Ordering::SeqCst);
        signal_group(run.control.pid.load(Ordering::SeqCst), libc::SIGTERM);
        Ok(true)
    } else {
        // Cancellation can arrive while the async ask command is still queued.
        let mut pending = runs.1.lock().map_err(|_| storage_error())?;
        if pending.len() >= 64 {
            pending.clear();
        }
        pending.insert(run_id);
        Ok(false)
    }
}

fn safe_text(text: &str) -> String {
    // No raw tool payload reaches this function. Redact complete recognizable
    // credential blocks in assistant prose, including all private-key lines.
    let mut private_block = false;
    text.lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if lower.contains("-----begin") {
                private_block = true;
            }
            if private_block {
                if lower.contains("-----end") {
                    private_block = false;
                }
                return "[Contenido sensible omitido]".into();
            }
            if [
                "authorization:",
                "bearer ",
                "api_key",
                "api key",
                "access_token",
                "refresh_token",
                "password=",
                "password:",
                "secret_key",
                " sk-",
                "=sk-",
                "\"sk-",
                "`sk-",
                "ghp_",
                "gho_",
                "github_pat_",
                "xoxb-",
                "xoxp-",
            ]
            .iter()
            .any(|needle| lower.contains(needle))
                || lower.starts_with("sk-")
            {
                "[Contenido sensible omitido]".into()
            } else {
                line.chars()
                    .filter(|c| !c.is_control() || *c == '\t')
                    .collect::<String>()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn classified_error(text: &str, resumed: bool) -> ChatError {
    let lower = text.to_ascii_lowercase();
    if resumed
        && [
            "session not found",
            "thread not found",
            "no session found",
            "could not find session",
            "failed to find rollout",
            "session does not exist",
            "thread does not exist",
            "conversation not found",
            "session expired",
        ]
        .iter()
        .any(|s| lower.contains(s))
        && !lower.contains("oauth")
        && !lower.contains("auth")
    {
        ChatError::new("SESSION_EXPIRED", "El CLI ya no encuentra esta conversación. Su historial se conserva; crea un chat nuevo para continuar.")
    } else if [
        "unauthorized",
        "authenticate",
        "authentication",
        "oauth",
        "401",
    ]
    .iter()
    .any(|s| lower.contains(s))
    {
        ChatError::new(
            "AUTH_REQUIRED",
            "El motor necesita revisar su autenticación en su aplicación. Este hilo se conserva.",
        )
    } else if ["rate limit", "usage limit", "session limit", "weekly limit", "429", "quota"]
        .iter()
        .any(|s| lower.contains(s))
    {
        ChatError::new(
            "RATE_LIMITED",
            "El motor alcanzó su límite de uso. Reintenta más tarde en esta misma conversación.",
        )
    } else {
        ChatError::new(
            "RUN_FAILED",
            "El motor no pudo completar la consulta. El hilo se conserva; puedes reintentar.",
        )
    }
}

#[derive(Default)]
struct Projection {
    thread_id: Option<String>,
    texts: HashMap<String, String>,
    raw_texts: HashMap<String, String>,
    order: Vec<String>,
    answer: String,
    error: Option<String>,
    completed: bool,
    claude_message: usize,
    activity_labels: HashMap<String, String>,
}
impl Projection {
    fn text(
        &mut self,
        id: &str,
        text: &str,
        run: &str,
        conversation: &str,
        done: bool,
    ) -> Option<RunEvent> {
        if text.len() > MAX_TEXT_BYTES || self.texts.len() > 200 {
            self.error = Some("output limit".into());
            return None;
        }
        self.raw_texts.insert(id.into(), text.into());
        // Hold an incomplete line until more text arrives: a split credential
        // must never leak its remaining chunks after the prefix was redacted.
        let visible = if done {
            text
        } else {
            text.rfind('\n').map(|index| &text[..=index]).unwrap_or("")
        };
        let text = safe_text(visible);
        let duplicate_final = id == "final"
            && self
                .order
                .iter()
                .rev()
                .filter(|key| key.as_str() != "final")
                .find_map(|key| self.texts.get(key))
                .is_some_and(|previous| previous.trim() == text.trim());
        if duplicate_final {
            self.answer = self
                .order
                .iter()
                .filter_map(|key| self.texts.get(key))
                .filter(|value| !value.is_empty())
                .cloned()
                .collect::<Vec<_>>()
                .join("\n\n");
            return None;
        }
        if !self.texts.contains_key(id) {
            self.order.push(id.into());
        }
        let changed = self.texts.get(id) != Some(&text);
        self.texts.insert(id.into(), text.clone());
        {
            self.answer = self
                .order
                .iter()
                .filter_map(|key| self.texts.get(key))
                .filter(|value| !value.is_empty())
                .cloned()
                .collect::<Vec<_>>()
                .join("\n\n");
            if self.answer.len() > MAX_TEXT_BYTES {
                self.error = Some("output limit".into());
                return None;
            }
        }
        if !changed {
            return None;
        }
        let mut output = event(
            run,
            conversation,
            "text",
            if done { "completed" } else { "running" },
        );
        output.text = Some(text);
        output.item_id = Some(id.into());
        Some(output)
    }
    fn ingest(
        &mut self,
        value: &Value,
        engine: ChatEngine,
        run: &str,
        conversation: &str,
    ) -> Vec<RunEvent> {
        let mut out = vec![];
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        if engine == ChatEngine::Codex {
            if kind == "thread.started" {
                self.thread_id = value
                    .get("thread_id")
                    .and_then(Value::as_str)
                    .filter(|id| valid_id(id))
                    .map(str::to_owned);
            }
            if kind == "turn.completed" {
                self.completed = true;
            }
            if kind == "error" || kind == "turn.failed" {
                self.error = Some(
                    value
                        .get("message")
                        .or_else(|| value.get("error").and_then(|v| v.get("message")))
                        .and_then(Value::as_str)
                        .unwrap_or("run failed")
                        .chars()
                        .take(2000)
                        .collect(),
                );
            }
            if ["item.started", "item.updated", "item.completed"].contains(&kind) {
                if let Some(item) = value.get("item") {
                    let item_kind = item.get("type").and_then(Value::as_str).unwrap_or("");
                    let id = item
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|id| valid_id(id))
                        .unwrap_or("message");
                    if item_kind == "agent_message" {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            if let Some(e) =
                                self.text(id, text, run, conversation, kind == "item.completed")
                            {
                                out.push(e);
                            }
                        }
                    } else {
                        let label = match item_kind {
                            "command_execution" => Some("Consulta local"),
                            "mcp_tool_call" => Some("Herramienta conectada"),
                            "web_search" => Some("Búsqueda web"),
                            "file_change" => Some("Cambio de archivo solicitado"),
                            _ => None,
                        };
                        if let Some(label) = label {
                            let mut output = event(
                                run,
                                conversation,
                                "activity",
                                if item.get("status").and_then(Value::as_str) == Some("failed") {
                                    "failed"
                                } else if kind == "item.completed" {
                                    "completed"
                                } else {
                                    "running"
                                },
                            );
                            output.item_id = Some(id.into());
                            output.label = Some(label.into());
                            if item_kind == "command_execution" {
                                let command =
                                    item.get("command").and_then(Value::as_str).unwrap_or("");
                                if let Some(name) = skill_from_command(command) {
                                    output.label = Some(format!("Skill consultada: {name}"));
                                }
                            }
                            out.push(output);
                        }
                    }
                }
            }
        } else {
            if let Some(id) = value
                .get("session_id")
                .and_then(Value::as_str)
                .filter(|id| valid_id(id))
            {
                self.thread_id = Some(id.into());
            }
            if kind == "stream_event" {
                if let Some(inner) = value.get("event") {
                    let index = inner.get("index").and_then(Value::as_u64).unwrap_or(0);
                    if inner.get("type").and_then(Value::as_str) == Some("message_start") {
                        self.claude_message += 1;
                    }
                    let id = format!("claude-{}-{index}", self.claude_message);
                    if inner.get("type").and_then(Value::as_str) == Some("content_block_delta")
                        && inner.pointer("/delta/type").and_then(Value::as_str)
                            == Some("text_delta")
                    {
                        let delta = inner
                            .pointer("/delta/text")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let text = format!(
                            "{}{}",
                            self.raw_texts.get(&id).map(String::as_str).unwrap_or(""),
                            delta
                        );
                        if let Some(e) = self.text(&id, &text, run, conversation, false) {
                            out.push(e);
                        }
                    }
                }
            }
            if kind == "assistant" {
                if let Some(content) = value.pointer("/message/content").and_then(Value::as_array) {
                    for (index, block) in content.iter().enumerate() {
                        match block.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(text) = block.get("text").and_then(Value::as_str) {
                                    if let Some(e) = self.text(
                                        &format!("claude-{}-{index}", self.claude_message),
                                        text,
                                        run,
                                        conversation,
                                        true,
                                    ) {
                                        out.push(e);
                                    }
                                }
                            }
                            Some("tool_use") => {
                                let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                                let label = match name {
                                    "Read" => "Leer archivo",
                                    "Grep" | "Glob" => "Buscar archivos",
                                    "WebSearch" => "Búsqueda web",
                                    "Skill" => "Consultar skill",
                                    _ => "Herramienta de Claude",
                                };
                                let mut output = event(run, conversation, "activity", "running");
                                output.label = Some(label.into());
                                output.item_id = block
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .filter(|id| valid_id(id))
                                    .map(str::to_owned);
                                if name == "Skill" {
                                    let skill = block
                                        .pointer("/input/skill")
                                        .and_then(Value::as_str)
                                        .unwrap_or("");
                                    if valid_skill_name(skill) {
                                        output.label = Some(format!("Skill: {skill}"));
                                    }
                                }
                                if let (Some(id), Some(label)) = (&output.item_id, &output.label) {
                                    if self.activity_labels.len() < 200 {
                                        self.activity_labels.insert(id.clone(), label.clone());
                                    }
                                }
                                out.push(output);
                            }
                            _ => {}
                        }
                    }
                }
            }
            if kind == "user" {
                if let Some(content) = value.pointer("/message/content").and_then(Value::as_array) {
                    for block in content {
                        if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                            let mut e = event(
                                run,
                                conversation,
                                "activity",
                                if block.get("is_error").and_then(Value::as_bool) == Some(true) {
                                    "failed"
                                } else {
                                    "completed"
                                },
                            );
                            e.item_id = block
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .filter(|id| valid_id(id))
                                .map(str::to_owned);
                            e.label = Some(
                                e.item_id
                                    .as_ref()
                                    .and_then(|id| self.activity_labels.get(id))
                                    .cloned()
                                    .unwrap_or_else(|| "Herramienta de Claude".into()),
                            );
                            out.push(e);
                        }
                    }
                }
            }
            if kind == "result" {
                let result = value.get("result").and_then(Value::as_str).unwrap_or("");
                if value.get("is_error").and_then(Value::as_bool) == Some(true) {
                    self.error = Some(result.chars().take(2000).collect());
                } else {
                    self.completed = true;
                    if let Some(e) = self.text("final", result, run, conversation, true) {
                        out.push(e);
                    }
                }
            }
        }
        out
    }
}

fn command_for(
    engine: ChatEngine,
    binary: &Path,
    prompt: &str,
    path: &Path,
    thread_id: Option<&str>,
    profile: CodexProfile,
) -> Command {
    let mut command = Command::new(binary);
    if engine == ChatEngine::Codex {
        command.arg("exec");
        if thread_id.is_some() {
            command.arg("resume");
        }
        configure_codex_profile(&mut command, profile);
        command.args([
            "--config",
            "sandbox_mode=\"read-only\"",
            "--config",
            "approval_policy=\"never\"",
            "--json",
            "--skip-git-repo-check",
        ]);
        if let Some(id) = thread_id {
            command.arg(id);
        } else {
            command
                .arg("--sandbox")
                .arg("read-only")
                .arg("-C")
                .arg(path);
        }
    } else {
        command
            .args([
                "--print",
                "--verbose",
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "--model",
                claude_cli_model(profile.model),
                "--effort",
                profile.effort,
                "--restricted",
                "--permission-prompts",
                "none",
                "--add-dir",
            ])
            .arg(path);
        if let Some(id) = thread_id {
            command.arg("--resume").arg(id);
        }
    }
    command
        .arg("--")
        .arg(prompt)
        .current_dir(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    command
}

#[derive(Debug)]
enum PipeEvent {
    Line(Vec<u8>),
    Error,
    End,
}
fn read_pipe(reader: impl Read + Send + 'static, tx: mpsc::SyncSender<PipeEvent>) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut total = 0;
        loop {
            let mut bytes = vec![];
            match (&mut reader)
                .take((MAX_LINE_BYTES + 1) as u64)
                .read_until(b'\n', &mut bytes)
            {
                Ok(0) => break,
                Ok(_) => {
                    total += bytes.len();
                    if bytes.len() > MAX_LINE_BYTES || total > MAX_STREAM_BYTES {
                        let _ = tx.send(PipeEvent::Error);
                        break;
                    }
                    if tx.send(PipeEvent::Line(bytes)).is_err() {
                        return;
                    }
                }
                Err(_) => {
                    let _ = tx.send(PipeEvent::Error);
                    break;
                }
            }
        }
        let _ = tx.send(PipeEvent::End);
    });
}
struct ProcessResult {
    answer: String,
    thread_id: Option<String>,
    error: Option<ChatError>,
}
fn drive_process(
    mut command: Command,
    engine: ChatEngine,
    resumed: bool,
    control: Arc<RunControl>,
    run: &str,
    conversation: &str,
    mut emit: impl FnMut(RunEvent),
) -> ProcessResult {
    let child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            return ProcessResult {
                answer: String::new(),
                thread_id: None,
                error: Some(ChatError::new(
                    "ENGINE_UNAVAILABLE",
                    "No se pudo abrir el motor de chat instalado.",
                )),
            }
        }
    };
    control.pid.store(child.id() as i32, Ordering::SeqCst);
    let mut child = OwnedChild {
        child,
        control: Arc::clone(&control),
    };
    let (tx, rx) = mpsc::sync_channel(32);
    let (errtx, errrx) = mpsc::sync_channel(32);
    read_pipe(child.stdout.take().expect("piped stdout"), tx);
    read_pipe(child.stderr.take().expect("piped stderr"), errtx);
    let start = Instant::now();
    let mut cancel_started = None;
    let mut projection = Projection::default();
    let mut stderr = String::new();
    let mut error = None;
    let mut out_end = false;
    let mut err_end = false;
    let mut exit = None;
    let mut exited_at = None;
    loop {
        if control.cancelled.load(Ordering::SeqCst)
            || start.elapsed() > RUN_TIMEOUT
            || error.is_some()
        {
            if cancel_started.is_none() {
                cancel_started = Some(Instant::now());
                signal_group(control.pid.load(Ordering::SeqCst), libc::SIGTERM);
            }
            if cancel_started.is_some_and(|time| time.elapsed() > Duration::from_millis(400)) {
                signal_group(control.pid.load(Ordering::SeqCst), libc::SIGKILL);
            }
        }
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(PipeEvent::Line(line)) => {
                if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                    for event in projection.ingest(&value, engine, run, conversation) {
                        emit(event);
                    }
                }
            }
            Ok(PipeEvent::Error) => {
                error = Some(ChatError::new(
                    "OUTPUT_LIMIT",
                    "La respuesta superó el límite de lectura; se detuvo la consulta.",
                ));
                out_end = true;
            }
            Ok(PipeEvent::End) | Err(mpsc::RecvTimeoutError::Disconnected) => out_end = true,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if projection.error.as_deref() == Some("output limit") {
            error = Some(ChatError::new(
                "OUTPUT_LIMIT",
                "La respuesta superó el límite de lectura; se detuvo la consulta.",
            ));
        }
        for value in errrx.try_iter() {
            match value {
                PipeEvent::Line(line) if stderr.len() < 16_000 => stderr.push_str(
                    &String::from_utf8_lossy(&line[..line.len().min(16_000 - stderr.len())]),
                ),
                PipeEvent::Error | PipeEvent::End => err_end = true,
                _ => {}
            }
        }
        if exit.is_none() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    exit = Some(status);
                    exited_at = Some(Instant::now());
                }
                Ok(None) => {}
                Err(_) => {
                    error = Some(ChatError::new(
                        "RUN_FAILED",
                        "No se pudo supervisar la consulta.",
                    ));
                    break;
                }
            }
        }
        if exit.is_some() && out_end && err_end {
            break;
        }
        // Descendant processes may retain pipes: terminate only this owned group.
        if exited_at.is_some_and(|time| time.elapsed() > Duration::from_secs(2)) {
            signal_group(control.pid.load(Ordering::SeqCst), libc::SIGKILL);
            break;
        }
    }
    if exit.is_none() {
        signal_group(control.pid.load(Ordering::SeqCst), libc::SIGKILL);
        let _ = child.wait();
    }
    signal_group(control.pid.load(Ordering::SeqCst), libc::SIGKILL);
    control.pid.store(0, Ordering::SeqCst);
    if control.cancelled.load(Ordering::SeqCst) {
        error = Some(ChatError::new(
            "RUN_CANCELLED",
            "Consulta detenida. La conversación se conserva.",
        ));
    } else if start.elapsed() > RUN_TIMEOUT {
        error = Some(ChatError::new(
            "RUN_TIMEOUT",
            "La consulta excedió el tiempo máximo; el hilo se conserva.",
        ));
    } else if error.is_none() {
        if let Some(message) = projection.error.as_deref() {
            error = Some(classified_error(message, resumed));
        } else if !exit.is_some_and(|s| s.success()) {
            error = Some(classified_error(&stderr, resumed));
        } else if !projection.completed {
            error = Some(ChatError::new("INCOMPLETE_RESPONSE", "El motor terminó sin confirmar el final del turno. El texto parcial y el hilo se conservan."));
        } else if projection.answer.trim().is_empty() {
            error = Some(ChatError::new(
                "EMPTY_RESPONSE",
                "El motor terminó sin respuesta. La conversación se conserva.",
            ));
        }
    }

    ProcessResult {
        answer: projection.answer,
        thread_id: projection.thread_id,
        error,
    }
}

#[derive(Serialize)]
pub struct Reply {
    answer: String,
    context: String,
    engine: String,
    model: String,
    effort: String,
    conversation_id: String,
    run_id: String,
    conversation: Conversation,
}
#[tauri::command]
pub async fn ask_codex(
    app: AppHandle,
    conversation_id: String,
    run_id: String,
    prompt: String,
    project: Option<String>,
    engine: String,
    model: String,
    effort: String,
    state: State<'_, ChatStore>,
    runs: State<'_, ChatRuns>,
) -> Result<Reply> {
    if !valid_id(&run_id) || !valid_id(&conversation_id) {
        return Err(ChatError::new(
            "INVALID_REQUEST",
            "Identificador de consulta no válido.",
        ));
    }
    let prompt = prompt.trim().to_owned();
    if prompt.is_empty() || prompt.chars().count() > 24_000 {
        return Err(ChatError::new(
            "INVALID_PROMPT",
            "Escribe un mensaje de entre 1 y 24 000 caracteres.",
        ));
    }
    let cfg = config::current().map_err(|m| ChatError::new("CONFIG_REQUIRED", m))?;
    let path = checked_project(&cfg, project.as_deref())
        .map_err(|m| ChatError::new("INVALID_CONTEXT", m))?;
    let context = project.unwrap_or_else(|| "general".into());
    let engine_value =
        checked_engine(Some(&engine)).map_err(|m| ChatError::new("INVALID_PROFILE", m))?;
    let binary = engine_binary(&cfg, engine_value)
        .map_err(|m| ChatError::new("ENGINE_UNAVAILABLE", m))?;
    let checked =
        profile(engine_value, &model, &effort).map_err(|m| ChatError::new("INVALID_PROFILE", m))?;
    let storage = store_path(&app)?;
    let record = {
        let mut slot = state.0.lock().map_err(|_| storage_error())?;
        let store = ensure_loaded(&mut slot, &storage)?;
        store
            .conversations
            .iter()
            .find(|r| r.public.id == conversation_id)
            .cloned()
            .ok_or_else(|| {
                ChatError::new(
                    "CONVERSATION_NOT_FOUND",
                    "No se encuentra esta conversación local. El historial visible se conserva.",
                )
            })?
    };
    if record.public.engine != engine || record.public.context != context {
        return Err(ChatError::new(
            "CONTEXT_MISMATCH",
            "El motor y el proyecto pertenecen a la conversación; abre otra para cambiarlos.",
        ));
    }
    if record.public.status == "expired" {
        return Err(classified_error("session not found", true));
    }
    let control = Arc::new(RunControl::default());
    {
        let mut active = runs.0.lock().map_err(|_| storage_error())?;
        if runs.1.lock().map_err(|_| storage_error())?.remove(&run_id) {
            return Err(ChatError::new(
                "RUN_CANCELLED",
                "Consulta detenida antes de iniciar el motor.",
            ));
        }
        if active.contains_key(&run_id)
            || active
                .values()
                .any(|r| r.conversation_id == conversation_id)
            || active.len() >= 4
        {
            return Err(ChatError::new(
                "RUN_BUSY",
                "La conversación ya tiene una consulta activa.",
            ));
        }
        active.insert(
            run_id.clone(),
            ActiveRun {
                conversation_id: conversation_id.clone(),
                control: Arc::clone(&control),
            },
        );
    }
    let _lease = RunLease(&runs, run_id.clone());
    let mut started = event(&run_id, &conversation_id, "status", "running");
    started.label = Some("Consulta en curso".into());
    let _ = app.emit("chat-run-event", started);
    let worker_app = app.clone();
    let worker_run = run_id.clone();
    let worker_conversation = conversation_id.clone();
    let command = command_for(
        engine_value,
        &binary,
        &prompt,
        &path,
        record.thread_id.as_deref(),
        checked,
    );
    let resumed = record.thread_id.is_some();
    let result = tauri::async_runtime::spawn_blocking(move || {
        drive_process(
            command,
            engine_value,
            resumed,
            control,
            &worker_run,
            &worker_conversation,
            |event| {
                let _ = worker_app.emit("chat-run-event", event);
            },
        )
    })
    .await;
    let result = result.map_err(|_| {
        ChatError::new(
            "RUN_FAILED",
            "La consulta se interrumpió; el hilo se conserva.",
        )
    })?;
    // Persist even a cancelled/failed new thread when the CLI provided its ID.
    let mut final_error = result.error;
    let returned_thread = if resumed
        && result
            .thread_id
            .as_deref()
            .is_some_and(|id| Some(id) != record.thread_id.as_deref())
    {
        final_error = Some(ChatError::new("SESSION_EXPIRED", "El motor devolvió un hilo distinto. El historial original se conserva; crea un chat nuevo explícitamente."));
        None
    } else {
        result.thread_id
    };
    if final_error.is_none() && returned_thread.is_none() && record.thread_id.is_none() {
        final_error = Some(ChatError::new("SESSION_EXPIRED", "El motor no devolvió una sesión recuperable. Conserva la respuesta y abre un chat nuevo."));
    }
    let mut item = record.public.clone();
    item.model = checked.model.into();
    item.effort = checked.effort.into();
    item.updated_at = epoch_millis();
    if final_error
        .as_ref()
        .is_some_and(|e| e.code == "SESSION_EXPIRED")
    {
        item.status = "expired".into();
    } else if returned_thread.is_some() || record.thread_id.is_some() {
        item.status = "ready".into();
    }
    let saved = (|| {
        let mut slot = state.0.lock().map_err(|_| storage_error())?;
        let store = ensure_loaded(&mut slot, &storage)?;
        let mut updated = store.clone();
        let found = updated
            .conversations
            .iter_mut()
            .find(|r| r.public.id == conversation_id)
            .ok_or_else(storage_error)?;
        found.public = item.clone();
        if returned_thread.is_some() {
            found.thread_id = returned_thread;
        }
        write_store(&storage, &updated)?;
        *store = updated;
        Ok(())
    })();
    if let Err(error) = saved {
        final_error = Some(error);
    }
    if let Some(error) = final_error {
        let mut ended = event(
            &run_id,
            &conversation_id,
            "error",
            if error.code == "RUN_CANCELLED" {
                "cancelled"
            } else {
                "failed"
            },
        );
        ended.code = Some(error.code);
        ended.label = Some(error.message.clone());
        let _ = app.emit("chat-run-event", ended);
        return Err(error);
    }
    let mut ended = event(&run_id, &conversation_id, "status", "completed");
    ended.label = Some("Consulta completada".into());
    let _ = app.emit("chat-run-event", ended);
    Ok(Reply {
        answer: result.answer,
        context,
        engine,
        model: checked.model.into(),
        effort: checked.effort.into(),
        conversation_id,
        run_id,
        conversation: item,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogue_is_the_profile_validator_for_every_model() {
        for (engine, models) in [
            (ChatEngine::Codex, CODEX_MODELS),
            (ChatEngine::Claude, CLAUDE_MODELS),
        ] {
            for model in models {
                for effort in model.efforts {
                    assert!(profile(engine, model.value, effort).is_ok());
                }
            }
        }
        assert!(profile(ChatEngine::Codex, "gpt-6-astra", "ultra").is_ok());
        assert!(profile(ChatEngine::Codex, "gpt-6-sol", "ultra").is_ok());
        assert!(profile(ChatEngine::Codex, "gpt-6-luna", "ultra").is_err());
        assert!(profile(ChatEngine::Claude, "opus", "ultra").is_err());
        assert!(profile(ChatEngine::Codex, "opus", "high").is_err());
        assert!(profile(ChatEngine::Claude, "gpt-5.6-sol", "high").is_err());
        assert!(CODEX_MODELS.iter().all(|model| model.value.starts_with("gpt-")));
        assert!(CLAUDE_MODELS.iter().all(|model| !model.value.starts_with("gpt-")));
    }

    #[test]
    fn retired_codex_models_resolve_to_their_successor() {
        for (retired, successor) in RETIRED_CODEX_MODELS {
            assert!(!CODEX_MODELS.iter().any(|model| model.value == *retired));
            let target = CODEX_MODELS.iter().find(|model| model.value == *successor).unwrap();
            for effort in target.efforts {
                assert_eq!(profile(ChatEngine::Codex, retired, effort).unwrap().model, *successor);
            }
        }
        assert_eq!(profile(ChatEngine::Codex, "gpt-5.6-terra", "ultra").unwrap(), CodexProfile { model: "gpt-6-sol", effort: "ultra" });
        assert!(profile(ChatEngine::Codex, "gpt-5.6-luna", "ultra").is_err());
    }

    #[test]
    fn stored_conversations_on_retired_models_load_as_their_successor() {
        let bytes = br#"{"version":2,"conversations":[{"id":"conv-1","engine":"codex","context":"general","model":"gpt-5.6-terra","effort":"medium","created_at":1,"updated_at":2,"status":"expired","legacy_key":null}]}"#;
        let store = validated_store(bytes).unwrap();
        assert_eq!(store.conversations[0].public.model, "gpt-6-sol");
    }

    #[test]
    fn claude_opus_is_pinned_for_the_cli() {
        assert_eq!(claude_cli_model("opus"), "claude-opus-5-5");
        assert_eq!(claude_cli_model("sonnet"), "sonnet");
        let command = command_for(
            ChatEngine::Claude,
            Path::new("/usr/bin/true"),
            "hello",
            Path::new("/tmp"),
            None,
            profile(ChatEngine::Claude, "opus", "max").unwrap(),
        );
        let args: Vec<_> = command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let at = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[at + 1], "claude-opus-5-5");
        assert!(!args.contains(&"opus".to_string()));
    }

    #[test]
    fn migration_keeps_separate_legacy_profiles_and_never_guesses_context() {
        let bytes = br#"{"version":1,"sessions":{
            "codex::general::gpt-5.6-terra::medium":{"id":"thread-1","updated":10},
            "codex::general::gpt-5.6-terra::high":{"id":"thread-2","updated":20},
            "claude::tesis::sonnet::high":{"id":"thread-3","updated":30},
            "codex::../../private::gpt-5.6-terra::high":{"id":"thread-4","updated":40},
            "general":{"id":"thread-5","updated":50}
        }}"#;
        let migrated = migrate_legacy(bytes).unwrap();
        assert_eq!(migrated.conversations.len(), 3);
        assert_eq!(migrated.warnings.len(), 1);
        let ids: HashSet<_> = migrated
            .conversations
            .iter()
            .map(|r| &r.public.id)
            .collect();
        assert_eq!(ids.len(), 3);
        assert!(migrated
            .conversations
            .iter()
            .all(|r| r.public.id != *r.thread_id.as_ref().unwrap()));
        assert!(migrated
            .conversations
            .iter()
            .any(|r| r.public.legacy_key.as_deref()
                == Some("codex::general::gpt-5.6-terra::medium")
                && r.public.model == "gpt-6-sol"
                && r.thread_id.as_deref() == Some("thread-1")));
        let public = serde_json::to_string(
            &migrated
                .conversations
                .iter()
                .map(|r| &r.public)
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert!(!public.contains("thread-1"));
    }

    #[test]
    fn migration_is_published_once_and_corrupt_store_is_not_overwritten() {
        let dir = std::env::temp_dir().join(format!("esprit-chat-test-{}", random_id().unwrap()));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("chat-conversations.json");
        fs::write(dir.join("chat-sessions.json"),br#"{"version":1,"sessions":{"codex::general::gpt-5.6-terra::medium":{"id":"thread-1","updated":10}}}"#).unwrap();
        let first_id = ensure_loaded(&mut None, &path).unwrap().conversations[0]
            .public
            .id
            .clone();
        let second_id = ensure_loaded(&mut None, &path).unwrap().conversations[0]
            .public
            .id
            .clone();
        assert_eq!(first_id, second_id);
        fs::write(&path, b"corrupt").unwrap();
        assert!(ensure_loaded(&mut None, &path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"corrupt");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn profile_change_resumes_the_same_thread_and_forces_read_only() {
        for effort in ["medium", "ultra"] {
            let command = command_for(
                ChatEngine::Codex,
                Path::new("/usr/bin/true"),
                "hello",
                Path::new("/tmp"),
                Some("thread-123"),
                profile(ChatEngine::Codex, "gpt-6-astra", effort).unwrap(),
            );
            let args: Vec<_> = command
                .get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
            assert_eq!(&args[..2], &["exec", "resume"]);
            assert!(args.contains(&"thread-123".into()));
            assert!(args.contains(&"sandbox_mode=\"read-only\"".into()));
            assert!(args.contains(&"approval_policy=\"never\"".into()));
            assert!(!args.iter().any(|a| a.contains("danger-full")));
        }
    }

    #[test]
    fn projection_keeps_user_text_and_rejects_reasoning_and_tool_secrets() {
        let mut projection = Projection::default();
        let private = [
            json!({"type":"item.completed","item":{"id":"i1","type":"reasoning","text":"private thought"}}),
            json!({"type":"item.started","item":{"id":"i2","type":"command_execution","command":"echo secret-token","aggregated_output":"secret-output"}}),
            json!({"type":"item.completed","item":{"id":"i3","type":"mcp_tool_call","arguments":{"password":"secret"},"result":"private document"}}),
        ];
        let events: Vec<_> = private
            .iter()
            .flat_map(|v| projection.ingest(v, ChatEngine::Codex, "run", "conversation"))
            .collect();
        let wire = serde_json::to_string(&events).unwrap();
        for secret in [
            "private thought",
            "secret-token",
            "secret-output",
            "password",
            "private document",
        ] {
            assert!(!wire.contains(secret), "{wire}");
        }
        assert_eq!(events.len(), 2);
        let text = json!({"type":"item.updated","item":{"id":"answer","type":"agent_message","text":"Respuesta parcial\n"}});
        assert_eq!(
            projection.ingest(&text, ChatEngine::Codex, "run", "conversation")[0]
                .text
                .as_deref(),
            Some("Respuesta parcial")
        );
        assert!(projection
            .ingest(&text, ChatEngine::Codex, "run", "conversation")
            .is_empty());
    }

    #[test]
    fn claude_partial_messages_exclude_thinking_and_arguments() {
        let mut projection = Projection::default();
        for delta in [
            json!({"type":"thinking_delta","thinking":"secret reasoning"}),
            json!({"type":"input_json_delta","partial_json":"secret argument"}),
        ] {
            assert!(projection.ingest(&json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":delta}}),ChatEngine::Claude,"run","conversation").is_empty());
        }
        let events = projection.ingest(&json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Visible\n"}}}),ChatEngine::Claude,"run","conversation");
        assert_eq!(events[0].text.as_deref(), Some("Visible"));
    }

    #[test]
    fn expired_thread_is_distinct_from_auth_and_transient_failure() {
        assert_eq!(
            classified_error("session not found", true).code,
            "SESSION_EXPIRED"
        );
        assert_eq!(
            classified_error("OAuth session expired", true).code,
            "AUTH_REQUIRED"
        );
        assert_eq!(
            classified_error("connection reset by peer", true).code,
            "RUN_FAILED"
        );
        assert_eq!(
            classified_error("session not found", false).code,
            "RUN_FAILED"
        );
        assert_eq!(
            classified_error("429 rate limit", true).code,
            "RATE_LIMITED"
        );
        // Texto real de Claude Code al agotar la cuota de la sesión.
        assert_eq!(
            classified_error("You've hit your session limit · resets 8:30pm", true).code,
            "RATE_LIMITED"
        );
    }

    #[test]
    fn bounded_reader_stops_on_an_oversized_line() {
        let (tx, rx) = mpsc::sync_channel(2);
        read_pipe(std::io::Cursor::new(vec![b'x'; MAX_LINE_BYTES + 2]), tx);
        assert!(matches!(
            rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            PipeEvent::Error
        ));
    }

    #[test]
    fn cancellation_kills_the_actual_owned_process_and_preserves_thread_id() {
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "printf '%s\n' '{\"type\":\"thread.started\",\"thread_id\":\"test-thread\"}'; sleep 30",
        ]);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        let control = Arc::new(RunControl::default());
        let cancel = Arc::clone(&control);
        let worker = std::thread::spawn(move || {
            drive_process(
                command,
                ChatEngine::Codex,
                false,
                control,
                "run",
                "conversation",
                |_| {},
            )
        });
        let until = Instant::now();
        while cancel.pid.load(Ordering::SeqCst) == 0 && until.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(5));
        }
        std::thread::sleep(Duration::from_millis(50));
        let pid = cancel.pid.load(Ordering::SeqCst);
        assert!(pid > 0);
        cancel.cancelled.store(true, Ordering::SeqCst);
        signal_group(pid, libc::SIGTERM);
        let result = worker.join().unwrap();
        assert!(until.elapsed() < Duration::from_secs(3));
        assert_eq!(result.error.unwrap().code, "RUN_CANCELLED");
        assert_eq!(result.thread_id.as_deref(), Some("test-thread"));
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    }
    #[test]
    fn multiple_visible_agent_messages_survive_final_and_snapshots_do_not_duplicate() {
        let mut projection = Projection::default();
        for value in [
            json!({"type":"item.completed","item":{"id":"comment","type":"agent_message","text":"Contexto consultado."}}),
            json!({"type":"item.updated","item":{"id":"answer","type":"agent_message","text":"Respuesta parcial\n"}}),
            json!({"type":"item.completed","item":{"id":"answer","type":"agent_message","text":"Respuesta final."}}),
        ] {
            projection.ingest(&value, ChatEngine::Codex, "run", "conversation");
        }
        assert_eq!(
            projection.answer,
            "Contexto consultado.\n\nRespuesta final."
        );
        let final_value = json!({"type":"result","session_id":"thread","result":"Respuesta final.","is_error":false});
        projection.ingest(&final_value, ChatEngine::Claude, "run", "conversation");
        assert_eq!(
            projection.answer,
            "Contexto consultado.\n\nRespuesta final."
        );
    }

    #[test]
    fn credential_blocks_and_split_tokens_never_reach_text_events() {
        let pem =
            "Before\n-----BEGIN PRIVATE KEY-----\nSECRETBASE64\n-----END PRIVATE KEY-----\nAfter";
        let visible = safe_text(pem);
        assert!(!visible.contains("SECRETBASE64"));
        assert!(visible.contains("Before"));
        assert!(visible.contains("After"));
        assert_eq!(safe_text("A risk-free example"), "A risk-free example");
        let mut projection = Projection::default();
        let mut wire = String::new();
        for chunk in ["password=", "SUPERSECRET", "\nTexto seguro\n"] {
            let value = json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":chunk}}});
            for event in projection.ingest(&value, ChatEngine::Claude, "run", "conversation") {
                wire.push_str(&serde_json::to_string(&event).unwrap());
            }
        }
        assert!(!wire.contains("SUPERSECRET"), "{wire}");
        assert!(wire.contains("Texto seguro"));
    }
}
