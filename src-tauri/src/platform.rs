//! Small platform boundary; no shell interpolation of user paths.
use std::path::PathBuf;
use std::process::{Command, Stdio};

pub const TERM: i32 = 15;
pub const KILL: i32 = 9;

pub fn local_now(zone: &str) -> Result<chrono::DateTime<chrono_tz::Tz>, String> {
    let zone = zone.parse::<chrono_tz::Tz>().map_err(|_| "Zona horaria IANA inválida")?;
    Ok(chrono::Utc::now().with_timezone(&zone))
}

pub fn signal_process_tree(pid: i32, signal: i32) {
    if pid <= 0 { return; }
    #[cfg(unix)] unsafe { libc::kill(-pid, signal); }
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        let _ = signal;
        let _ = Command::new("taskkill.exe").args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
}

#[cfg(windows)]
fn powershell(script: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new("powershell.exe");
    command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", script]);
    command.creation_flags(0x08000000);
    command
}

#[cfg(not(target_os = "macos"))]
pub fn open(arguments: &[&str]) -> Result<(), String> {
    // macOS-style call sites are intentionally narrowed to one target.
    let target = match arguments {
        [value] => *value,
        ["-t", value] => *value,
        ["-R", value] => *value,
        ["-a", _, value] => *value, // preferred browser falls back to user's browser
        _ => return Err("Este acceso a una aplicación de macOS no está disponible en Windows; usa su enlace web.".into()),
    };
    #[cfg(windows)] {
        let mut command = powershell("$ErrorActionPreference='Stop'; Start-Process -FilePath $env:ESPRIT_OPEN_TARGET");
        let target = if arguments.first()==Some(&"-R") { std::path::Path::new(target).parent().unwrap_or(std::path::Path::new(target)).to_string_lossy().to_string() } else { target.to_string() };
        let result = command.env("ESPRIT_OPEN_TARGET", target).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
        if result.status.success() { Ok(()) } else { Err("Windows no pudo abrir el destino".into()) }
    }
    #[cfg(not(windows))] {
        Command::new("xdg-open").arg(target).status().map_err(|e| e.to_string()).and_then(|s| if s.success() { Ok(()) } else { Err("No se pudo abrir el destino".into()) })
    }
}

pub fn save_dialog(default_name: &str) -> Result<Option<PathBuf>, String> {
    #[cfg(target_os = "macos")]
    let output = {
        let script = format!("var app=Application.currentApplication(); app.includeStandardAdditions=true; app.chooseFileName({{withPrompt:'Exportar copia de Esprit', defaultName:{}}}).toString();", serde_json::to_string(default_name).map_err(|e| e.to_string())?);
        Command::new("/usr/bin/osascript").args(["-l", "JavaScript", "-e", &script]).stdin(Stdio::null()).output()
    };
    #[cfg(windows)]
    let output = powershell("[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.SaveFileDialog; $d.Filter='JSON (*.json)|*.json'; $d.FileName=$env:ESPRIT_EXPORT_NAME; if($d.ShowDialog() -eq 'OK'){[Console]::Write($d.FileName)}").env("ESPRIT_EXPORT_NAME", default_name).stdin(Stdio::null()).output();
    #[cfg(not(any(windows, target_os = "macos")))]
    let output = Command::new("zenity").args(["--file-selection", "--save", "--filename", default_name]).output();
    let output = output.map_err(|e| e.to_string())?;
    if !output.status.success() {
        if String::from_utf8_lossy(&output.stderr).contains("-128") { return Ok(None); }
        return Err("No se pudo abrir el diálogo de exportación".into());
    }
    let path = String::from_utf8(output.stdout).map_err(|_| "Destino no válido")?;
    Ok(if path.trim().is_empty() { None } else { Some(PathBuf::from(path.trim())) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn time_zones_are_portable_and_validated() {
        assert!(local_now("Europe/Madrid").is_ok());
        assert!(local_now("America/New_York").is_ok());
        assert!(local_now("No/Such_Zone").is_err());
    }
    #[test] fn madrid_offsets_cover_winter_and_summer() {
        assert_eq!(crate::local_offset_at("Europe/Madrid", "2026-01-15T10:00:00").unwrap(), "+01:00");
        assert_eq!(crate::local_offset_at("Europe/Madrid", "2026-07-15T10:00:00").unwrap(), "+02:00");
        assert!(crate::local_offset_at("Europe/Madrid", "2026-03-29T02:30:00").is_err());
    }
    #[test] fn portable_configuration_and_read_only_connectors() {
        let fixture = crate::config::testing::fixture_with(|v| {
            let executable = std::env::current_exe().unwrap().to_string_lossy().to_string();
            v["tools"] = serde_json::json!({"claude": executable, "python3": executable});
            v["modules"] = serde_json::json!({"claude_connectors": {
                "enabled":true,"gmail":true,"calendar":true,"gmail_query":"label:UAM newer_than:7d",
                "calendar_ids":["primary"],"read_tools":["mcp__claude_ai_Gmail__gmail_search_messages","mcp__claude_ai_Google_Calendar__gcal_list_events"]
            }});
        });
        assert!(fixture.resolved.connectors().unwrap().gmail);
        assert!(!fixture.resolved.mail_enabled());
        assert!(fixture.resolved.calendar_write().is_empty());
        assert!(!crate::config::valid_relative_path("C:/outside"));
        assert!(!crate::config::valid_relative_path("folder\\..\\outside"));
    }
    #[test] fn process_locks_are_exclusive_and_released() {
        let root = crate::config::testing::unique_dir("esprit-lock");
        let path = root.join("lock");
        let first=std::fs::OpenOptions::new().read(true).write(true).create(true).open(&path).unwrap();
        let second=std::fs::OpenOptions::new().read(true).write(true).open(&path).unwrap();
        first.lock().unwrap(); assert!(second.try_lock().is_err());
        first.unlock().unwrap(); second.try_lock().unwrap(); second.unlock().unwrap();
        drop(first);drop(second);std::fs::remove_dir_all(root).unwrap();
    }

}
