//! Bounded, read-only view of a configured project's own STATE.md.
use serde::Serialize;
use std::{fs, io::Read, path::Path, time::UNIX_EPOCH};

const MAX_STATE_BYTES: u64 = 256 * 1024;

#[derive(Debug, Serialize)]
pub struct Summary {
    content: Option<String>,
    modified: Option<f64>,
}

fn read_state(root: &Path) -> Result<Summary, String> {
    let path = root.join("STATE.md");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Summary { content: None, modified: None }),
        Err(error) => return Err(format!("No se pudo leer STATE.md: {error}")),
        Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => return Err("STATE.md debe ser un archivo regular dentro del proyecto.".into()),
        Ok(_) => (),
    }
    let checked = crate::validate_confined_path(root, &path)?;
    let file = crate::open_regular_file_readonly(&checked, "STATE.md")?;
    let meta = file.metadata().map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_STATE_BYTES + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_STATE_BYTES { return Err("STATE.md supera 256 KB; ábrelo desde el explorador.".into()); }
    let content = String::from_utf8(bytes).map_err(|_| "STATE.md no contiene texto UTF-8 válido.")?;
    let modified = meta.modified().ok().and_then(|value| value.duration_since(UNIX_EPOCH).ok()).map(|value| value.as_secs_f64());
    Ok(Summary { content: Some(content), modified })
}

#[tauri::command]
pub async fn project_summary(project: String) -> Result<Summary, String> {
    let cfg = crate::config::current()?;
    let root = crate::verified_project_root(&cfg, &project)?;
    tauri::async_runtime::spawn_blocking(move || {
        cfg.access.ensure_active()?;
        read_state(&root)
    }).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("esprit-summary-{}", crate::new_plan_id()));
        fs::create_dir(&root).unwrap(); root.canonicalize().unwrap()
    }
    #[test]
    fn missing_state_does_not_create_or_change_project() {
        let root = fixture();
        assert!(read_state(&root).unwrap().content.is_none());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn bounded_utf8_state_is_preserved_exactly() {
        let root = fixture(); let path = root.join("STATE.md");
        let original = "# Tesis\n\n## Objetivo\nExplorar $x^2$ y estudiar difusión.\n";
        fs::write(&path, original).unwrap();
        assert_eq!(read_state(&root).unwrap().content.as_deref(), Some(original));
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        fs::write(&path, vec![b'x'; MAX_STATE_BYTES as usize + 1]).unwrap();
        assert!(read_state(&root).unwrap_err().contains("256 KB"));
        fs::write(&path, [0xff]).unwrap();
        assert!(read_state(&root).is_err());
        fs::remove_file(path).unwrap(); fs::remove_dir(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn state_symlink_is_rejected() {
        let root = fixture(); let path = root.join("STATE.md");
        fs::write(root.join("other.md"), "private fixture").unwrap();
        std::os::unix::fs::symlink("other.md", &path).unwrap();
        assert!(read_state(&root).is_err());
        fs::remove_file(path).unwrap(); fs::remove_file(root.join("other.md")).unwrap(); fs::remove_dir(root).unwrap();
    }
}
