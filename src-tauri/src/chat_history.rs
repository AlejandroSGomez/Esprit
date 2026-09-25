//! Versioned visible chat history. Separate from the native-only CLI session store.
//! Strict structural allowlists reject raw tools, credentials fields and CLI IDs.
use super::chat::ChatError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

const MAX_BYTES: usize = 24 * 1024 * 1024;
#[derive(Default)]
pub struct HistoryLock(Arc<Mutex<()>>);
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryEnvelope {
    pub revision: u64,
    pub history: Option<Value>,
}
#[derive(Debug, Serialize)]
pub struct SavedRevision {
    revision: u64,
}
fn invalid() -> ChatError {
    ChatError::new("INVALID_HISTORY","El historial no tiene un formato válido o supera sus límites. Se conserva la copia anterior.")
}
fn unavailable() -> ChatError {
    ChatError::new(
        "HISTORY_UNAVAILABLE",
        "No se pudo leer o guardar el historial local. Se conserva la copia anterior.",
    )
}
fn object<'a>(value: &'a Value, fields: &[&str]) -> Result<&'a Map<String, Value>, ChatError> {
    let obj = value.as_object().ok_or_else(invalid)?;
    if obj.keys().any(|k| !fields.contains(&k.as_str())) {
        return Err(invalid());
    }
    Ok(obj)
}
fn string<'a>(obj: &'a Map<String, Value>, key: &str, max: usize) -> Result<&'a str, ChatError> {
    let text = obj.get(key).and_then(Value::as_str).ok_or_else(invalid)?;
    if text.chars().count() > max {
        return Err(invalid());
    }
    Ok(text)
}
fn identifier<'a>(obj: &'a Map<String, Value>, key: &str) -> Result<&'a str, ChatError> {
    let id = string(obj, key, 160)?;
    if id.is_empty()
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || [b'-', b'_', b':'].contains(&c))
    {
        return Err(invalid());
    }
    Ok(id)
}
fn number(obj: &Map<String, Value>, key: &str) -> Result<u64, ChatError> {
    obj.get(key)
        .and_then(Value::as_u64)
        .filter(|v| *v <= 9_007_199_254_740_991)
        .ok_or_else(invalid)
}
fn optional_number(obj: &Map<String, Value>, key: &str) -> Result<(), ChatError> {
    if obj.contains_key(key) {
        number(obj, key)?;
    }
    Ok(())
}
fn profile(obj: &Map<String, Value>) -> Result<(&str, &str), ChatError> {
    let context = string(obj, "context", 80)?;
    let engine = string(obj, "engine", 16)?;
    if !super::chat::context_allowed(context) {
        return Err(invalid());
    }
    let engine_value = super::checked_engine(Some(engine)).map_err(|_| invalid())?;
    super::chat::profile(
        engine_value,
        string(obj, "model", 80)?,
        string(obj, "effort", 16)?,
    )
    .map_err(|_| invalid())?;
    Ok((context, engine))
}
fn validate(value: &Value) -> Result<(), ChatError> {
    let root = object(
        value,
        &["version", "selected_id", "conversations", "drafts"],
    )?;
    if root.get("version").and_then(Value::as_u64) != Some(2) {
        return Err(invalid());
    }
    if let Some(drafts) = root.get("drafts") {
        let drafts = drafts.as_object().ok_or_else(invalid)?;
        if drafts.len() > 16 {
            return Err(invalid());
        }
        for (key, text) in drafts {
            let parts: Vec<_> = key.split("::").collect();
            if parts.len() != 2
                || super::checked_engine(Some(parts[0])).is_err()
                || !super::chat::context_allowed(parts[1])
                || text
                    .as_str()
                    .is_none_or(|value| value.chars().count() > 6000)
            {
                return Err(invalid());
            }
        }
    }
    let conversations = root
        .get("conversations")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if conversations.len() > 120 {
        return Err(invalid());
    }
    let mut ids = HashSet::new();
    for value in conversations {
        let conv = object(
            value,
            &[
                "context",
                "engine",
                "model",
                "effort",
                "id",
                "created_at",
                "updated_at",
                "status",
                "legacy_key",
                "title",
                "draft",
                "messages",
                "archived",
                "older_messages",
            ],
        )?;
        let id = identifier(conv, "id")?;
        if !ids.insert(id) {
            return Err(invalid());
        }
        let (context, engine) = profile(conv)?;
        number(conv, "created_at")?;
        number(conv, "updated_at")?;
        string(conv, "title", 120)?;
        string(conv, "draft", 6000)?;
        if !["new", "ready", "expired"].contains(&string(conv, "status", 16)?) {
            return Err(invalid());
        }
        if let Some(legacy) = conv.get("legacy_key").filter(|v| !v.is_null()) {
            let key = legacy.as_str().ok_or_else(invalid)?;
            let parts: Vec<_> = key.split("::").collect();
            if key.len() > 200 || parts.len() != 4 || parts[0] != engine || parts[1] != context {
                return Err(invalid());
            }
        }
        if conv.get("archived").is_some_and(|v| !v.is_boolean()) {
            return Err(invalid());
        }
        optional_number(conv, "older_messages")?;
        let messages = conv
            .get("messages")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?;
        if messages.len() > 400 {
            return Err(invalid());
        }
        let mut message_ids = HashSet::new();
        for value in messages {
            let msg = object(
                value,
                &[
                    "context",
                    "engine",
                    "model",
                    "effort",
                    "id",
                    "role",
                    "text",
                    "created_at",
                    "activities",
                    "error",
                ],
            )?;
            if !message_ids.insert(identifier(msg, "id")?) {
                return Err(invalid());
            }
            let message_profile = profile(msg)?;
            if message_profile != (context, engine) {
                return Err(invalid());
            }
            if !["user", "assistant"].contains(&string(msg, "role", 16)?) {
                return Err(invalid());
            }
            string(msg, "text", 240_000)?;
            number(msg, "created_at")?;
            if msg.contains_key("error") {
                string(msg, "error", 80)?;
            }
            if let Some(activities) = msg.get("activities") {
                let activities = activities.as_array().ok_or_else(invalid)?;
                if activities.len() > 100 {
                    return Err(invalid());
                }
                for value in activities {
                    let activity = object(value, &["id", "label", "state"])?;
                    identifier(activity, "id")?;
                    string(activity, "label", 240)?;
                    if !["running", "completed", "failed", "cancelled"]
                        .contains(&string(activity, "state", 16)?)
                    {
                        return Err(invalid());
                    }
                }
            }
        }
    }
    match root.get("selected_id") {
        Some(Value::Null) => {}
        Some(Value::String(id)) if ids.contains(id.as_str()) => {}
        _ => return Err(invalid()),
    }
    if serde_json::to_vec(value).map_err(|_| invalid())?.len() > MAX_BYTES {
        return Err(invalid());
    }
    Ok(())
}
fn history_path(app: &AppHandle) -> Result<PathBuf, ChatError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| unavailable())?
        .join("chat-history.json"))
}
fn load_at(path: &Path) -> Result<HistoryEnvelope, ChatError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(HistoryEnvelope {
                revision: 0,
                history: None,
            })
        }
        Err(_) => return Err(unavailable()),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_BYTES as u64 + 1024
    {
        return Err(unavailable());
    }
    let mut bytes = vec![];
    fs::File::open(path)
        .and_then(|f| f.take((MAX_BYTES + 1025) as u64).read_to_end(&mut bytes))
        .map_err(|_| unavailable())?;
    if bytes.len() > MAX_BYTES + 1024 {
        return Err(unavailable());
    }
    let result: HistoryEnvelope = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
    if let Some(history) = &result.history {
        validate(history)?;
    }
    Ok(result)
}
fn save_at(
    path: &Path,
    history: Value,
    expected_revision: u64,
) -> Result<SavedRevision, ChatError> {
    validate(&history)?;
    let current = load_at(path)?;
    if current.revision != expected_revision {
        return Err(ChatError::new(
            "HISTORY_CONFLICT",
            "Hay una versión más reciente del historial. Recárgala antes de guardar.",
        ));
    }
    let revision = current.revision.checked_add(1).ok_or_else(unavailable)?;
    let bytes = serde_json::to_vec(&HistoryEnvelope {
        revision,
        history: Some(history),
    })
    .map_err(|_| invalid())?;
    let parent = path.parent().ok_or_else(unavailable)?;
    fs::create_dir_all(parent).map_err(|_| unavailable())?;
    let temp = parent.join(format!(".chat-history-{}.tmp", super::new_plan_id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let result = (|| {
        let mut file = options.open(&temp).map_err(|_| unavailable())?;
        file.write_all(&bytes).map_err(|_| unavailable())?;
        file.sync_all().map_err(|_| unavailable())?;
        fs::rename(&temp, path).map_err(|_| unavailable())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result?;
    Ok(SavedRevision { revision })
}
#[tauri::command]
pub async fn chat_load_history(
    app: AppHandle,
    state: State<'_, HistoryLock>,
) -> Result<HistoryEnvelope, ChatError> {
    let path = history_path(&app)?;
    let lock = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| unavailable())?;
        load_at(&path)
    })
    .await
    .map_err(|_| unavailable())?
}
#[tauri::command]
pub async fn chat_save_history(
    app: AppHandle,
    history: Value,
    expected_revision: u64,
    state: State<'_, HistoryLock>,
) -> Result<SavedRevision, ChatError> {
    let path = history_path(&app)?;
    let lock = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| unavailable())?;
        save_at(&path, history, expected_revision)
    })
    .await
    .map_err(|_| unavailable())?
}

#[derive(Serialize)]
pub struct ExportResult {
    saved: bool,
    filename: Option<String>,
}
#[tauri::command]
pub async fn chat_export_history(history: Value) -> Result<ExportResult, ChatError> {
    tauri::async_runtime::spawn_blocking(move || {
        validate(&history)?;
        let Some(target) = super::platform::save_dialog("esprit-chat-history.json").map_err(|_| unavailable())? else { return Ok(ExportResult { saved: false, filename: None }); };
        if !target.is_absolute() || target.extension().and_then(|v|v.to_str()) != Some("json") { return Err(ChatError::new("EXPORT_FAILED", "Elige un nombre terminado en .json para el historial.")); }
        let bytes = serde_json::to_vec_pretty(&history).map_err(|_| invalid())?;
        let mut options = OpenOptions::new(); options.write(true).create_new(true);
        #[cfg(unix)] options.mode(0o600);
        let mut file = options.open(&target).map_err(|error| if error.kind() == std::io::ErrorKind::AlreadyExists { ChatError::new("EXPORT_EXISTS", "Ese archivo ya existe. Exporta con un nombre nuevo para conservar ambas copias.") } else { unavailable() })?;
        let result = file.write_all(&bytes).and_then(|_|file.sync_all());
        if result.is_err() { drop(file); let _ = fs::remove_file(&target); return Err(unavailable()); }
        Ok(ExportResult { saved: true, filename: target.file_name().and_then(|v|v.to_str()).map(str::to_owned) })
    }).await.map_err(|_| unavailable())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> Value {
        json!({"version":2,"selected_id":"conv-1","conversations":[{"id":"conv-1","context":"general","engine":"codex","model":"gpt-6-astra","effort":"high","created_at":1,"updated_at":2,"status":"ready","legacy_key":null,"title":"Mi chat","draft":"Continuar","messages":[{"id":"message-1","role":"assistant","text":"Respuesta","context":"general","engine":"codex","model":"gpt-6-astra","effort":"high","created_at":2,"activities":[{"id":"activity-1","label":"Leer archivo","state":"completed"}]}]}]})
    }
    #[test]
    fn validates_only_visible_history_fields_and_context_consistency() {
        assert!(validate(&fixture()).is_ok());
        let mut value = fixture();
        value["conversations"][0]["thread_id"] = json!("private-cli-id");
        assert!(validate(&value).is_err());
        let mut value = fixture();
        value["conversations"][0]["messages"][0]["context"] = json!("tesis");
        assert!(validate(&value).is_err());
        let mut value = fixture();
        value["conversations"][0]["messages"][0]["activities"][0]["arguments"] =
            json!({"token":"secret"});
        assert!(validate(&value).is_err());
        let mut value = fixture();
        value["conversations"][0]["draft"] = json!("x".repeat(6001));
        assert!(validate(&value).is_err());
    }
    #[test]
    fn optimistic_revision_rejects_out_of_order_writes_and_preserves_file() {
        let dir = std::env::temp_dir().join(format!(
            "esprit-history-test-{}",
            super::super::new_plan_id()
        ));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("history.json");
        assert_eq!(load_at(&path).unwrap().revision, 0);
        assert_eq!(save_at(&path, fixture(), 0).unwrap().revision, 1);
        let before = fs::read(&path).unwrap();
        assert_eq!(
            save_at(&path, fixture(), 0).unwrap_err().code,
            "HISTORY_CONFLICT"
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        let mut next = fixture();
        next["conversations"][0]["title"] = json!("Otro nombre");
        assert_eq!(save_at(&path, next.clone(), 1).unwrap().revision, 2);
        assert_eq!(load_at(&path).unwrap().history, Some(next));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn blank_drafts_round_trip_in_the_same_store_without_a_conversation() {
        let dir = std::env::temp_dir().join(format!(
            "esprit-blank-draft-test-{}",
            super::super::new_plan_id()
        ));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("history.json");
        let value = json!({"version":2,"selected_id":null,"conversations":[],"drafts":{"codex::general":"Sin enviar","claude::tesis":"Otro contexto"}});
        assert_eq!(save_at(&path, value.clone(), 0).unwrap().revision, 1);
        assert_eq!(load_at(&path).unwrap().history, Some(value.clone()));
        let mut invalid_scope = value.clone();
        invalid_scope["drafts"]["codex::../../private"] = json!("no");
        assert!(validate(&invalid_scope).is_err());
        let mut too_long = value;
        too_long["drafts"]["codex::general"] = json!("x".repeat(6001));
        assert!(validate(&too_long).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
