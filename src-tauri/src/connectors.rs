//! Read-only Claude connector snapshots. Never used for writes or automatic polling.
use crate::{config::{ClaudeConnectors, Resolved}, CodexProfile};
use serde_json::{json, Value};
use tauri::AppHandle;

pub fn source_for_tool(name: &str) -> Option<&'static str> {
    if name.len() > 180 || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') { return None; }
    let (server, tool) = name.rsplit_once("__")?;
    if !server.starts_with("mcp__") { return None; }
    let server = server.to_ascii_lowercase();
    if server.contains("gmail") && matches!(tool, "gmail_search_messages" | "gmail_read_message" | "gmail_read_thread" | "gmail_batch_read_messages" | "search_messages" | "get_message" | "get_thread" | "list_messages") { return Some("mail"); }
    if (server.contains("google_calendar") || server.contains("gcal")) && matches!(tool, "gcal_list_calendars" | "gcal_list_events" | "gcal_get_event" | "gcal_search_events" | "list_calendars" | "list_events" | "get_event") { return Some("calendar"); }
    None
}

pub fn validate(c: &ClaudeConnectors) -> Result<(), String> {
    if !c.enabled { return Ok(()); }
    if !c.gmail && !c.calendar { return Err("Activa Gmail o Google Calendar en claude_connectors".into()); }
    if c.read_tools.len() > 16 || c.read_tools.iter().any(|t| source_for_tool(t).is_none()) { return Err("claude_connectors.read_tools solo admite herramientas concretas de lectura Gmail/Calendar, sin comodines".into()); }
    for (active, source) in [(c.gmail,"mail"),(c.calendar,"calendar")] {
        if active && !c.read_tools.iter().any(|t| source_for_tool(t)==Some(source)) { return Err(format!("Faltan las herramientas de lectura de {source}; comprueba /mcp en Claude Code")); }
    }
    if c.gmail && ((!c.gmail_query.split_whitespace().any(|t| matches!(t,"newer_than:1d"|"newer_than:2d"|"newer_than:3d"|"newer_than:7d"|"newer_than:14d"))) || c.gmail_query.len()>500 || c.gmail_query.chars().any(char::is_control)) { return Err("Define una consulta Gmail acotada (por ejemplo label:UAM newer_than:7d)".into()); }
    if c.calendar && (c.calendar_ids.is_empty() || c.calendar_ids.len()>8 || c.calendar_ids.iter().any(|id| id.is_empty() || id.len()>254 || id.chars().any(char::is_control))) { return Err("Elige entre uno y ocho IDs de calendarios Google".into()); }
    Ok(())
}

pub fn capture(cfg: &Resolved, app: &AppHandle, profile: CodexProfile, action: &str, sources: &mut Value) {
    let Some(c) = cfg.connectors() else { return; };
    let result = (|| -> Result<Value,String> {
        let path = crate::resource_path(app, "claude_connectors.py")?;
        let model = if crate::chat::engine_for_model(profile.model)==crate::ChatEngine::Claude { crate::chat::claude_cli_model(profile.model) } else { "sonnet" };
        let mut command = crate::bridge_command(cfg, &path);
        command.args(["capture", "--model", model, "--effort", profile.effort, "--action", action]);
        command.stdin(std::process::Stdio::null());
        let output = command.output().map_err(|_| "No se pudo iniciar la captura de conectores")?;
        if !output.status.success() || output.stdout.len()>crate::MAX_DAILY_SOURCE_BYTES { return Err("La captura de conectores falló o superó el límite".into()); }
        serde_json::from_slice(&output.stdout).map_err(|_| "Respuesta de conectores no válida".into())
    })();
    for (active, key) in [(c.gmail,"mail"),(c.calendar,"calendar")] {
        if !active { continue; }
        let value = result.as_ref().ok().and_then(|v|v.get(key)).filter(|v|v.is_object() && v.get("status").and_then(Value::as_str).is_some_and(|s|matches!(s,"available"|"partial"|"unavailable"))).cloned()
            .unwrap_or_else(|| json!({"status":"unavailable","error":"Conector de Claude no disponible. Revisa la sesión de Claude, /mcp y las herramientas de lectura configuradas."}));
        sources[key] = value;
    }
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn connector_allowlist_rejects_mutations_and_wildcards() {
        assert_eq!(source_for_tool("mcp__claude_ai_Gmail__gmail_search_messages"),Some("mail"));
        assert_eq!(source_for_tool("mcp__claude_ai_Google_Calendar__gcal_list_events"),Some("calendar"));
        for name in ["mcp__claude_ai_Gmail__gmail_send_message","mcp__claude_ai_Google_Calendar__gcal_create_event","mcp__Gmail__*","Bash","mcp__other__get_message"] { assert!(source_for_tool(name).is_none()); }
    }
}
