//! Reviewed, confined file management with opaque browser handles.
use super::{BrowserSession, BrowserEntry};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
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

pub const MAX_TRANSFER_ENTRIES: usize = 50;

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TransferOperation { Copy, Move }

/// The clipboard contains opaque handles only; paths never cross the bridge.
#[derive(Deserialize)]
pub struct TransferRequest {
    pub session_id: String,
    pub entry_ids: Vec<String>,
    pub directory_id: String,
    pub operation: TransferOperation,
    pub confirmed: bool,
}

#[derive(Serialize)]
pub struct TransferReply {
    pub completed: Vec<String>,
    pub error: Option<String>,
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
    session.access.ensure_active()?;
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

fn is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() { return true; }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions and other reparse points must not bypass the browser root.
        if metadata.file_attributes() & 0x400 != 0 { return true; }
    }
    false
}

fn transfer_path(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let resolved = super::validate_confined_path(root, path)?;
    let mut checked = root.to_path_buf();
    for component in path.strip_prefix(root).map_err(|_| "La entrada queda fuera del proyecto")?.components() {
        checked.push(component);
        let metadata = fs::symlink_metadata(&checked).map_err(|error| format!("No se pudo inspeccionar la entrada: {error}"))?;
        if is_link(&metadata) { return Err("Esprit no transfiere enlaces simbólicos ni uniones de carpetas".into()); }
    }
    Ok(resolved)
}

fn target_is_free(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(format!("No se pudo comprobar el destino: {error}")),
    }
}

/// Preserve the operating system's downloaded-file marker before publication.
/// Failure to preserve an existing marker must never produce an unmarked copy.
fn preserve_origin_marker(_input: &fs::File, _source: &Path, _output: &fs::File, _temporary: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        let name = c"com.apple.quarantine";
        let size = unsafe { libc::fgetxattr(_input.as_raw_fd(), name.as_ptr(), std::ptr::null_mut(), 0, 0, 0) };
        if size < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ENOATTR) { return Ok(()); }
            return Err(format!("No se pudo comprobar la cuarentena del archivo: {error}"));
        }
        if size > 65_536 { return Err("La marca de cuarentena es demasiado grande".into()); }
        let mut marker = vec![0_u8; size as usize];
        let read = unsafe { libc::fgetxattr(_input.as_raw_fd(), name.as_ptr(), marker.as_mut_ptr().cast(), marker.len(), 0, 0) };
        if read < 0 { return Err(format!("No se pudo leer la cuarentena del archivo: {}", std::io::Error::last_os_error())); }
        marker.truncate(read as usize);
        if unsafe { libc::fsetxattr(_output.as_raw_fd(), name.as_ptr(), marker.as_ptr().cast(), marker.len(), 0, 0) } != 0 {
            return Err(format!("No se pudo conservar la cuarentena del archivo: {}", std::io::Error::last_os_error()));
        }
    }
    #[cfg(windows)]
    {
        let stream_path = |path: &Path| { let mut value = path.as_os_str().to_os_string(); value.push(":Zone.Identifier"); PathBuf::from(value) };
        let stream = match fs::File::open(stream_path(_source)) {
            Ok(stream) => stream,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("No se pudo comprobar la marca de descarga: {error}")),
        };
        let mut marker = Vec::new();
        stream.take(65_537).read_to_end(&mut marker).map_err(|error| format!("No se pudo leer la marca de descarga: {error}"))?;
        if marker.len() > 65_536 { return Err("La marca de descarga es demasiado grande".into()); }
        let mut output = OpenOptions::new().write(true).create_new(true).open(stream_path(_temporary)).map_err(|error| format!("No se pudo conservar la marca de descarga: {error}"))?;
        output.write_all(&marker).and_then(|_| output.sync_all()).map_err(|error| format!("No se pudo guardar la marca de descarga: {error}"))?;
    }
    Ok(())
}

/// Bound the copy, publish atomically without replacement, and keep the source.
/// A temporary file resides on the target volume, including on Windows.
fn copy_exclusive(source: &Path, target: &Path) -> Result<(), String> {
    let temporary = target.parent().ok_or("Destino sin carpeta")?.join(format!(".esprit-copy-{}.tmp", super::new_plan_id()));
    let mut created = false;
    let result = (|| -> Result<(), String> {
        let mut input_options = OpenOptions::new();
        input_options.read(true);
        #[cfg(unix)]
        input_options.custom_flags(libc::O_NOFOLLOW);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            input_options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
        }
        let mut input = input_options.open(source).map_err(|error| format!("No se pudo leer el archivo: {error}"))?;
        let before = input.metadata().map_err(|error| format!("No se pudo inspeccionar el archivo: {error}"))?;
        if !before.is_file() || is_link(&before) { return Err("Solo se copian archivos normales, sin enlaces".into()); }
        if before.len() > MAX_IMPORT_BYTES as u64 { return Err("El archivo supera los 80 MB; usa el explorador del sistema".into()); }
        let mut output_options = OpenOptions::new();
        output_options.write(true).create_new(true);
        // The unfinished copy must never expose a private source through umask.
        #[cfg(unix)]
        output_options.mode(0o600);
        let mut output = output_options.open(&temporary).map_err(|error| format!("No se pudo crear la copia: {error}"))?;
        created = true;
        let copied = std::io::copy(&mut (&mut input).take(MAX_IMPORT_BYTES as u64 + 1), &mut output).map_err(|error| format!("No se pudo copiar el archivo: {error}"))?;
        let after = fs::symlink_metadata(source).map_err(|error| format!("El archivo cambió durante la copia: {error}"))?;
        if copied != before.len() || copied > MAX_IMPORT_BYTES as u64 || is_link(&after) || after.len() != before.len() || after.modified().ok() != before.modified().ok() {
            return Err("El archivo cambió durante la copia; vuelve a revisarlo".into());
        }
        preserve_origin_marker(&input, source, &output, &temporary)?;
        #[cfg(unix)]
        let permissions = {
            use std::os::unix::fs::PermissionsExt;
            // Preserve ordinary rwx bits, never confer setuid/setgid on a copy.
            fs::Permissions::from_mode(before.permissions().mode() & 0o777)
        };
        #[cfg(not(unix))]
        let permissions = before.permissions();
        output.set_permissions(permissions).map_err(|error| format!("No se pudieron conservar los permisos del archivo: {error}"))?;
        output.sync_all().map_err(|error| format!("No se pudo guardar la copia: {error}"))?;
        drop(output);
        // Native exclusive rename preserves Windows readonly + streams without
        // leaving a second readonly hard link that cannot be removed normally.
        #[cfg(any(windows, target_os = "macos"))]
        { rename_exclusive(&temporary, target) }
        // hard_link fails if a file, directory or dangling link appeared since review.
        #[cfg(not(any(windows, target_os = "macos")))]
        { fs::hard_link(&temporary, target).map_err(|error| format!("No se pudo publicar la copia sin reemplazar: {error}")) }
    })();
    if created {
        #[cfg(windows)]
        if let Ok(metadata) = fs::symlink_metadata(&temporary) {
            if metadata.is_file() && !is_link(&metadata) && metadata.permissions().readonly() {
                // Only our unpublished temporary is unlocked; source/destination
                // keep their original attributes even when publication fails.
                let mut permissions = metadata.permissions();
                permissions.set_readonly(false);
                let _ = fs::set_permissions(&temporary, permissions);
            }
        }
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Check the entire selection before the first write. Later I/O failures return
/// the exact completed subset so callers cannot mistake a partial batch for success.
pub fn transfer_entries(request: TransferRequest, browsers: &Browsers) -> Result<TransferReply, String> {
    if !request.confirmed { return Err("Copiar o mover requiere revisión y confirmación".into()); }
    if request.entry_ids.is_empty() || request.entry_ids.len() > MAX_TRANSFER_ENTRIES {
        return Err(format!("Selecciona entre 1 y {MAX_TRANSFER_ENTRIES} elementos"));
    }
    with_session(browsers, &request.session_id, |session| {
        super::validate_plan_id(&request.directory_id).map_err(|_| "Carpeta no válida")?;
        let node = session.nodes.get(&request.directory_id).ok_or("La carpeta no pertenece a esta sesión")?;
        if node.kind != "directory" { return Err("El destino no es una carpeta".into()); }
        let destination = transfer_path(&session.root, &node.path)?;
        if !destination.is_dir() { return Err("La carpeta de destino cambió; vuelve a abrirla".into()); }
        let mut seen = HashSet::new();
        let mut plan = Vec::new();
        let mut copy_bytes = 0_u64;
        for id in &request.entry_ids {
            if !seen.insert(id) { continue; }
            let (_, kind) = confined_entry(session, id)?;
            // Inspect the stored path too: canonicalizing first would hide a
            // Windows junction that points to a second location inside root.
            let source = transfer_path(&session.root, &session.nodes[id].path)?;
            let name = source.file_name().and_then(|name| name.to_str()).ok_or("Nombre de archivo no válido")?.to_owned();
            super::validate_project_entry_name(&name)?;
            let metadata = fs::symlink_metadata(&source).map_err(|error| format!("No se pudo inspeccionar {name}: {error}"))?;
            if (kind == "file" && !metadata.is_file()) || (kind == "directory" && !metadata.is_dir()) || is_link(&metadata) {
                return Err(format!("{name} cambió de tipo; vuelve a abrir la carpeta"));
            }
            if request.operation == TransferOperation::Copy {
                if kind != "file" { return Err("Solo se copian archivos; para carpetas usa Cortar y Mover aquí".into()); }
                copy_bytes = copy_bytes.saturating_add(metadata.len());
                if copy_bytes > MAX_IMPORT_BYTES as u64 { return Err("La selección supera los 80 MB; copia menos archivos cada vez".into()); }
            }
            if source.parent() == Some(destination.as_path()) { return Err(format!("{name} ya está en esa carpeta")); }
            if destination.starts_with(&source) { return Err(format!("No se puede mover {name} dentro de sí misma")); }
            let target = destination.join(&name);
            if super::sensitive_path(&source) || super::sensitive_path(&target) || session.nodes.get(id).is_some_and(|node| node.sensitive) {
                return Err(format!("{name} tiene un nombre sensible y no se transfiere desde Esprit"));
            }
            if !target_is_free(&target)? || plan.iter().any(|(_, other, _): &(PathBuf, PathBuf, String)| other == &target) {
                return Err(format!("Ya existe {name} en el destino; no se ha transferido nada"));
            }
            plan.push((source, target, name));
        }
        // A folder selection already includes everything below it. Requiring
        // one selection avoids surprising extra operations and ordering effects.
        if plan.iter().any(|(source, _, _)| plan.iter().any(|(other, _, _)| source != other && source.starts_with(other))) {
            return Err("Selecciona la carpeta o sus elementos, no ambos a la vez".into());
        }
        let mut completed = Vec::new();
        for (source, target, name) in plan {
            let result = (|| {
                // Revalidate each entry and destination after earlier operations.
                transfer_path(&session.root, &source)?;
                transfer_path(&session.root, &destination)?;
                if !target_is_free(&target)? { return Err("El destino ahora contiene una entrada con ese nombre".into()); }
                if request.operation == TransferOperation::Copy { copy_exclusive(&source, &target) }
                else { rename_exclusive(&source, &target) }
            })();
            if let Err(error) = result { return Ok(TransferReply { completed, error: Some(format!("{name}: {error}")) }); }
            if request.operation == TransferOperation::Move {
                for node in session.nodes.values_mut() {
                    if let Ok(rest) = node.path.strip_prefix(&source) { node.path = target.join(rest); }
                }
            }
            completed.push(name);
        }
        Ok(TransferReply { completed, error: None })
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
    use super::super::{BrowserNode, new_plan_id};

    fn fixture(root: &Path, entries: &[(&str, &str)]) -> (Browsers, String, Vec<String>) {
        let root = root.canonicalize().unwrap();
        let ids: Vec<String> = entries.iter().enumerate().map(|(index, _)| format!("{}-{index:x}", new_plan_id())).collect();
        let nodes = entries.iter().zip(&ids).map(|((name, kind), id)| (id.clone(), BrowserNode { path: root.join(name), kind: kind.to_string(), sensitive: false })).collect();
        let session_id = new_plan_id();
        let browsers = Arc::new(Mutex::new(HashMap::from([(session_id.clone(), BrowserSession { access: super::super::config::AccessToken::default(), root_label: "Fixture".into(), root, nodes, created_at: now_ms() })])));
        (browsers, session_id, ids)
    }

    fn request(session: &str, sources: &[&String], destination: &str, operation: TransferOperation) -> TransferRequest {
        TransferRequest { session_id: session.into(), entry_ids: sources.iter().map(|id| (*id).clone()).collect(), directory_id: destination.into(), operation, confirmed: true }
    }

    #[test]
    fn revoked_access_prevents_file_operations_before_work_runs() {
        let root = super::super::config::testing::unique_dir("esprit-revoked-file-ops");
        let (browsers, session_id, _) = fixture(&root, &[]);
        browsers.lock().unwrap().get(&session_id).unwrap().access.revoke();
        let called = std::cell::Cell::new(false);
        let result = with_session(&browsers, &session_id, |_| {
            called.set(true);
            Ok(())
        });
        assert!(result.unwrap_err().contains("configuración cambió"));
        assert!(!called.get());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn transfer_checks_confirmation_handles_and_the_entire_batch_before_writing() {
        let root = super::super::config::testing::unique_dir("esprit-transfer-copy");
        fs::create_dir(root.join("destination")).unwrap();
        fs::write(root.join("a.txt"), b"alpha").unwrap();
        fs::write(root.join("b.txt"), b"beta").unwrap();
        fs::write(root.join(".env"), b"synthetic fixture").unwrap();
        fs::write(root.join("destination/b.txt"), b"existing").unwrap();
        let (browsers, session, ids) = fixture(&root, &[("a.txt", "file"), ("b.txt", "file"), ("destination", "directory"), ("", "directory"), (".env", "file")]);
        let copy = |sources: &[&String], destination: &str| request(&session, sources, destination, TransferOperation::Copy);
        assert!(transfer_entries(TransferRequest { confirmed: false, ..copy(&[&ids[0]], &ids[2]) }, &browsers).is_err());
        assert!(transfer_entries(copy(&[&new_plan_id()], &ids[2]), &browsers).is_err());
        assert!(transfer_entries(copy(&[&ids[0]], &new_plan_id()), &browsers).is_err());
        assert!(transfer_entries(copy(&[&ids[3]], &ids[2]), &browsers).is_err());
        assert!(transfer_entries(copy(&[&ids[4]], &ids[2]), &browsers).is_err());
        assert!(transfer_entries(copy(&[&ids[0]], &ids[3]), &browsers).is_err());
        assert!(transfer_entries(copy(&[&ids[0], &ids[1]], &ids[2]), &browsers).is_err());
        assert!(!root.join("destination/a.txt").exists());
        assert_eq!(fs::read(root.join("destination/b.txt")).unwrap(), b"existing");
        let result = transfer_entries(copy(&[&ids[0], &ids[0]], &ids[2]), &browsers).unwrap();
        assert_eq!(result.completed, vec!["a.txt"]);
        assert!(result.error.is_none());
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"alpha");
        assert_eq!(fs::read(root.join("destination/a.txt")).unwrap(), b"alpha");
        assert!(copy_exclusive(&root.join("b.txt"), &root.join("destination/a.txt")).is_err());
        assert_eq!(fs::read(root.join("destination/a.txt")).unwrap(), b"alpha");
        assert!(!fs::read_dir(root.join("destination")).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".esprit-copy-")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn transfers_reject_oversized_files_and_foreign_or_traversing_nodes() {
        let root = super::super::config::testing::unique_dir("esprit-transfer-boundaries");
        fs::create_dir(root.join("destination")).unwrap();
        fs::write(root.join("a.txt"), b"alpha").unwrap();
        OpenOptions::new().write(true).open(root.join("a.txt")).unwrap().set_len(MAX_IMPORT_BYTES as u64 + 1).unwrap();
        let (browsers, session, ids) = fixture(&root, &[("a.txt", "file"), ("destination", "directory")]);
        assert!(transfer_entries(request(&session, &[&ids[0]], &ids[1], TransferOperation::Copy), &browsers).is_err());
        fs::write(root.join("a.txt"), b"alpha").unwrap();
        let foreign = new_plan_id();
        assert!(transfer_entries(request(&foreign, &[&ids[0]], &ids[1], TransferOperation::Copy), &browsers).is_err());
        // PathBuf::join normalizes parent segments on Windows verbatim paths.
        // Preserve the untrusted spelling so this test actually reaches the guard.
        let mut raw = root.as_os_str().to_os_string();
        let sep = std::path::MAIN_SEPARATOR;
        raw.push(format!("{sep}destination{sep}..{sep}a.txt"));
        let traversal = PathBuf::from(raw);
        assert!(traversal.components().any(|part| part == std::path::Component::ParentDir));
        browsers.lock().unwrap().get_mut(&session).unwrap().nodes.get_mut(&ids[0]).unwrap().path = traversal;
        assert!(transfer_entries(request(&session, &[&ids[0]], &ids[1], TransferOperation::Copy), &browsers).is_err());
        assert!(!root.join("destination/a.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn moves_reject_ancestor_selections_and_self_moves_then_update_child_handles() {
        let root = super::super::config::testing::unique_dir("esprit-transfer-move");
        fs::create_dir_all(root.join("folder/child")).unwrap();
        fs::create_dir(root.join("destination")).unwrap();
        fs::write(root.join("folder/child/note.txt"), b"keep").unwrap();
        let (browsers, session, ids) = fixture(&root, &[("folder", "directory"), ("folder/child", "directory"), ("folder/child/note.txt", "file"), ("destination", "directory")]);
        assert!(transfer_entries(request(&session, &[&ids[0]], &ids[1], TransferOperation::Move), &browsers).is_err());
        assert!(transfer_entries(request(&session, &[&ids[0], &ids[2]], &ids[3], TransferOperation::Move), &browsers).is_err());
        let result = transfer_entries(request(&session, &[&ids[0]], &ids[3], TransferOperation::Move), &browsers).unwrap();
        assert_eq!(result.completed, vec!["folder"]);
        assert!(result.error.is_none());
        assert!(!root.join("folder").exists());
        assert_eq!(fs::read(root.join("destination/folder/child/note.txt")).unwrap(), b"keep");
        assert_eq!(browsers.lock().unwrap()[&session].nodes[&ids[2]].path, root.canonicalize().unwrap().join("destination/folder/child/note.txt"));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn transfer_rejects_symlink_sources_destinations_and_parents() {
        let root = super::super::config::testing::unique_dir("esprit-transfer-links");
        fs::create_dir(root.join("destination")).unwrap();
        fs::write(root.join("a.txt"), b"alpha").unwrap();
        std::os::unix::fs::symlink(root.join("a.txt"), root.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(root.join("destination"), root.join("alias")).unwrap();
        let (browsers, session, ids) = fixture(&root, &[("a.txt", "file"), ("link.txt", "file"), ("alias", "directory"), ("destination", "directory")]);
        assert!(transfer_entries(request(&session, &[&ids[1]], &ids[3], TransferOperation::Copy), &browsers).is_err());
        assert!(transfer_entries(request(&session, &[&ids[0]], &ids[2], TransferOperation::Copy), &browsers).is_err());
        std::os::unix::fs::symlink(root.join("missing"), root.join("destination/a.txt")).unwrap();
        assert!(transfer_entries(request(&session, &[&ids[0]], &ids[3], TransferOperation::Copy), &browsers).is_err());
        assert!(!root.join("missing").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn transfer_reports_permission_failure_without_removing_the_source() {
        use std::os::unix::fs::PermissionsExt;
        let root = super::super::config::testing::unique_dir("esprit-transfer-permission");
        fs::create_dir(root.join("destination")).unwrap();
        fs::write(root.join("a.txt"), b"keep").unwrap();
        let (browsers, session, ids) = fixture(&root, &[("a.txt", "file"), ("destination", "directory")]);
        fs::set_permissions(root.join("destination"), fs::Permissions::from_mode(0o500)).unwrap();
        let result = transfer_entries(request(&session, &[&ids[0]], &ids[1], TransferOperation::Copy), &browsers).unwrap();
        fs::set_permissions(root.join("destination"), fs::Permissions::from_mode(0o700)).unwrap();
        // Root can write despite mode bits (some CI containers run as root).
        if unsafe { libc::geteuid() } != 0 {
            assert!(result.completed.is_empty());
            assert!(result.error.is_some());
            assert!(!root.join("destination/a.txt").exists());
        }
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"keep");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn copies_preserve_private_and_executable_permission_bits() {
        use std::os::unix::fs::PermissionsExt;
        let root = super::super::config::testing::unique_dir("esprit-transfer-modes");
        for mode in [0o600, 0o755, 0o444] {
            let source = root.join(format!("source-{mode:o}.txt"));
            let target = root.join(format!("copy-{mode:o}.txt"));
            fs::write(&source, b"synthetic private data").unwrap();
            fs::set_permissions(&source, fs::Permissions::from_mode(mode)).unwrap();
            copy_exclusive(&source, &target).unwrap();
            assert_eq!(fs::metadata(&source).unwrap().permissions().mode() & 0o777, mode);
            assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o777, mode);
            assert_eq!(fs::read(&target).unwrap(), b"synthetic private data");
        }
        assert!(!fs::read_dir(&root).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".esprit-copy-")));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn copies_preserve_readonly_and_clean_failed_readonly_temporaries() {
        let root = super::super::config::testing::unique_dir("esprit-transfer-readonly");
        let source = root.join("source.txt");
        let target = root.join("copy.txt");
        let occupied = root.join("occupied.txt");
        fs::write(&source, b"original").unwrap();
        fs::write(&occupied, b"existing").unwrap();
        let mut permissions = fs::metadata(&source).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&source, permissions).unwrap();
        copy_exclusive(&source, &target).unwrap();
        assert!(fs::metadata(&source).unwrap().permissions().readonly());
        assert!(fs::metadata(&target).unwrap().permissions().readonly());
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert!(copy_exclusive(&source, &occupied).is_err());
        assert_eq!(fs::read(&occupied).unwrap(), b"existing");
        assert!(!fs::metadata(&occupied).unwrap().permissions().readonly());
        assert!(!fs::read_dir(&root).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".esprit-copy-")));
        for path in [&source, &target] {
            let mut permissions = fs::metadata(path).unwrap().permissions();
            permissions.set_readonly(false);
            fs::set_permissions(path, permissions).unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn copied_downloads_keep_their_operating_system_origin_marker() {
        let root = super::super::config::testing::unique_dir("esprit-transfer-origin");
        let source = root.join("source.txt");
        let target = root.join("copy.txt");
        fs::write(&source, b"synthetic attachment").unwrap();
        super::super::mark_downloaded(&source);
        copy_exclusive(&source, &target).unwrap();
        #[cfg(target_os = "macos")]
        {
            use std::os::fd::AsRawFd;
            let read = |path: &Path| {
                let input = fs::File::open(path).unwrap();
                let mut value = vec![0_u8; 1024];
                let size = unsafe { libc::fgetxattr(input.as_raw_fd(), c"com.apple.quarantine".as_ptr(), value.as_mut_ptr().cast(), value.len(), 0, 0) };
                assert!(size > 0, "download marker exists");
                value.truncate(size as usize); value
            };
            assert_eq!(read(&source), read(&target));
        }
        #[cfg(windows)]
        {
            let stream = |path: &Path| { let mut value = path.as_os_str().to_os_string(); value.push(":Zone.Identifier"); PathBuf::from(value) };
            let original = fs::read(stream(&source)).unwrap();
            assert!(!original.is_empty());
            assert_eq!(original, fs::read(stream(&target)).unwrap());
        }
        assert_eq!(fs::read(&target).unwrap(), b"synthetic attachment");
        fs::remove_dir_all(root).unwrap();
    }

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
