//! Configuración de Esprit: carga, validación y estado global.
//!
//! El archivo vive en `~/.config/esprit/config.json` (o en la ruta de
//! `ESPRIT_CONFIG`). El esquema de referencia es `config/esprit.schema.json`:
//! los nombres de campo son el contrato y aquí no se cambian. Todas las
//! allowlists (proyectos, repos, calendarios, enlaces, alias SSH, raíz remota)
//! salen de esta configuración y nunca del frontend.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, RwLock};

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_CONFIG_BYTES: u64 = 256 * 1024;
pub const DEFAULT_PYTHON3: &str = if cfg!(windows) { "python.exe" } else { "/usr/bin/python3" };
const LINK_ICONS: &[&str] = &[
    "overleaf",
    "vscode",
    "obsidian",
    "mattermost",
    "chatgpt",
    "zotero",
    "github",
    "drive",
    "notion",
    "slack",
];

fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    // Con `deserialize_with` y sin `default`, serde exige que la clave exista
    // aunque su valor pueda ser null (así se modela `tools.claude`).
    Option::<T>::deserialize(deserializer)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub version: u64,
    pub user: UserConfig,
    pub time_zone: String,
    pub workspace: String,
    #[serde(default)]
    pub source_repo: Option<String>,
    pub tools: ToolsConfig,
    pub projects: Vec<ProjectConfig>,
    #[serde(default)]
    pub milestones: Vec<MilestoneConfig>,
    #[serde(default)]
    pub links: Vec<LinkConfig>,
    pub modules: ModulesConfig,
    #[serde(default)]
    pub appearance: AppearanceConfig,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UserConfig {
    pub name: String,
    pub short_name: String,
    pub initials: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ToolsConfig {
    #[serde(deserialize_with = "nullable")]
    pub claude: Option<String>,
    #[serde(default)]
    pub codex: Option<String>,
    #[serde(default)]
    pub gh: Option<String>,
    #[serde(default)]
    pub python3: Option<String>,
    #[serde(default)]
    pub latexmk: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectConfig {
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub short_name: Option<String>,
    #[serde(default)]
    pub tag: Option<String>,
    pub folder: String,
    #[serde(default)]
    pub github_repos: Vec<String>,
    #[serde(default)]
    pub library_collection: Option<String>,
    #[serde(default)]
    pub cluster_dir: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MilestoneConfig {
    pub title: String,
    pub date: String,
    #[serde(default)]
    pub meta: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LinkConfig {
    pub label: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub app: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModulesConfig {
    #[serde(default)]
    pub claude_connectors: Option<ClaudeConnectors>,
    #[serde(default)]
    pub travel: Option<LibraryModule>,
    #[serde(default)]
    pub mail: Option<MailModule>,
    #[serde(default)]
    pub calendar: Option<CalendarModule>,
    #[serde(default)]
    pub mattermost: Option<MattermostModule>,
    #[serde(default)]
    pub github: Option<SimpleModule>,
    #[serde(default)]
    pub library: Option<LibraryModule>,
    #[serde(default)]
    pub paper_radar: Option<PaperRadarModule>,
    #[serde(default)]
    pub cluster: Option<ClusterModule>,
    #[serde(default)]
    pub latex: Option<SimpleModule>,
    #[serde(default)]
    pub meetings: Option<SimpleModule>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ClaudeConnectors {
    pub enabled: bool,
    #[serde(default)] pub gmail: bool,
    #[serde(default)] pub calendar: bool,
    #[serde(default)] pub gmail_query: String,
    #[serde(default)] pub calendar_ids: Vec<String>,
    #[serde(default)] pub read_tools: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SimpleModule {
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MailModule {
    pub enabled: bool,
    #[serde(default)]
    pub accounts: Vec<MailAccount>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MailAccount {
    pub label: String,
    pub mail_account: String,
    pub address: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CalendarModule {
    pub enabled: bool,
    #[serde(default)]
    pub read: Vec<String>,
    #[serde(default)]
    pub write: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MattermostModule {
    pub enabled: bool,
    #[serde(default)]
    pub server: Option<String>,
    #[serde(default)]
    pub team: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub auth: Option<String>,
    #[serde(default)]
    pub keychain_service: Option<String>,
    #[serde(default)]
    pub channels: Vec<String>,
    #[serde(default)]
    pub app: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LibraryModule {
    pub enabled: bool,
    #[serde(default)]
    pub folder: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PaperRadarModule {
    pub enabled: bool,
    #[serde(default)]
    pub arxiv_categories: Vec<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub profile: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ClusterModule {
    pub enabled: bool,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub ssh_alias: Option<String>,
    #[serde(default)]
    pub remote_home: Option<String>,
    #[serde(default)]
    pub scheduler: Option<String>,
    #[serde(default)]
    pub jupyter_url: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AppearanceConfig {
    #[serde(default)]
    pub palette: Option<String>,
    #[serde(default)]
    pub theme: Option<String>,
    #[serde(default)]
    pub home_wallpaper: Option<bool>,
}

/// Clúster ya validado: solo existe si el módulo está activado.
#[derive(Clone, Debug)]
pub struct ClusterSettings {
    pub label: String,
    pub ssh_alias: String,
    pub remote_home: String,
    pub slurm: bool,
    pub jupyter_url: Option<String>,
}

/// Configuración cargada y validada, con el workspace ya canonicalizado.
#[derive(Debug)]
pub struct Resolved {
    pub path: PathBuf,
    pub config: Config,
    pub workspace: PathBuf,
}

#[derive(Debug)]
pub enum ConfigState {
    Ready(Arc<Resolved>),
    Missing { path: PathBuf, error: String },
    Invalid { path: PathBuf, error: String },
}

impl ConfigState {
    pub fn path(&self) -> &Path {
        match self {
            ConfigState::Ready(resolved) => &resolved.path,
            ConfigState::Missing { path, .. } | ConfigState::Invalid { path, .. } => path,
        }
    }
}

static STATE: LazyLock<RwLock<Arc<ConfigState>>> =
    LazyLock::new(|| RwLock::new(Arc::new(load_state())));

/// Estado actual (se carga la primera vez que se consulta).
pub fn state() -> Arc<ConfigState> {
    STATE
        .read()
        .map(|guard| Arc::clone(&guard))
        .unwrap_or_else(|poisoned| Arc::clone(&poisoned.into_inner()))
}

/// Vuelve a leer el archivo y sustituye el estado global.
pub fn reload() -> Arc<ConfigState> {
    let next = Arc::new(load_state());
    match STATE.write() {
        Ok(mut guard) => *guard = Arc::clone(&next),
        Err(poisoned) => *poisoned.into_inner() = Arc::clone(&next),
    }
    next
}

/// Configuración lista para los comandos que la necesitan. Si falta o es
/// inválida, devuelve un error claro en español en lugar de fallar.
pub fn current() -> Result<Arc<Resolved>, String> {
    match &*state() {
        ConfigState::Ready(resolved) => Ok(Arc::clone(resolved)),
        ConfigState::Missing { path, .. } => Err(format!(
            "Esprit no tiene configuración todavía: falta {}. Pídele a Claude que complete la instalación o crea el archivo a partir de config/esprit.example.json.",
            path.display()
        )),
        ConfigState::Invalid { path, error } => Err(format!(
            "La configuración de Esprit ({}) no es válida: {error}",
            path.display()
        )),
    }
}

/// Ruta de la configuración: `ESPRIT_CONFIG` o `~/.config/esprit/config.json`.
pub fn config_path() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("ESPRIT_CONFIG").filter(|value| !value.is_empty()) {
        let path = PathBuf::from(value);
        if path.is_absolute() {
            return Ok(path);
        }
        let base = std::env::current_dir()
            .map_err(|error| format!("No se pudo resolver ESPRIT_CONFIG: {error}"))?;
        return Ok(base.join(path));
    }
    #[cfg(test)]
    {
        // Los tests nunca leen la configuración real del usuario.
        Ok(std::env::temp_dir().join("esprit-tests-sin-configuracion/config.json"))
    }
    #[cfg(not(test))]
    {
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "No se pudo determinar la carpeta personal (HOME)".to_string())?;
        Ok(PathBuf::from(home).join(".config/esprit/config.json"))
    }
}

pub fn load_state() -> ConfigState {
    match config_path() {
        Ok(path) => load_from_path(&path),
        Err(error) => ConfigState::Invalid {
            path: PathBuf::from("~/.config/esprit/config.json"),
            error,
        },
    }
}

pub fn load_from_path(path: &Path) -> ConfigState {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return ConfigState::Missing {
                path: path.to_path_buf(),
                error: format!("No existe el archivo de configuración {}", path.display()),
            }
        }
        Err(error) => {
            return ConfigState::Invalid {
                path: path.to_path_buf(),
                error: format!("No se pudo inspeccionar el archivo de configuración: {error}"),
            }
        }
    };
    let invalid = |error: String| ConfigState::Invalid {
        path: path.to_path_buf(),
        error,
    };
    if !metadata.is_file() {
        return invalid("La ruta de configuración no es un archivo regular".to_string());
    }
    if metadata.len() > MAX_CONFIG_BYTES {
        return invalid("El archivo de configuración supera el límite de 256 KB".to_string());
    }
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut text = String::new();
    let read = fs::File::open(&canonical)
        .and_then(|file| file.take(MAX_CONFIG_BYTES + 1).read_to_string(&mut text));
    if let Err(error) = read {
        return invalid(format!("No se pudo leer la configuración: {error}"));
    }
    if text.len() as u64 > MAX_CONFIG_BYTES {
        return invalid("El archivo de configuración supera el límite de 256 KB".to_string());
    }
    match parse_and_validate(&text, canonical.clone()) {
        Ok(resolved) => ConfigState::Ready(Arc::new(resolved)),
        Err(error) => ConfigState::Invalid {
            path: canonical,
            error,
        },
    }
}

fn spanish_serde_error(error: &serde_json::Error) -> String {
    error
        .to_string()
        .replace("unknown field", "campo desconocido")
        .replace("missing field", "falta el campo")
        .replace("expected one of", "se esperaba uno de")
        .replace("invalid type", "tipo no válido")
        .replace("invalid value", "valor no válido")
        .replace("expected", "se esperaba")
        .replace(" at line ", " en la línea ")
        .replace(" column ", " columna ")
}

pub fn parse_and_validate(text: &str, path: PathBuf) -> Result<Resolved, String> {
    let config: Config = serde_json::from_str(text)
        .map_err(|error| format!("El archivo no cumple el formato de Esprit: {}", spanish_serde_error(&error)))?;
    let workspace = validate(&config)?;
    Ok(Resolved {
        path,
        config,
        workspace,
    })
}

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

fn has_control(value: &str) -> bool {
    value.chars().any(char::is_control)
}

fn check_text(value: &str, field: &str, min: usize, max: usize) -> Result<(), String> {
    let count = value.chars().count();
    if count < min || count > max || has_control(value) || (min > 0 && value.trim().is_empty()) {
        return Err(format!(
            "`{field}` debe tener entre {min} y {max} caracteres sin caracteres de control"
        ));
    }
    Ok(())
}

pub fn valid_slug(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 48
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

/// Ruta relativa al workspace: sin `/` inicial, sin `..` ni `.`, sin partes vacías.
pub fn valid_relative_path(value: &str) -> bool {
    let count = value.chars().count();
    (1..=200).contains(&count)
        && !value.starts_with('/')
        && !has_control(value)
        && !value.contains('\\')
        && !value.contains(':')
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn valid_absolute_path(value: &str) -> bool {
    Path::new(value).is_absolute() && value.len() <= 1024 && !has_control(value)
        && !value.split(['/', '\\']).any(|part| part == "..")
}

pub fn valid_time_zone(value: &str) -> bool {
    value.parse::<chrono_tz::Tz>().is_ok()
}

fn valid_iso_day(value: &str) -> bool {
    if value.len() != 10 || value.as_bytes()[4] != b'-' || value.as_bytes()[7] != b'-' {
        return false;
    }
    let (Ok(year), Ok(month), Ok(day)) = (
        value[0..4].parse::<u32>(),
        value[5..7].parse::<u32>(),
        value[8..10].parse::<u32>(),
    ) else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let maximum = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1900..=2200).contains(&year) && (1..=maximum).contains(&day)
}

fn check_executable(value: &Option<String>, field: &str) -> Result<(), String> {
    let Some(path) = value else {
        return Ok(());
    };
    if !valid_absolute_path(path) {
        return Err(format!("`{field}` debe ser una ruta absoluta"));
    }
    let metadata = fs::metadata(path)
        .map_err(|_| format!("`{field}` no existe: {path}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
            return Err(format!("`{field}` no es un ejecutable: {path}"));
        }
    }
    #[cfg(not(unix))]
    if !metadata.is_file() {
        return Err(format!("`{field}` no es un ejecutable: {path}"));
    }
    Ok(())
}

fn check_url(value: &str, field: &str, schemes: &[&str]) -> Result<url::Url, String> {
    if value.len() > 2048 || has_control(value) || value.chars().any(char::is_whitespace) {
        return Err(format!("`{field}` no es una URL válida"));
    }
    let parsed = url::Url::parse(value).map_err(|_| format!("`{field}` no es una URL válida"))?;
    if !schemes.contains(&parsed.scheme()) {
        return Err(format!(
            "`{field}` usa un esquema no permitido; se admite: {}",
            schemes.join(", ")
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(format!("`{field}` no puede incluir credenciales"));
    }
    if matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_none() {
        return Err(format!("`{field}` no tiene un servidor válido"));
    }
    Ok(parsed)
}

fn check_app_name(value: &str, field: &str) -> Result<(), String> {
    let count = value.chars().count();
    if !(1..=60).contains(&count)
        || has_control(value)
        || value.contains(['/', '\\', ':'])
        || value.trim() != value
        || matches!(value, "." | "..")
        || value.starts_with('-')
    {
        return Err(format!(
            "`{field}` debe ser el nombre de una app de /Applications, sin la extensión .app"
        ));
    }
    Ok(())
}

/// Carpeta de proyecto: directorio real (no enlace) dentro del workspace.
fn check_workspace_folder(workspace: &Path, relative: &str, field: &str) -> Result<PathBuf, String> {
    if !valid_relative_path(relative) {
        return Err(format!(
            "`{field}` debe ser una ruta relativa al workspace, sin `..` ni `/` inicial"
        ));
    }
    let path = workspace.join(relative);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| format!("`{field}` no existe dentro del workspace: {relative}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!("`{field}` no es una carpeta real del workspace: {relative}"));
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("No se pudo resolver `{field}`: {error}"))?;
    if !canonical.starts_with(workspace) || canonical == workspace {
        return Err(format!("`{field}` queda fuera del workspace: {relative}"));
    }
    Ok(canonical)
}

fn validate(config: &Config) -> Result<PathBuf, String> {
    if config.version != 1 {
        return Err("`version` debe ser 1".to_string());
    }
    check_text(&config.user.name, "user.name", 1, 80)?;
    check_text(&config.user.short_name, "user.short_name", 1, 40)?;
    check_text(&config.user.initials, "user.initials", 1, 3)?;
    if !valid_time_zone(&config.time_zone) {
        return Err(format!(
            "`time_zone` no es una zona IANA válida (por ejemplo, Europe/Madrid): {}",
            config.time_zone
        ));
    }

    if !valid_absolute_path(&config.workspace) {
        return Err("`workspace` debe ser una ruta absoluta sin `..`".to_string());
    }
    let metadata = fs::symlink_metadata(&config.workspace)
        .map_err(|_| format!("El workspace no existe: {}", config.workspace))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!(
            "El workspace debe ser un directorio real, no un enlace simbólico: {}",
            config.workspace
        ));
    }
    let workspace = Path::new(&config.workspace)
        .canonicalize()
        .map_err(|error| format!("No se pudo resolver el workspace: {error}"))?;
    if workspace == Path::new("/") {
        return Err("El workspace no puede ser la raíz del disco".to_string());
    }

    if let Some(source) = &config.source_repo {
        if !valid_absolute_path(source) {
            return Err("`source_repo` debe ser una ruta absoluta".to_string());
        }
    }

    check_executable(&config.tools.claude, "tools.claude")?;
    check_executable(&config.tools.codex, "tools.codex")?;
    check_executable(&config.tools.gh, "tools.gh")?;
    check_executable(&config.tools.python3, "tools.python3")?;
    check_executable(&config.tools.latexmk, "tools.latexmk")?;

    if config.projects.len() > 24 {
        return Err("`projects` admite como máximo 24 proyectos".to_string());
    }
    let mut slugs = HashSet::new();
    for (index, project) in config.projects.iter().enumerate() {
        let field = |name: &str| format!("projects[{index}].{name}");
        if !valid_slug(&project.slug) {
            return Err(format!(
                "`{}` debe cumplir ^[a-z0-9][a-z0-9-]{{0,47}}$: {}",
                field("slug"),
                project.slug
            ));
        }
        if project.slug == "general" {
            return Err(format!("`{}` no puede ser «general» (está reservado)", field("slug")));
        }
        if !slugs.insert(project.slug.as_str()) {
            return Err(format!("El slug de proyecto «{}» está repetido", project.slug));
        }
        check_text(&project.name, &field("name"), 1, 80)?;
        if let Some(short) = &project.short_name {
            check_text(short, &field("short_name"), 1, 28)?;
        }
        if let Some(tag) = &project.tag {
            check_text(tag, &field("tag"), 0, 28)?;
        }
        check_workspace_folder(&workspace, &project.folder, &field("folder"))?;
        if project.github_repos.len() > 8 {
            return Err(format!("`{}` admite como máximo 8 repositorios", field("github_repos")));
        }
        for repo in &project.github_repos {
            if !valid_github_repo(repo) {
                return Err(format!(
                    "`{}` contiene un repositorio no válido (usa propietario/nombre): {repo}",
                    field("github_repos")
                ));
            }
        }
        if let Some(collection) = &project.library_collection {
            let count = collection.chars().count();
            if !(1..=60).contains(&count)
                || collection.contains(['/', '\\'])
                || has_control(collection)
                || matches!(collection.as_str(), "." | "..")
                || collection.starts_with('.')
            {
                return Err(format!(
                    "`{}` debe ser el nombre de una subcarpeta de la biblioteca",
                    field("library_collection")
                ));
            }
        }
        if let Some(cluster_dir) = &project.cluster_dir {
            if !valid_relative_path(cluster_dir) {
                return Err(format!(
                    "`{}` debe ser una ruta relativa a modules.cluster.remote_home, sin `..`",
                    field("cluster_dir")
                ));
            }
        }
    }

    if config.milestones.len() > 12 {
        return Err("`milestones` admite como máximo 12 fechas".to_string());
    }
    for (index, milestone) in config.milestones.iter().enumerate() {
        check_text(&milestone.title, &format!("milestones[{index}].title"), 1, 80)?;
        if !valid_iso_day(&milestone.date) {
            return Err(format!("`milestones[{index}].date` debe ser una fecha AAAA-MM-DD real"));
        }
        if let Some(meta) = &milestone.meta {
            check_text(meta, &format!("milestones[{index}].meta"), 0, 60)?;
        }
    }

    if config.links.len() > 12 {
        return Err("`links` admite como máximo 12 accesos directos".to_string());
    }
    for (index, link) in config.links.iter().enumerate() {
        check_text(&link.label, &format!("links[{index}].label"), 1, 32)?;
        match (&link.url, &link.app) {
            (Some(url), None) => {
                check_url(
                    url,
                    &format!("links[{index}].url"),
                    &["https", "http", "obsidian", "zotero", "vscode"],
                )?;
            }
            (None, Some(app)) => check_app_name(app, &format!("links[{index}].app"))?,
            _ => {
                return Err(format!(
                    "`links[{index}]` debe tener `url` o `app`, pero no ambos"
                ))
            }
        }
        if let Some(icon) = &link.icon {
            if !LINK_ICONS.contains(&icon.as_str()) {
                return Err(format!("`links[{index}].icon` no es un icono incluido: {icon}"));
            }
        }
    }

    validate_modules(config, &workspace)?;

    if let Some(palette) = &config.appearance.palette {
        if palette.is_empty()
            || palette.len() > 32
            || !palette
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err("`appearance.palette` no es un identificador de paleta válido".to_string());
        }
    }
    if let Some(theme) = &config.appearance.theme {
        if !matches!(theme.as_str(), "light" | "dark") {
            return Err("`appearance.theme` debe ser light o dark".to_string());
        }
    }
    Ok(workspace)
}

pub fn valid_github_repo(value: &str) -> bool {
    let Some((owner, name)) = value.split_once('/') else {
        return false;
    };
    let part = |value: &str| {
        !value.is_empty()
            && value.len() <= 100
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
            && !matches!(value, "." | "..")
    };
    part(owner) && part(name)
}

fn validate_modules(config: &Config, workspace: &Path) -> Result<(), String> {
    let modules = &config.modules;
    if let Some(c) = &modules.claude_connectors {
        super::connectors::validate(c)?;
        if c.enabled && config.tools.claude.is_none() { return Err("Los conectores requieren tools.claude".into()); }
        if c.enabled && ((c.gmail && modules.mail.as_ref().is_some_and(|m| m.enabled)) || (c.calendar && modules.calendar.as_ref().is_some_and(|m| m.enabled))) {
            return Err("Elige una sola fuente de correo/calendario: nativa o conectores Claude".into());
        }
    }
    if cfg!(windows) {
        let unavailable = [
            ("mail", modules.mail.as_ref().is_some_and(|m| m.enabled)),
            ("calendar", modules.calendar.as_ref().is_some_and(|m| m.enabled)),
            ("cluster", modules.cluster.as_ref().is_some_and(|m| m.enabled)),
            ("latex", modules.latex.as_ref().is_some_and(|m| m.enabled)),
        ];
        for (name, active) in unavailable { if active { return Err(format!("modules.{name} no está disponible en esta beta Windows. Usa claude_connectors para leer Gmail y Google Calendar en los rituales.")); } }
        if config.tools.python3.is_none() { return Err("Configura tools.python3 con la ruta a python.exe".into()); }
    }
    if let Some(mail) = &modules.mail {
        if mail.accounts.len() > 4 {
            return Err("`modules.mail.accounts` admite como máximo 4 cuentas".to_string());
        }
        if mail.enabled && mail.accounts.is_empty() {
            return Err("El correo está activado pero `modules.mail.accounts` está vacío".to_string());
        }
        for (index, account) in mail.accounts.iter().enumerate() {
            check_text(&account.label, &format!("modules.mail.accounts[{index}].label"), 1, 32)?;
            check_text(
                &account.mail_account,
                &format!("modules.mail.accounts[{index}].mail_account"),
                1,
                80,
            )?;
            let address = &account.address;
            let valid = address.len() <= 254
                && address.split('@').count() == 2
                && address
                    .split_once('@')
                    .is_some_and(|(local, domain)| !local.is_empty() && !domain.is_empty())
                && !address.chars().any(|character| character.is_whitespace() || character.is_control());
            if !valid {
                return Err(format!(
                    "`modules.mail.accounts[{index}].address` no es una dirección válida"
                ));
            }
        }
    }
    if let Some(calendar) = &modules.calendar {
        if calendar.read.len() > 8 || calendar.write.len() > 4 {
            return Err("`modules.calendar` admite 8 calendarios de lectura y 4 de escritura".to_string());
        }
        for name in calendar.read.iter().chain(calendar.write.iter()) {
            check_text(name, "modules.calendar", 1, 80)?;
        }
        for name in &calendar.write {
            if !calendar.read.contains(name) {
                return Err(format!(
                    "`modules.calendar.write` contiene «{name}», que no está en `modules.calendar.read`"
                ));
            }
        }
        if calendar.enabled && calendar.read.is_empty() {
            return Err("El calendario está activado pero `modules.calendar.read` está vacío".to_string());
        }
    }
    if let Some(mattermost) = &modules.mattermost {
        if let Some(server) = &mattermost.server {
            check_url(server, "modules.mattermost.server", &["https"])?;
        }
        if let Some(team) = &mattermost.team {
            check_text(team, "modules.mattermost.team", 1, 64)?;
        }
        if let Some(username) = &mattermost.username {
            check_text(username, "modules.mattermost.username", 1, 64)?;
        }
        if let Some(auth) = &mattermost.auth {
            if !matches!(auth.as_str(), "password" | "token") {
                return Err("`modules.mattermost.auth` debe ser password o token".to_string());
            }
        }
        if let Some(service) = &mattermost.keychain_service {
            check_text(service, "modules.mattermost.keychain_service", 1, 64)?;
        }
        if mattermost.channels.len() > 40 {
            return Err("`modules.mattermost.channels` admite como máximo 40 canales".to_string());
        }
        for channel in &mattermost.channels {
            check_text(channel, "modules.mattermost.channels", 1, 64)?;
        }
        if let Some(app) = &mattermost.app {
            check_app_name(app, "modules.mattermost.app")?;
        }
        if mattermost.enabled
            && (mattermost.server.is_none()
                || mattermost.team.is_none()
                || mattermost.username.is_none()
                || mattermost.auth.is_none()
                || mattermost.keychain_service.is_none())
        {
            return Err(
                "Mattermost está activado pero faltan server, team, username, auth o keychain_service"
                    .to_string(),
            );
        }
    }
    if let Some(library) = &modules.library {
        if let Some(folder) = &library.folder {
            if !valid_relative_path(folder) {
                return Err(
                    "`modules.library.folder` debe ser una ruta relativa al workspace, sin `..`"
                        .to_string(),
                );
            }
        }
        if library.enabled && library.folder.is_none() {
            return Err("La biblioteca está activada pero falta `modules.library.folder`".to_string());
        }
    }
    if let Some(travel) = &modules.travel {
        if travel.enabled && !travel.folder.as_deref().is_some_and(valid_relative_path) {
            return Err("modules.travel.folder debe ser una carpeta relativa al workspace".into());
        }
    }
    if let Some(radar) = &modules.paper_radar {
        if radar.arxiv_categories.len() > 8 || radar.keywords.len() > 40 {
            return Err("`modules.paper_radar` admite 8 categorías y 40 palabras clave".to_string());
        }
        for category in &radar.arxiv_categories {
            if !valid_arxiv_category(category) {
                return Err(format!("Categoría arXiv no válida: {category}"));
            }
        }
        for keyword in &radar.keywords {
            check_text(keyword, "modules.paper_radar.keywords", 2, 80)?;
        }
        if let Some(profile) = &radar.profile {
            if !valid_relative_path(profile) {
                return Err(
                    "`modules.paper_radar.profile` debe ser una ruta relativa al workspace".to_string(),
                );
            }
        }
        if radar.enabled && !modules.library.as_ref().is_some_and(|library| library.enabled) {
            return Err("El Radar de lectura necesita `modules.library` activado".to_string());
        }
    }
    if let Some(cluster) = &modules.cluster {
        if let Some(label) = &cluster.label {
            check_text(label, "modules.cluster.label", 1, 32)?;
        }
        if let Some(alias) = &cluster.ssh_alias {
            if !valid_ssh_alias(alias) {
                return Err("`modules.cluster.ssh_alias` debe ser un alias de ~/.ssh/config (letras, números, punto, guion o guion bajo)".to_string());
            }
        }
        if let Some(home) = &cluster.remote_home {
            if !valid_absolute_path(home) || home.contains(['\'', '"', '`', '$', '\\']) || home == "/" {
                return Err("`modules.cluster.remote_home` debe ser una ruta absoluta remota sin `..`".to_string());
            }
        }
        if let Some(scheduler) = &cluster.scheduler {
            if !matches!(scheduler.as_str(), "slurm" | "none") {
                return Err("`modules.cluster.scheduler` debe ser slurm o none".to_string());
            }
        }
        if let Some(url) = &cluster.jupyter_url {
            check_url(url, "modules.cluster.jupyter_url", &["https"])?;
        }
        if cluster.enabled
            && (cluster.ssh_alias.is_none() || cluster.remote_home.is_none() || cluster.scheduler.is_none())
        {
            return Err("El clúster está activado pero faltan ssh_alias, remote_home o scheduler".to_string());
        }
    }
    let _ = workspace;
    Ok(())
}

pub fn valid_ssh_alias(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && !value.starts_with(['-', '.'])
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

fn valid_arxiv_category(value: &str) -> bool {
    let (archive, subject) = match value.split_once('.') {
        Some((archive, subject)) => (archive, Some(subject)),
        None => (value, None),
    };
    !archive.is_empty()
        && archive.len() <= 32
        && archive.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'-')
        && subject.is_none_or(|subject| {
            !subject.is_empty()
                && subject.len() <= 32
                && subject.bytes().all(|byte| byte.is_ascii_alphabetic() || byte == b'-')
        })
}

// ---------------------------------------------------------------------------
// Accesores
// ---------------------------------------------------------------------------

fn enabled<T>(module: &Option<T>, is_enabled: impl Fn(&T) -> bool) -> bool {
    module.as_ref().is_some_and(is_enabled)
}

impl Resolved {
    pub fn user_name(&self) -> &str {
        &self.config.user.name
    }

    pub fn time_zone(&self) -> &str {
        &self.config.time_zone
    }

    pub fn projects(&self) -> &[ProjectConfig] {
        &self.config.projects
    }

    pub fn project(&self, slug: &str) -> Option<&ProjectConfig> {
        self.config.projects.iter().find(|project| project.slug == slug)
    }

    pub fn project_label(&self, slug: &str) -> Option<&str> {
        self.project(slug).map(|project| project.name.as_str())
    }

    /// Carpeta sin verificar; los comandos usan `verified_project_root`.
    pub fn project_path(&self, slug: &str) -> Option<PathBuf> {
        self.project(slug)
            .map(|project| self.workspace.join(&project.folder))
    }

    pub fn esprit_dir(&self) -> PathBuf {
        self.workspace.join("Esprit")
    }

    pub fn global_state_path(&self) -> PathBuf {
        self.esprit_dir().join("STATE.md")
    }

    pub fn login_history_path(&self) -> PathBuf {
        self.esprit_dir().join("login-history.json")
    }

    pub fn logout_history_path(&self) -> PathBuf {
        self.esprit_dir().join("logout-history.json")
    }

    pub fn skill_path(&self, name: &str) -> PathBuf {
        self.workspace
            .join(".claude/skills")
            .join(name)
            .join("SKILL.md")
    }

    pub fn python3(&self) -> PathBuf {
        PathBuf::from(
            self.config
                .tools
                .python3
                .as_deref()
                .unwrap_or(DEFAULT_PYTHON3),
        )
    }

    pub fn claude(&self) -> Result<PathBuf, String> {
        self.config
            .tools
            .claude
            .as_deref()
            .map(PathBuf::from)
            .ok_or_else(|| "Claude Code no está configurado (`tools.claude` es null)".to_string())
    }

    pub fn codex(&self) -> Result<PathBuf, String> {
        self.config
            .tools
            .codex
            .as_deref()
            .map(PathBuf::from)
            .ok_or_else(|| "Codex no está configurado (`tools.codex` es null)".to_string())
    }

    pub fn gh(&self) -> Result<PathBuf, String> {
        self.config
            .tools
            .gh
            .as_deref()
            .map(PathBuf::from)
            .ok_or_else(|| "GitHub CLI no está configurado (`tools.gh` es null)".to_string())
    }

    pub fn latexmk(&self) -> Option<PathBuf> {
        self.config.tools.latexmk.as_deref().map(PathBuf::from)
    }

    pub fn connectors(&self) -> Option<&ClaudeConnectors> {
        self.config.modules.claude_connectors.as_ref().filter(|c| c.enabled)
    }

    pub fn mail_enabled(&self) -> bool {
        enabled(&self.config.modules.mail, |mail| mail.enabled && !mail.accounts.is_empty())
    }

    pub fn mail_accounts(&self) -> &[MailAccount] {
        self.config
            .modules
            .mail
            .as_ref()
            .filter(|mail| mail.enabled)
            .map(|mail| mail.accounts.as_slice())
            .unwrap_or(&[])
    }

    pub fn mail_account_keys(&self) -> Vec<String> {
        (0..self.mail_accounts().len())
            .map(|index| format!("m{index}"))
            .collect()
    }

    pub fn calendar_enabled(&self) -> bool {
        enabled(&self.config.modules.calendar, |calendar| calendar.enabled)
    }

    pub fn calendar_read(&self) -> Vec<String> {
        self.config
            .modules
            .calendar
            .as_ref()
            .filter(|calendar| calendar.enabled)
            .map(|calendar| dedup(&calendar.read))
            .unwrap_or_default()
    }

    pub fn calendar_write(&self) -> Vec<String> {
        self.config
            .modules
            .calendar
            .as_ref()
            .filter(|calendar| calendar.enabled)
            .map(|calendar| dedup(&calendar.write))
            .unwrap_or_default()
    }

    pub fn mattermost_enabled(&self) -> bool {
        enabled(&self.config.modules.mattermost, |module| module.enabled)
    }

    pub fn mattermost_app(&self) -> Option<&str> {
        self.config
            .modules
            .mattermost
            .as_ref()
            .filter(|module| module.enabled)
            .and_then(|module| module.app.as_deref())
    }

    pub fn github_enabled(&self) -> bool {
        enabled(&self.config.modules.github, |module| module.enabled)
            && self.config.tools.gh.is_some()
    }

    /// Unión de `projects[].github_repos`, sin duplicados (sin distinguir mayúsculas).
    pub fn github_repos(&self) -> Vec<&str> {
        let mut seen = HashSet::new();
        self.config
            .projects
            .iter()
            .flat_map(|project| project.github_repos.iter())
            .filter(|repo| seen.insert(repo.to_ascii_lowercase()))
            .map(String::as_str)
            .collect()
    }

    pub fn library_enabled(&self) -> bool {
        enabled(&self.config.modules.library, |module| module.enabled && module.folder.is_some())
    }

    pub fn library_folder(&self) -> Option<&str> {
        self.config
            .modules
            .library
            .as_ref()
            .filter(|module| module.enabled)
            .and_then(|module| module.folder.as_deref())
    }

    pub fn paper_radar(&self) -> Option<&PaperRadarModule> {
        self.config
            .modules
            .paper_radar
            .as_ref()
            .filter(|module| module.enabled && self.library_enabled())
    }

    pub fn paper_radar_enabled(&self) -> bool {
        self.paper_radar().is_some()
    }

    pub fn cluster(&self) -> Option<ClusterSettings> {
        let module = self.config.modules.cluster.as_ref().filter(|module| module.enabled)?;
        Some(ClusterSettings {
            label: module.label.clone().unwrap_or_else(|| "Clúster".to_string()),
            ssh_alias: module.ssh_alias.clone()?,
            remote_home: module.remote_home.clone()?.trim_end_matches('/').to_string(),
            slurm: module.scheduler.as_deref() == Some("slurm"),
            jupyter_url: module.jupyter_url.clone(),
        })
    }

    pub fn latex_enabled(&self) -> bool {
        enabled(&self.config.modules.latex, |module| module.enabled)
    }

    pub fn meetings_enabled(&self) -> bool {
        enabled(&self.config.modules.meetings, |module| module.enabled)
    }

    pub fn source_repo(&self) -> Option<&str> {
        self.config.source_repo.as_deref()
    }

    pub fn links(&self) -> &[LinkConfig] {
        &self.config.links
    }
}

fn dedup(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .iter()
        .filter(|value| seen.insert(value.as_str()))
        .cloned()
        .collect()
}

// ---------------------------------------------------------------------------
// Contrato con el frontend y modo --check-config
// ---------------------------------------------------------------------------

/// Forma exacta de `AppConfig` del brief. Nunca expone rutas de herramientas,
/// servidor ni usuario de Mattermost, ni nada del llavero.
pub fn app_config_value(state: &ConfigState) -> Value {
    let resolved = match state {
        ConfigState::Ready(resolved) => resolved,
        ConfigState::Missing { path, error } => {
            return json!({
                "status": "missing",
                "error": error,
                "config_path": path.to_string_lossy(),
                "app_version": APP_VERSION,
            })
        }
        ConfigState::Invalid { path, error } => {
            return json!({
                "status": "invalid",
                "error": error,
                "config_path": path.to_string_lossy(),
                "app_version": APP_VERSION,
            })
        }
    };
    let config = &resolved.config;
    let cluster = resolved.cluster();
    let projects: Vec<Value> = config
        .projects
        .iter()
        .map(|project| {
            json!({
                "slug": project.slug,
                "name": project.name,
                "short_name": project.short_name.clone().unwrap_or_else(|| project.name.chars().take(28).collect()),
                "tag": project.tag.clone().filter(|tag| !tag.trim().is_empty()),
                "has_github": resolved.github_enabled() && !project.github_repos.is_empty(),
                "has_library": resolved.library_enabled() && project.library_collection.is_some(),
                "has_cluster": cluster.is_some() && project.cluster_dir.is_some(),
            })
        })
        .collect();
    let milestones: Vec<Value> = config
        .milestones
        .iter()
        .map(|milestone| json!({"title": milestone.title, "date": milestone.date, "meta": milestone.meta}))
        .collect();
    let links: Vec<Value> = config
        .links
        .iter()
        .enumerate()
        .map(|(index, link)| json!({"index": index, "label": link.label, "icon": link.icon}))
        .collect();
    let accounts: Vec<Value> = resolved
        .mail_accounts()
        .iter()
        .enumerate()
        .map(|(index, account)| {
            json!({"key": format!("m{index}"), "label": account.label, "address": account.address})
        })
        .collect();
    json!({
        "status": "ok",
        "config_path": resolved.path.to_string_lossy(),
        "app_version": APP_VERSION,
        "user": {
            "name": config.user.name,
            "short_name": config.user.short_name,
            "initials": config.user.initials,
        },
        "time_zone": config.time_zone,
        "workspace": resolved.workspace.to_string_lossy(),
        "projects": projects,
        "milestones": milestones,
        "links": links,
        "engines": {
            "claude": config.tools.claude.is_some(),
            "codex": config.tools.codex.is_some(),
        },
        "modules": {
            "claude_connectors": {"enabled": resolved.connectors().is_some(), "gmail": resolved.connectors().is_some_and(|c|c.gmail), "calendar": resolved.connectors().is_some_and(|c|c.calendar)},
            "mail": {"enabled": resolved.mail_enabled(), "accounts": accounts},
            "calendar": {
                "enabled": resolved.calendar_enabled(),
                "read": resolved.calendar_read(),
                "write": resolved.calendar_write(),
            },
            "mattermost": {
                "enabled": resolved.mattermost_enabled(),
                "has_app": resolved.mattermost_app().is_some(),
            },
            "github": {"enabled": resolved.github_enabled()},
            "library": {"enabled": resolved.library_enabled()},
            "paper_radar": {"enabled": resolved.paper_radar_enabled()},
            "travel": {"enabled": resolved.config.modules.travel.as_ref().is_some_and(|m| m.enabled)},
            "cluster": {
                "enabled": cluster.is_some(),
                "label": cluster.as_ref().map(|cluster| cluster.label.clone()).unwrap_or_else(|| "Clúster".to_string()),
                "scheduler": if cluster.as_ref().is_some_and(|cluster| cluster.slurm) { "slurm" } else { "none" },
                "has_jupyter": cluster.as_ref().is_some_and(|cluster| cluster.jupyter_url.is_some()),
            },
            "latex": {"enabled": resolved.latex_enabled()},
            "meetings": {"enabled": resolved.meetings_enabled()},
        },
        "appearance": {
            "palette": config.appearance.palette.clone().unwrap_or_else(|| "tinta".to_string()),
            "theme": config.appearance.theme.clone().unwrap_or_else(|| "light".to_string()),
            "home_wallpaper": config.appearance.home_wallpaper.unwrap_or(false),
        },
    })
}

/// Informe de `esprit --check-config`: JSON imprimible y código de salida.
pub fn check_config_report(state: &ConfigState) -> (Value, i32) {
    match state {
        ConfigState::Ready(resolved) => {
            let modules = app_config_value(state)["modules"].clone();
            let enabled: Vec<String> = modules
                .as_object()
                .map(|object| {
                    object
                        .iter()
                        .filter(|(_, value)| value["enabled"].as_bool() == Some(true))
                        .map(|(name, _)| name.clone())
                        .collect()
                })
                .unwrap_or_default();
            (
                json!({
                    "ok": true,
                    "config_path": resolved.path.to_string_lossy(),
                    "app_version": APP_VERSION,
                    "workspace": resolved.workspace.to_string_lossy(),
                    "projects": resolved.config.projects.len(),
                    "modules": enabled,
                    "engines": {
                        "claude": resolved.config.tools.claude.is_some(),
                        "codex": resolved.config.tools.codex.is_some(),
                    },
                }),
                0,
            )
        }
        ConfigState::Missing { path, error } | ConfigState::Invalid { path, error } => (
            json!({"ok": false, "config_path": path.to_string_lossy(), "error": error}),
            1,
        ),
    }
}

/// Si el proceso se lanzó con `--check-config`, valida, imprime y termina.
pub fn handle_check_config_flag() {
    if !std::env::args().skip(1).any(|argument| argument == "--check-config") {
        return;
    }
    let (report, code) = check_config_report(&load_state());
    println!(
        "{}",
        serde_json::to_string(&report).unwrap_or_else(|_| "{\"ok\":false}".to_string())
    );
    std::process::exit(code);
}

#[cfg(test)]
pub mod testing {
    use super::*;

    /// Workspace temporal con una configuración válida basada en el ejemplo.
    pub struct Fixture {
        pub root: PathBuf,
        pub resolved: Arc<Resolved>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    pub fn unique_dir(prefix: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let count = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("{prefix}-{nanos:x}-{count}-{}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path.canonicalize().unwrap()
    }

    pub fn example_json(workspace: &Path) -> Value {
        let mut value: Value =
            serde_json::from_str(include_str!("../../config/esprit.example.json")).unwrap();
        value["workspace"] = json!(workspace.to_string_lossy());
        value["source_repo"] = json!(workspace.join("Esprit-src").to_string_lossy());
        value["tools"] = json!({
            "claude": "/usr/bin/true",
            "codex": null,
            "gh": "/usr/bin/true",
            "python3": "/usr/bin/true",
            "latexmk": null
        });
        value
    }

    pub fn prepare_workspace(root: &Path) -> PathBuf {
        let workspace = root.join("Doctorado");
        for folder in ["Proyectos/Tesis", "Proyectos/Articulo-1", "Biblioteca", "Esprit"] {
            fs::create_dir_all(workspace.join(folder)).unwrap();
        }
        workspace.canonicalize().unwrap()
    }

    pub fn fixture_with(modify: impl FnOnce(&mut Value)) -> Fixture {
        let root = unique_dir("esprit-config");
        let workspace = prepare_workspace(&root);
        let mut value = example_json(&workspace);
        modify(&mut value);
        let path = root.join("config.json");
        fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        let resolved = parse_and_validate(&serde_json::to_string(&value).unwrap(), path)
            .unwrap_or_else(|error| panic!("fixture inválida: {error}"));
        Fixture {
            root,
            resolved: Arc::new(resolved),
        }
    }

    pub fn fixture() -> Fixture {
        fixture_with(|_| {})
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    fn validate_value(value: &Value) -> Result<Resolved, String> {
        parse_and_validate(&serde_json::to_string(value).unwrap(), PathBuf::from("/tmp/config.json"))
    }

    fn with_workspace(modify: impl FnOnce(&mut Value)) -> (PathBuf, Result<Resolved, String>) {
        let root = unique_dir("esprit-config-case");
        let workspace = prepare_workspace(&root);
        let mut value = example_json(&workspace);
        modify(&mut value);
        let result = validate_value(&value);
        (root, result)
    }

    fn expect_error(modify: impl FnOnce(&mut Value), needle: &str) {
        let (root, result) = with_workspace(modify);
        let error = result.expect_err("la configuración debía ser inválida");
        assert!(error.contains(needle), "{error}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn travels_reject_escape_even_before_the_folder_exists() {
        expect_error(|value| {value["modules"]["travel"] = json!({"enabled":true,"folder":"../privado"});}, "travel.folder");
    }

    #[test]
    fn the_shipped_example_is_valid_once_paths_exist() {
        let fixture = fixture();
        let resolved = &fixture.resolved;
        assert_eq!(resolved.projects().len(), 2);
        assert_eq!(resolved.time_zone(), "Europe/Madrid");
        assert!(resolved.calendar_enabled());
        assert_eq!(resolved.calendar_write(), vec!["Doctorado".to_string()]);
        assert!(!resolved.mail_enabled());
        assert!(resolved.github_enabled());
        assert_eq!(resolved.github_repos(), vec!["tu-usuario/tesis"]);
        assert!(resolved.paper_radar_enabled());
        assert!(resolved.cluster().is_none());
        assert_eq!(resolved.global_state_path(), resolved.workspace.join("Esprit/STATE.md"));
    }

    #[test]
    fn rejects_bad_slugs_and_duplicates() {
        expect_error(|value| value["projects"][0]["slug"] = json!("Tesis"), "projects[0].slug");
        expect_error(|value| value["projects"][0]["slug"] = json!("-tesis"), "projects[0].slug");
        expect_error(|value| value["projects"][1]["slug"] = json!("tesis"), "repetido");
        expect_error(|value| value["projects"][0]["slug"] = json!("general"), "reservado");
    }

    #[test]
    fn rejects_parent_and_absolute_project_folders() {
        expect_error(|value| value["projects"][0]["folder"] = json!("../fuera"), "projects[0].folder");
        expect_error(|value| value["projects"][0]["folder"] = json!("Proyectos/../../fuera"), "projects[0].folder");
        expect_error(|value| value["projects"][0]["folder"] = json!("/etc"), "projects[0].folder");
        expect_error(|value| value["projects"][0]["folder"] = json!("Proyectos/NoExiste"), "no existe");
        expect_error(|value| value["projects"][0]["cluster_dir"] = json!("../otra"), "cluster_dir");
        expect_error(|value| value["projects"][0]["library_collection"] = json!(".."), "library_collection");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_workspace_and_project_folders() {
        use std::os::unix::fs::symlink;
        let root = unique_dir("esprit-config-symlink");
        let workspace = prepare_workspace(&root);
        let outside = root.join("fuera");
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, workspace.join("Proyectos/Enlace")).unwrap();
        let mut value = example_json(&workspace);
        value["projects"][0]["folder"] = json!("Proyectos/Enlace");
        assert!(validate_value(&value).unwrap_err().contains("carpeta real"));
        let linked = root.join("workspace-enlace");
        symlink(&workspace, &linked).unwrap();
        let mut value = example_json(&workspace);
        value["workspace"] = json!(linked.to_string_lossy());
        assert!(validate_value(&value).unwrap_err().contains("enlace simbólico"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_missing_workspace() {
        let mut value = example_json(Path::new("/esprit/no/existe"));
        value["workspace"] = json!("/esprit/no/existe");
        assert!(validate_value(&value).unwrap_err().contains("workspace"));
        let mut relative = example_json(Path::new("/tmp"));
        relative["workspace"] = json!("Doctorado");
        assert!(validate_value(&relative).unwrap_err().contains("workspace"));
    }

    #[test]
    fn rejects_bad_url_schemes_and_ambiguous_links() {
        expect_error(|value| value["links"][0]["url"] = json!("javascript:alert(1)"), "links[0].url");
        expect_error(|value| value["links"][0]["url"] = json!("file:///etc/passwd"), "links[0].url");
        expect_error(|value| value["links"][0]["url"] = json!("https://user:clave@example.org"), "credenciales");
        expect_error(|value| value["links"][1]["url"] = json!("https://example.org"), "no ambos");
        expect_error(|value| value["links"][1]["app"] = json!("../Terminal"), "links[1].app");
        expect_error(|value| value["modules"]["mattermost"]["server"] = json!("http://chat.ejemplo.org"), "mattermost.server");
        expect_error(|value| value["modules"]["cluster"]["jupyter_url"] = json!("javascript:x"), "jupyter_url");
    }

    #[test]
    fn calendar_write_must_be_a_subset_of_read() {
        expect_error(
            |value| value["modules"]["calendar"]["write"] = json!(["Personal"]),
            "modules.calendar.write",
        );
    }

    #[test]
    fn rejects_unknown_fields_missing_claude_and_bad_versions() {
        expect_error(|value| value["extra"] = json!(true), "campo desconocido");
        expect_error(|value| value["modules"]["mail"]["gmail"] = json!(true), "campo desconocido");
        expect_error(|value| { value["tools"].as_object_mut().unwrap().remove("claude"); }, "claude");
        expect_error(|value| value["version"] = json!(2), "version");
        expect_error(|value| value["time_zone"] = json!("Europe/Nowhere"), "time_zone");
        expect_error(|value| value["time_zone"] = json!("../../etc/passwd"), "time_zone");
        expect_error(|value| value["tools"]["gh"] = json!("gh"), "tools.gh");
        expect_error(|value| value["tools"]["gh"] = json!("/esprit/no/existe/gh"), "tools.gh");
    }

    #[test]
    fn enabled_modules_require_their_fields() {
        expect_error(|value| { value["modules"]["mail"] = json!({"enabled": true, "accounts": []}); }, "correo");
        expect_error(|value| { value["modules"]["cluster"] = json!({"enabled": true, "label": "X"}); }, "clúster");
        expect_error(|value| value["modules"]["cluster"]["ssh_alias"] = json!("-oProxyCommand"), "ssh_alias");
        expect_error(|value| value["modules"]["library"]["enabled"] = json!(false), "Radar");
        expect_error(|value| value["modules"]["mattermost"] = json!({"enabled": true}), "Mattermost");
    }

    #[test]
    fn app_config_matches_the_contract_and_never_exposes_tool_paths() {
        let fixture = fixture_with(|value| {
            value["modules"]["mail"]["enabled"] = json!(true);
            value["modules"]["mattermost"]["enabled"] = json!(true);
            value["modules"]["cluster"]["enabled"] = json!(true);
        });
        let state = ConfigState::Ready(Arc::clone(&fixture.resolved));
        let value = app_config_value(&state);
        assert_eq!(value["status"], "ok");
        assert_eq!(value["user"]["initials"], "NA");
        assert_eq!(value["projects"][0]["slug"], "tesis");
        assert_eq!(value["projects"][0]["has_github"], true);
        assert_eq!(value["projects"][0]["has_library"], true);
        assert_eq!(value["projects"][0]["has_cluster"], true);
        assert_eq!(value["projects"][1]["has_github"], false);
        assert_eq!(value["links"][1]["index"], 1);
        assert!(value["links"][1].get("app").is_none());
        assert_eq!(value["engines"], json!({"claude": true, "codex": false}));
        assert_eq!(value["modules"]["mail"]["accounts"][0]["key"], "m0");
        assert_eq!(value["modules"]["mattermost"], json!({"enabled": true, "has_app": true}));
        assert_eq!(value["modules"]["cluster"]["scheduler"], "slurm");
        assert_eq!(value["appearance"]["palette"], "tinta");
        let wire = value.to_string();
        for private in ["/usr/bin/true", "chat.ejemplo.org", "esprit-mattermost", "\"usuario\"", "ssh_alias", "remote_home"] {
            assert!(!wire.contains(private), "{private} en {wire}");
        }
        let missing = ConfigState::Missing { path: PathBuf::from("/x/config.json"), error: "falta".into() };
        let value = app_config_value(&missing);
        assert_eq!(value["status"], "missing");
        assert_eq!(value["config_path"], "/x/config.json");
        assert_eq!(value["app_version"], APP_VERSION);
    }

    #[test]
    fn check_config_reports_ok_and_errors_with_exit_codes() {
        let fixture = fixture();
        let (report, code) = check_config_report(&load_from_path(&fixture.root.join("config.json")));
        assert_eq!(code, 0, "{report}");
        assert_eq!(report["ok"], true);
        assert_eq!(report["projects"], 2);
        let broken = fixture.root.join("broken.json");
        fs::write(&broken, b"{ no es json").unwrap();
        let (report, code) = check_config_report(&load_from_path(&broken));
        assert_eq!(code, 1);
        assert_eq!(report["ok"], false);
        assert!(report["error"].as_str().unwrap().contains("formato"));
        let (report, code) = check_config_report(&load_from_path(&fixture.root.join("nada.json")));
        assert_eq!(code, 1);
        assert!(report["error"].as_str().unwrap().contains("No existe"));
    }

    #[test]
    fn default_state_in_tests_never_reads_the_user_configuration() {
        if std::env::var_os("ESPRIT_CONFIG").is_none() {
            assert!(config_path().unwrap().starts_with(std::env::temp_dir()));
        }
    }
}
