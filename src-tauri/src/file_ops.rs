//! Reviewed, confined file management with opaque browser handles.
use super::{BrowserSession, BrowserEntry};
use serde::Deserialize;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

type Browsers = Arc<Mutex<HashMap<String, BrowserSession>>>;

pub const MAX_IMPORT_BYTES: usize = 80 * 1_048_576;
#[cfg(target_os = "macos")]
const TRASH: &str = "/usr/bin/trash";

#[derive(Deserialize)]
pub struct RenameRequest {
    pub session_id: String,
    pub entry_id: String,
    pub name: String,
    pub confirmed: bool,
}

#[derive(Deserialize)]
pub struct TrashRequest {
    pub session_id: String,
    pub entry_id: String,
    pub confirmed: bool,
}

#[derive(Deserialize)]
pub struct ImportRequest {
    pub session_id: String,
    pub directory_id: String,
    pub name: String,
    pub data_base64: String,
    pub confirmed: bool,
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
}

/// Atomic rename that fails instead of replacing an existing entry. The destination is never replaced.
pub fn rename_exclusive(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let source = CString::new(from.as_os_str().as_bytes()).map_err(|_| "Ruta no válida")?;
        let target = CString::new(to.as_os_str().as_bytes()).map_err(|_| "Ruta no válida")?;
        if unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) } == 0 { return Ok(()); }
        Err(format!("No se pudo renombrar sin reemplazar otra entrada: {}", std::io::Error::last_os_error()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" { fn MoveFileW(existing: *const u16, new: *const u16) -> i32; }
        let source: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileW(source.as_ptr(), target.as_ptr()) } != 0 { Ok(()) }
        else { Err(format!("No se pudo renombrar sin reemplazar otra entrada: {}", std::io::Error::last_os_error())) }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    { let _ = (from, to); Err("Renombrado no disponible en este sistema".into()) }
}

/// Moves one file or folder to the system Trash; nothing is unlinked.
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| format!("No se pudo inspeccionar la entrada: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("Esprit no mueve enlaces simbólicos a la Papelera".into());
    }
    #[cfg(target_os = "macos")]
    let status = Command::new(TRASH).arg(path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    #[cfg(windows)]
    let status = {
        use std::os::windows::process::CommandExt;
        Command::new("powershell.exe").args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            "$ErrorActionPreference='Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; if([System.IO.Directory]::Exists($env:ESPRIT_TRASH_PATH)){[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:ESPRIT_TRASH_PATH,'OnlyErrorDialogs','SendToRecycleBin','ThrowException')}else{[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:ESPRIT_TRASH_PATH,'OnlyErrorDialogs','SendToRecycleBin','ThrowException')}"])
            .env("ESPRIT_TRASH_PATH", path).creation_flags(0x08000000).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status()
    };
    #[cfg(not(any(windows, target_os = "macos")))]
    let status: Result<std::process::ExitStatus, std::io::Error> = Err(std::io::Error::other("Papelera no disponible"));
    let status = status.map_err(|e| format!("No se pudo usar la Papelera: {e}"))?;
    if status.success() && fs::symlink_metadata(path).is_err() { Ok(()) } else { Err("No se pudo mover a la Papelera".into()) }

}

/// `name (2).ext`, `name (3).ext`… for the first free name in `directory`.
pub fn free_name(directory: &Path, name: &str) -> Option<String> {
    if fs::symlink_metadata(directory.join(name)).is_err() {
        return Some(name.to_string());
    }
    let (stem, extension) = match name.rfind('.') {
        Some(index) if index > 0 => (&name[..index], &name[index..]),
        _ => (name, ""),
    };
    (2..=99).map(|index| format!("{stem} ({index}){extension}")).find(|candidate| fs::symlink_metadata(directory.join(candidate)).is_err())
}

/// Writes bytes to `directory/name` (or the next free name) without ever
/// replacing an existing file; returns the final path.
pub fn publish_new_file(directory: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let final_name = free_name(directory, name).ok_or("Hay demasiados archivos con ese nombre")?;
    let target = directory.join(&final_name);
    let temporary = directory.join(format!(".esprit-import-{}.tmp", super::new_plan_id()));
    let result = (|| -> std::io::Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.custom_flags(libc::O_NOFOLLOW).mode(0o644);
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(format!("No se pudo guardar el archivo: {error}"));
    }
    if let Err(error) = fs::hard_link(&temporary, &target) {
        let _ = fs::remove_file(&temporary);
        return Err(if error.kind() == std::io::ErrorKind::AlreadyExists { "Ya existe un archivo con ese nombre".into() } else { format!("No se pudo publicar el archivo: {error}") });
    }
    let _ = fs::remove_file(&temporary);
    Ok(target)
}

fn entry_for(id: String, name: String, kind: &str, path: &Path) -> Result<BrowserEntry, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| format!("No se pudo verificar la entrada: {error}"))?;
    let modified = metadata.modified().ok().and_then(|value| value.duration_since(UNIX_EPOCH).ok()).map(|value| value.as_secs_f64()).unwrap_or(0.0);
    Ok(BrowserEntry { id, name, kind: kind.to_string(), size: if metadata.is_file() { metadata.len() } else { 0 }, modified, sensitive: false })
}

/// Locks the browsers, checks the session is alive and runs `work` on it.
fn with_session<T>(browsers: &Browsers, session_id: &str, work: impl FnOnce(&mut BrowserSession) -> Result<T, String>) -> Result<T, String> {
    super::validate_plan_id(session_id).map_err(|_| "Sesión del explorador no válida".to_string())?;
    let mut guard = browsers.lock().map_err(|_| "No se pudo bloquear el explorador".to_string())?;
    if guard.get(session_id).is_some_and(|session| now_ms().saturating_sub(session.created_at) > super::BROWSER_TTL_MS) {
        guard.remove(session_id);
        return Err("La sesión del explorador caducó; vuelve a abrir la carpeta".into());
    }
    let session = guard.get_mut(session_id).ok_or("La sesión del explorador ya no existe")?;
    work(session)
}

/// Resolves a file or folder of the session that is not the root itself.
fn confined_entry(session: &BrowserSession, entry_id: &str) -> Result<(PathBuf, String), String> {
    super::validate_plan_id(entry_id).map_err(|_| "Entrada no válida".to_string())?;
    let node = session.nodes.get(entry_id).ok_or("La entrada no pertenece a esta sesión")?;
    if !matches!(node.kind.as_str(), "file" | "directory") {
        return Err("Solo se pueden gestionar archivos y carpetas".into());
    }
    let path = super::validate_confined_path(&session.root, &node.path).map_err(|error| error.replace("del viaje", "del explorador"))?;
    if path == session.root {
        return Err("La carpeta raíz no se puede renombrar ni borrar desde Esprit".into());
    }
    Ok((path, node.kind.clone()))
}

pub fn rename_entry(request: RenameRequest, browsers: &Browsers) -> Result<BrowserEntry, String> {
    if !request.confirmed {
        return Err("Renombrar requiere confirmación".into());
    }
    super::validate_project_entry_name(&request.name)?;
    with_session(browsers, &request.session_id, |session| {
        let (path, kind) = confined_entry(session, &request.entry_id)?;
        let target = path.parent().ok_or("Entrada sin carpeta")?.join(&request.name);
        if target == path {
            return Err("El nombre no ha cambiado".into());
        }
        if super::sensitive_path(&target) {
            return Err("Esprit no usa nombres sensibles".into());
        }
        if kind == "directory" && request.name.to_ascii_lowercase().ends_with(".app") {
            return Err("Esprit no crea paquetes .app".into());
        }
        rename_exclusive(&path, &target)?;
        // Handles below a renamed folder keep working under the new path.
        for node in session.nodes.values_mut() {
            if let Ok(rest) = node.path.strip_prefix(&path) {
                node.path = if rest.as_os_str().is_empty() { target.clone() } else { target.join(rest) };
            }
        }
        entry_for(request.entry_id.clone(), request.name.clone(), &kind, &target)
    })
}

pub fn trash_entry(request: TrashRequest, browsers: &Browsers) -> Result<(), String> {
    if !request.confirmed {
        return Err("Mover a la Papelera requiere confirmación".into());
    }
    with_session(browsers, &request.session_id, |session| {
        let (path, _) = confined_entry(session, &request.entry_id)?;
        move_to_trash(&path)?;
        session.nodes.retain(|_, node| !node.path.starts_with(&path));
        Ok(())
    })
}

pub fn import_file(request: ImportRequest, browsers: &Browsers) -> Result<BrowserEntry, String> {
    if !request.confirmed {
        return Err("Añadir archivos requiere confirmación".into());
    }
    super::validate_project_entry_name(&request.name)?;
    let bytes = super::decode_base64_limited(&request.data_base64, MAX_IMPORT_BYTES)?;
    with_session(browsers, &request.session_id, |session| {
        super::validate_plan_id(&request.directory_id).map_err(|_| "Carpeta no válida".to_string())?;
        let node = session.nodes.get(&request.directory_id).cloned().ok_or("La carpeta no pertenece a esta sesión")?;
        if node.kind != "directory" {
            return Err("La entrada seleccionada no es una carpeta".into());
        }
        if session.nodes.len() >= super::MAX_BROWSER_NODES {
            return Err("La sesión alcanzó su límite; vuelve a abrir la carpeta".into());
        }
        let directory = super::validate_confined_path(&session.root, &node.path).map_err(|error| error.replace("del viaje", "del explorador"))?;
        if super::sensitive_path(&directory.join(&request.name)) {
            return Err("Esprit no añade archivos con nombres sensibles".into());
        }
        let target = publish_new_file(&directory, &request.name, &bytes)?;
        let name = target.file_name().and_then(|value| value.to_str()).unwrap_or(&request.name).to_string();
        let id = super::register_browser_node(session, target.clone(), "file".into(), false)?;
        entry_for(id, name, "file", &target)
    })
}

/// Shows the entry in the system file explorer.
pub fn reveal_entry(session_id: &str, entry_id: &str, browsers: &Browsers) -> Result<(), String> {
    with_session(browsers, session_id, |session| {
        let (path, _) = confined_entry(session, entry_id)?;
        super::open_with_macos(&["-R", path.to_string_lossy().as_ref()])
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_and_renames_preserve_existing_data() {
        let root = super::super::config::testing::unique_dir("esprit-file-ops");
        fs::write(root.join("notes.txt"), b"original").unwrap();
        let copy = publish_new_file(&root, "notes.txt", b"new").unwrap();
        assert_eq!(copy.file_name().unwrap(), "notes (2).txt");
        assert_eq!(fs::read(root.join("notes.txt")).unwrap(), b"original");
        assert!(rename_exclusive(&copy, &root.join("notes.txt")).is_err());
        assert_eq!(fs::read(&copy).unwrap(), b"new");
        #[cfg(any(windows, target_os="macos"))]
        { rename_exclusive(&copy, &root.join("renamed.txt")).unwrap();
          assert_eq!(fs::read(root.join("renamed.txt")).unwrap(), b"new"); }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("missing.txt"), root.join("link.txt")).unwrap();
            assert!(publish_new_file(&root, "link.txt", b"safe").unwrap().ends_with("link (2).txt"));
            assert!(!root.join("missing.txt").exists());
        }
        fs::remove_dir_all(root).unwrap();
    }
}
