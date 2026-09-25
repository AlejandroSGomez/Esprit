use super::*;
#[cfg(unix)]
use std::os::fd::AsRawFd;

const TRAVEL_UAM_OVERVIEW: &str = "https://www.uam.es/uam/investigacion/area-investigacion-transferencia/gestion-economica/viajes-estancias";
const TRAVEL_COMMISSION_URL: &str = "https://sede.uam.es/sede/comisionserviciosPI";
const TRAVEL_ADVANCE_URL: &str = "https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=7wJm_IiOHU-iBuFKO8Ga8von9P8JPLNBvA2U2CsiY1BURFg1RE00N0EzR0lRVk40QkdJVFNIQU9PRyQlQCN0PWcu";
const TRAVEL_JUSTIFICATION_URL: &str = "https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=7wJm_IiOHU-iBuFKO8Ga8von9P8JPLNBvA2U2CsiY1BUNVNRU0gwM0wwUlhXVkdUWTc1VTdFTTc0QSQlQCN0PWcu";
const TRAVEL_EXPENSE_FORM_URL: &str =
    "https://www.uam.es/uam/media/doc/1606853093775/5-formulario-de-gastos-de-viajes-2.pdf";
const TRAVEL_LIQUIDATION_FORM_URL: &str =
    "https://www.uam.es/uam/media/doc/1606853094462/7-formulario-de-liquidacion-de-dietas-2.pdf";
const TRAVEL_ADVANCE_FORM_URL: &str =
    "https://www.uam.es/uam/media/doc/1606952791586/10-formulario-de-adelanto-de-cajero-2.pdf";
const TRAVEL_AGENCY_EMAIL: &str = "uam@viajeseci.es";
const MAX_TRAVEL_TEXT_BYTES: usize = 2 * 1_048_576;
const MAX_TRAVEL_PREVIEW_BYTES: usize = 25 * 1_048_576;
const MAX_TRAVEL_DIRECTORY_ENTRIES: usize = 2000;
const MAX_TRAVEL_BROWSER_SESSIONS: usize = 12;
const MAX_TRAVEL_BROWSER_NODES: usize = 5000;
const TRAVEL_BROWSER_TTL_MS: u128 = 4 * 60 * 60 * 1000;
#[derive(Default)]
pub struct TravelStore(Arc<Mutex<()>>);
#[derive(Default)]
pub struct TravelBrowsers(Arc<Mutex<HashMap<String, TravelBrowserSession>>>);
pub struct TravelBrowserSession {
    root_label: String,
    root: PathBuf,
    nodes: HashMap<String, TravelBrowserNode>,
    created_at: u128,
}

#[derive(Clone)]
pub struct TravelBrowserNode { path: PathBuf, kind: String, sensitive: bool }
pub struct TravelProcessLock(fs::File);
impl Drop for TravelProcessLock { fn drop(&mut self) { unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN); } } }
const TRAVEL_STEP_KEYS: [&str; 9] = [
    "plan",
    "commission",
    "authorization",
    "agency",
    "advance",
    "travel",
    "forms",
    "submission",
    "closure",
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct TravelStepState {
    key: String,
    state: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct TravelTrip {
    id: String,
    name: String,
    destination: String,
    start_date: Option<String>,
    end_date: Option<String>,
    project: String,
    folder: String,
    status: String,
    next_action: String,
    provenance: String,
    closure_verified: bool,
    steps: Vec<TravelStepState>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct TravelRegistry {
    version: u8,
    revision: u64,
    trips: Vec<TravelTrip>,
}

#[derive(Serialize)]
pub struct TravelWorkflowStep {
    key: &'static str,
    label: &'static str,
    short_label: &'static str,
    description: &'static str,
    optional: bool,
}

#[derive(Serialize)]
pub struct TravelOverview {
    version: u8,
    revision: u64,
    checked_at: u128,
    official_rule: &'static str,
    trips: Vec<TravelTrip>,
    workflow: Vec<TravelWorkflowStep>,
}

#[derive(Deserialize)]
pub struct TravelCreateRequest {
    name: String,
    destination: String,
    start_date: String,
    end_date: String,
    project: String,
    expected_revision: u64,
}

#[derive(Serialize)]
pub struct TravelCreateReply {
    created_id: String,
    overview: TravelOverview,
}

#[derive(Deserialize)]
pub struct TravelStepUpdateRequest {
    trip_id: String,
    step: String,
    state: String,
    expected_revision: u64,
}

#[derive(Clone, Serialize)]
pub struct TravelEntry {
    id: String,
    name: String,
    kind: String,
    size: u64,
    modified: f64,
    sensitive: bool,
}

#[derive(Serialize)]
pub struct TravelDirectory {
    session_id: String,
    directory_id: String,
    parent_id: Option<String>,
    display_path: String,
    entries: Vec<TravelEntry>,
    truncated: bool,
}

#[derive(Serialize)]
pub struct TravelFile {
    id: String,
    name: String,
    display_path: String,
    kind: String,
    mime: String,
    content: Option<String>,
    data_base64: Option<String>,
    modified: f64,
    size: usize,
    sensitive: bool,
}

fn travel_workflow() -> Vec<TravelWorkflowStep> {
    vec![
        TravelWorkflowStep {
            key: "plan",
            label: "Planificación",
            short_label: "Plan",
            description: "Destino, fechas, proyecto, motivo y reservas iniciales.",
            optional: false,
        },
        TravelWorkflowStep {
            key: "commission",
            label: "Solicitud de comisión",
            short_label: "Comisión",
            description: "Registrar la comisión para PI al menos diez días antes.",
            optional: false,
        },
        TravelWorkflowStep {
            key: "authorization",
            label: "Resolución favorable",
            short_label: "Resolución",
            description: "Guardar la autorización y su código de expediente.",
            optional: false,
        },
        TravelWorkflowStep {
            key: "agency",
            label: "Contratar con la agencia",
            short_label: "Agencia",
            description:
                "Preparar documentos, pedir la propuesta y revisar precio, equipaje y límite antes de autorizar emisión.",
            optional: true,
        },
        TravelWorkflowStep {
            key: "advance",
            label: "Anticipo",
            short_label: "Anticipo",
            description: "Opcional: solicitarlo después de recibir la autorización.",
            optional: true,
        },
        TravelWorkflowStep {
            key: "travel",
            label: "Viaje y justificantes",
            short_label: "Viaje",
            description: "Reunir billetes, facturas, pagos y certificado de asistencia.",
            optional: false,
        },
        TravelWorkflowStep {
            key: "forms",
            label: "Dos formularios firmados",
            short_label: "Formularios",
            description: "Liquidación de dietas y formulario de gastos firmado por el IP.",
            optional: false,
        },
        TravelWorkflowStep {
            key: "submission",
            label: "Justificación online",
            short_label: "Envío",
            description: "Enviar el expediente en el formulario UAM dentro de diez días hábiles.",
            optional: false,
        },
        TravelWorkflowStep {
            key: "closure",
            label: "Reembolso y cierre",
            short_label: "Cierre",
            description: "Confirmar aceptación, subsanaciones y cierre administrativo.",
            optional: false,
        },
    ]
}

fn travel_overview_from(registry: &TravelRegistry) -> TravelOverview {
    TravelOverview {
        version: registry.version,
        revision: registry.revision,
        checked_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        official_rule: "UAM vigente: comisión al menos 10 días antes; justificación en un máximo de 10 días hábiles tras el viaje.",
        trips: registry.trips.clone(),
        workflow: travel_workflow(),
    }
}

fn valid_travel_id(value: &str) -> bool {
    (2..=64).contains(&value.len())
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn validate_travel_text(
    value: &str,
    label: &str,
    maximum: usize,
    allow_empty: bool,
) -> Result<(), String> {
    let length = value.chars().count();
    if (!allow_empty && value.trim().is_empty()) || length > maximum {
        return Err(format!("{label} no tiene una longitud válida"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{label} contiene caracteres de control"));
    }
    Ok(())
}

fn validate_travel_folder_name(value: &str) -> Result<(), String> {
    validate_travel_text(value, "El nombre de carpeta", 80, false)?;
    if value != value.trim()
        || value.starts_with('.')
        || matches!(value, "." | "..")
        || !value.chars().all(|character| {
            character.is_alphanumeric()
                || matches!(character, ' ' | '-' | '_' | '(' | ')' | '[' | ']')
        })
    {
        return Err(
            "El nombre del viaje solo puede usar letras, números, espacios, guiones y paréntesis"
                .to_string(),
        );
    }
    Ok(())
}

fn valid_iso_date(value: &str) -> bool {
    if value.len() != 10
        || value.as_bytes().get(4) != Some(&b'-')
        || value.as_bytes().get(7) != Some(&b'-')
    {
        return false;
    }
    let Some(year @ 2000..=2200) = value[0..4].parse::<u16>().ok() else {
        return false;
    };
    let Some(month @ 1..=12) = value[5..7].parse::<u8>().ok() else {
        return false;
    };
    let Some(day) = value[8..10].parse::<u8>().ok() else {
        return false;
    };
    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let maximum_day = match month {
        2 if leap_year => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    (1..=maximum_day).contains(&day)
}

fn normalize_optional_date(value: &str, label: &str) -> Result<Option<String>, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if !valid_iso_date(value) {
        return Err(format!("{label} debe usar el formato AAAA-MM-DD"));
    }
    Ok(Some(value.to_string()))
}

fn validate_travel_registry(registry: &TravelRegistry) -> Result<(), String> {
    if registry.version != 1 {
        return Err("La versión del registro de viajes no está soportada".to_string());
    }
    if registry.trips.len() > 200 {
        return Err("El registro de viajes supera el límite de 200 entradas".to_string());
    }
    let mut ids = HashSet::new();
    let mut folders = HashSet::new();
    let expected_steps: HashSet<&str> = TRAVEL_STEP_KEYS.into_iter().collect();
    for trip in &registry.trips {
        if !valid_travel_id(&trip.id) || !ids.insert(trip.id.as_str()) {
            return Err(
                "El registro contiene un identificador de viaje no válido o repetido".to_string(),
            );
        }
        validate_travel_text(&trip.name, "El nombre del viaje", 80, false)?;
        validate_travel_folder_name(&trip.folder)?;
        let folded_folder = trip.folder.to_lowercase();
        if !folders.insert(folded_folder) {
            return Err("El registro contiene carpetas de viaje repetidas".to_string());
        }
        validate_travel_text(&trip.destination, "El destino", 160, true)?;
        validate_travel_text(&trip.project, "El proyecto", 160, true)?;
        validate_travel_text(&trip.next_action, "La siguiente acción", 320, false)?;
        validate_travel_text(&trip.provenance, "La procedencia", 420, false)?;
        if !matches!(trip.status.as_str(), "active" | "history") {
            return Err("El registro contiene un estado de viaje no válido".to_string());
        }
        if let Some(start) = &trip.start_date {
            if !valid_iso_date(start) {
                return Err(format!("La fecha inicial de {} no es válida", trip.name));
            }
        }
        if let Some(end) = &trip.end_date {
            if !valid_iso_date(end) {
                return Err(format!("La fecha final de {} no es válida", trip.name));
            }
        }
        if let (Some(start), Some(end)) = (&trip.start_date, &trip.end_date) {
            if start > end {
                return Err(format!("Las fechas de {} están invertidas", trip.name));
            }
        }
        let mut seen_steps = HashSet::new();
        for step in &trip.steps {
            if !expected_steps.contains(step.key.as_str()) || !seen_steps.insert(step.key.as_str())
            {
                return Err(format!(
                    "{} contiene pasos desconocidos o repetidos",
                    trip.name
                ));
            }
            if !matches!(
                step.state.as_str(),
                "pending" | "done" | "unknown" | "not_applicable"
            ) {
                return Err(format!(
                    "{} contiene un estado de paso no válido",
                    trip.name
                ));
            }
            if step.state == "not_applicable" && !matches!(step.key.as_str(), "agency" | "advance")
            {
                return Err(
                    "Solo la agencia y el anticipo pueden marcarse como no aplicables".to_string(),
                );
            }
        }
        if seen_steps != expected_steps {
            return Err(format!("{} no contiene el ciclo completo", trip.name));
        }
        let closure_done = trip
            .steps
            .iter()
            .any(|step| step.key == "closure" && step.state == "done");
        if closure_done != trip.closure_verified
            || (trip.closure_verified && trip.status != "history")
        {
            return Err(format!(
                "El cierre verificado de {} es inconsistente",
                trip.name
            ));
        }
        if trip.closure_verified
            && trip.steps.iter().any(|step| {
                step.key != "closure" && !matches!(step.state.as_str(), "done" | "not_applicable")
            })
        {
            return Err(format!(
                "{} está cerrado con pasos previos incompletos",
                trip.name
            ));
        }
    }
    Ok(())
}

fn verified_trips_root() -> Result<PathBuf, String> {
    travel_root(&*config::current()?)
}

fn travel_root(cfg: &Resolved) -> Result<PathBuf, String> {
    let module = cfg.config.modules.travel.as_ref().filter(|m| m.enabled)
        .ok_or("Viajes no configurado")?;
    let relative = module.folder.as_deref().unwrap_or("Viajes");
    let root = verified_workspace_root(&cfg)?;
    validate_confined_path(&root, &root.join(relative))
}
fn acquire_travel_process_lock() -> Result<TravelProcessLock, String> {
    verified_trips_root()?;
    let root = verified_trips_root()?;
    let path = &root.join(".esprit-viajes.lock");
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("El bloqueo de Viajes no es un archivo local regular".to_string());
        }
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let file = options
        .open(path)
        .map_err(|error| format!("No se pudo abrir el bloqueo de Viajes: {error}"))?;
    if !file
        .metadata()
        .map_err(|error| format!("No se pudo verificar el bloqueo de Viajes: {error}"))?
        .is_file()
    {
        return Err("El bloqueo de Viajes no es un archivo regular".to_string());
    }
    #[cfg(unix)]
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(format!(
            "No se pudo bloquear Viajes: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(TravelProcessLock(file))
}

fn load_travel_registry() -> Result<TravelRegistry, String> {
    verified_trips_root()?;
    let root = verified_trips_root()?;
    let path = &root.join(".esprit-viajes.json");
    if !path.exists() { return Ok(TravelRegistry {version: 1, revision: 0, trips: Vec::new()}); }
    let file = open_regular_file_readonly(path, "el registro de viajes")?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("No se pudo inspeccionar el registro de viajes: {error}"))?;
    if metadata.len() > 1_048_576 {
        return Err("El registro de viajes supera el límite seguro de 1 MB".to_string());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(1_048_577)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("No se pudo leer el registro de viajes: {error}"))?;
    if bytes.len() > 1_048_576 {
        return Err(
            "El registro de viajes creció por encima de 1 MB durante la lectura".to_string(),
        );
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| "El registro de viajes no contiene texto UTF-8 válido".to_string())?;
    let registry: TravelRegistry = serde_json::from_str(&content)
        .map_err(|error| format!("El registro de viajes no es JSON válido: {error}"))?;
    validate_travel_registry(&registry)?;
    Ok(registry)
}

fn write_travel_registry(registry: &TravelRegistry) -> Result<(), String> {
    validate_travel_registry(registry)?;
    verified_trips_root()?;
    let root = verified_trips_root()?;
    let path = &root.join(".esprit-viajes.json");
    let parent = path
        .parent()
        .ok_or_else(|| "El registro de viajes no tiene una carpeta válida".to_string())?;
    let temporary = parent.join(format!(".esprit-viajes.{}.tmp", new_plan_id()));
    let result = (|| {
        let bytes = serde_json::to_vec_pretty(registry)
            .map_err(|error| format!("No se pudo serializar el registro de viajes: {error}"))?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("No se pudo preparar el registro de viajes: {error}"))?;
        file.write_all(&bytes)
            .map_err(|error| format!("No se pudo guardar el registro de viajes: {error}"))?;
        file.write_all(b"\n")
            .map_err(|error| format!("No se pudo finalizar el registro de viajes: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("No se pudo sincronizar el registro de viajes: {error}"))?;
        fs::rename(&temporary, path)
            .map_err(|error| format!("No se pudo activar el registro de viajes: {error}"))?;
        if let Ok(directory) = OpenOptions::new().read(true).open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[tauri::command]
pub async fn travel_overview(store: State<'_, TravelStore>) -> Result<TravelOverview, String> {
    let store = Arc::clone(&store.0);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = store
            .lock()
            .map_err(|_| "No se pudo bloquear el registro de viajes".to_string())?;
        let registry = load_travel_registry()?;
        Ok(travel_overview_from(&registry))
    })
    .await
    .map_err(|error| format!("La lectura de viajes se interrumpió: {error}"))?
}

fn slugify_travel_name(value: &str) -> String {
    let mut slug = String::new();
    let mut separated = false;
    for character in value.chars().flat_map(char::to_lowercase) {
        let normalized = match character {
            'á' | 'à' | 'ä' | 'â' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            other if other.is_ascii_alphanumeric() => other,
            _ => {
                if !slug.is_empty() {
                    separated = true;
                }
                continue;
            }
        };
        if separated && !slug.ends_with('-') {
            slug.push('-');
        }
        separated = false;
        slug.push(normalized);
    }
    let truncated: String = slug.trim_matches('-').chars().take(54).collect();
    truncated.trim_matches('-').to_string()
}

fn next_travel_action(trip: &TravelTrip) -> String {
    let next = TRAVEL_STEP_KEYS.iter().find(|key| {
        trip.steps
            .iter()
            .find(|step| step.key == **key)
            .is_some_and(|step| !matches!(step.state.as_str(), "done" | "not_applicable"))
    });
    match next.copied() {
        Some("plan") => "Completar la planificación básica del viaje.".to_string(),
        Some("commission") => {
            "Iniciar la comisión de servicios en la sede electrónica.".to_string()
        }
        Some("authorization") => "Esperar y guardar la resolución favorable.".to_string(),
        Some("agency") => {
            "Preparar el formulario y el correo de reserva para la agencia UAM.".to_string()
        }
        Some("advance") => {
            "Decidir si necesitas anticipo; solicítalo o marca que no aplica.".to_string()
        }
        Some("travel") => {
            "Completar reservas y reunir todos los justificantes del viaje.".to_string()
        }
        Some("forms") => "Completar y firmar la liquidación y el formulario de gastos.".to_string(),
        Some("submission") => "Enviar la justificación online con todos los adjuntos.".to_string(),
        Some("closure") => "Confirmar aceptación, reembolso y cierre administrativo.".to_string(),
        _ => "El ciclo administrativo está completo.".to_string(),
    }
}

fn folder_exists_case_insensitive(parent: &Path, name: &str) -> Result<bool, String> {
    let target = name.to_lowercase();
    for entry in fs::read_dir(parent)
        .map_err(|error| format!("No se pudo revisar la carpeta Trips: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("No se pudo leer una entrada de Trips: {error}"))?;
        let Some(existing) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if existing.to_lowercase() == target {
            return Ok(true);
        }
    }
    Ok(false)
}

fn travel_template_markdown(trip: &TravelTrip) -> String {
    let dates = match (&trip.start_date, &trip.end_date) {
        (Some(start), Some(end)) => format!("{start} → {end}"),
        (Some(start), None) => format!("Desde {start}"),
        _ => "Por definir".to_string(),
    };
    format!(
        "# {}\n\n> Creado por Esprit. No guardar datos bancarios, credenciales ni claves en este archivo.\n\n## Datos\n\n- Destino: {}\n- Fechas: {}\n- Proyecto: {}\n- Estado: activo\n\n## Ciclo\n\n- [x] Planificación inicial\n- [ ] Solicitud de comisión de servicios\n- [ ] Resolución favorable\n- [ ] Contratación con la agencia UAM (si procede)\n- [ ] Anticipo (opcional)\n- [ ] Viaje y justificantes\n- [ ] Liquidación y formulario de gastos firmados\n- [ ] Justificación online\n- [ ] Reembolso y cierre confirmado\n\n## Agencia UAM\n\n- Destinatario: {}\n- [ ] Detalles de ida/vuelta y clase o alojamiento\n- [ ] DNI\n- [ ] Pasaporte si procede\n- [ ] Formulario de gastos de viaje\n- [ ] Resolución favorable de comisión de servicios\n\n## Enlaces UAM\n\n- Información vigente: {}\n- Comisión de Servicios para PI: {}\n- Formulario de gastos: {}\n\n## Notas\n\n",
        trip.name,
        if trip.destination.is_empty() { "Por definir" } else { &trip.destination },
        dates,
        if trip.project.is_empty() { "Por definir" } else { &trip.project },
        TRAVEL_AGENCY_EMAIL,
        TRAVEL_UAM_OVERVIEW,
        TRAVEL_COMMISSION_URL,
        TRAVEL_EXPENSE_FORM_URL,
    )
}

fn create_travel_trip(request: TravelCreateRequest) -> Result<TravelCreateReply, String> {
    let _process_lock = acquire_travel_process_lock()?;
    let name = request.name.trim().to_string();
    validate_travel_folder_name(&name)?;
    let destination = request.destination.trim().to_string();
    let project = request.project.trim().to_string();
    validate_travel_text(&destination, "El destino", 160, true)?;
    validate_travel_text(&project, "El proyecto", 160, true)?;
    let start_date = normalize_optional_date(&request.start_date, "La fecha inicial")?;
    let end_date = normalize_optional_date(&request.end_date, "La fecha final")?;
    if let (Some(start), Some(end)) = (&start_date, &end_date) {
        if start > end {
            return Err("La fecha final no puede ser anterior a la inicial".to_string());
        }
    }

    let mut registry = load_travel_registry()?;
    if registry.revision != request.expected_revision {
        return Err("El registro de viajes cambió; actualiza la vista antes de crear".to_string());
    }
    if registry.revision == u64::MAX {
        return Err("La revisión del registro de viajes alcanzó su límite".to_string());
    }
    if registry.trips.len() >= 200 {
        return Err("El registro de viajes ya contiene el máximo de 200 entradas".to_string());
    }
    let folded_name = name.to_lowercase();
    if registry
        .trips
        .iter()
        .any(|trip| trip.folder.to_lowercase() == folded_name)
    {
        return Err("Ese nombre de carpeta ya pertenece a un viaje registrado".to_string());
    }
    let trips_root = verified_trips_root()?;
    if folder_exists_case_insensitive(&trips_root, &name)? {
        return Err("Ya existe una carpeta de viaje con ese nombre".to_string());
    }

    let base_id = slugify_travel_name(&name);
    if base_id.len() < 2 {
        return Err("No se pudo derivar un identificador seguro del nombre".to_string());
    }
    let mut trip_id = base_id.clone();
    let mut suffix = 2;
    while registry.trips.iter().any(|trip| trip.id == trip_id) {
        trip_id = format!("{}-{suffix}", base_id.trim_end_matches('-'));
        suffix += 1;
    }
    if !valid_travel_id(&trip_id) {
        return Err("El identificador derivado del viaje no es válido".to_string());
    }

    let mut trip = TravelTrip {
        id: trip_id.clone(),
        name: name.clone(),
        destination,
        start_date,
        end_date,
        project,
        folder: name,
        status: "active".to_string(),
        next_action: String::new(),
        provenance: format!(
            "Creado manualmente en Esprit · {}",
            current_local_iso(&config::current()?.config.time_zone).unwrap_or_else(|_| "fecha local no disponible".to_string())
        ),
        closure_verified: false,
        steps: TRAVEL_STEP_KEYS
            .iter()
            .map(|key| TravelStepState {
                key: (*key).to_string(),
                state: if *key == "plan" { "done" } else { "pending" }.to_string(),
            })
            .collect(),
    };
    trip.next_action = next_travel_action(&trip);

    let final_folder = trips_root.join(&trip.folder);
    fs::create_dir(&final_folder).map_err(|error| {
        format!("No se pudo reservar de forma exclusiva la carpeta del viaje: {error}")
    })?;
    let prepare_result = (|| {
        for folder in [
            "00_Planificacion",
            "01_Comision",
            "02_Adelanto",
            "03_Reservas",
            "04_Justificantes",
            "05_Cierre",
        ] {
            fs::create_dir(final_folder.join(folder))
                .map_err(|error| format!("No se pudo crear {folder}: {error}"))?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(final_folder.join("VIAJE.md"))
            .map_err(|error| format!("No se pudo crear VIAJE.md: {error}"))?;
        file.write_all(travel_template_markdown(&trip).as_bytes())
            .map_err(|error| format!("No se pudo escribir VIAJE.md: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("No se pudo sincronizar VIAJE.md: {error}"))
    })();
    if let Err(error) = prepare_result {
        return Err(format!(
            "Viajes/{} quedó reservada pero incompleta; revísala antes de reintentar: {error}",
            trip.folder
        ));
    }

    registry.trips.insert(0, trip);
    registry.revision = registry
        .revision
        .checked_add(1)
        .ok_or_else(|| "La revisión del registro de viajes alcanzó su límite".to_string())?;
    if let Err(error) = write_travel_registry(&registry) {
        return Err(format!(
            "La carpeta se creó correctamente en Viajes/{}, pero el registro no pudo actualizarse: {error}",
            final_folder.file_name().and_then(|name| name.to_str()).unwrap_or("viaje")
        ));
    }
    Ok(TravelCreateReply {
        created_id: trip_id,
        overview: travel_overview_from(&registry),
    })
}

#[tauri::command]
pub async fn travel_create(
    request: TravelCreateRequest,
    store: State<'_, TravelStore>,
) -> Result<TravelCreateReply, String> {
    let store = Arc::clone(&store.0);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = store
            .lock()
            .map_err(|_| "No se pudo bloquear el registro de viajes".to_string())?;
        create_travel_trip(request)
    })
    .await
    .map_err(|error| format!("La creación del viaje se interrumpió: {error}"))?
}

fn update_travel_step(request: TravelStepUpdateRequest) -> Result<TravelOverview, String> {
    let _process_lock = acquire_travel_process_lock()?;
    if !TRAVEL_STEP_KEYS.contains(&request.step.as_str()) {
        return Err("Paso de viaje no reconocido".to_string());
    }
    if !matches!(
        request.state.as_str(),
        "pending" | "done" | "unknown" | "not_applicable"
    ) {
        return Err("Estado de paso no reconocido".to_string());
    }
    if request.state == "not_applicable" && !matches!(request.step.as_str(), "agency" | "advance") {
        return Err("Solo la agencia y el anticipo pueden marcarse como no aplicables".to_string());
    }
    let mut registry = load_travel_registry()?;
    if registry.revision != request.expected_revision {
        return Err(
            "El registro de viajes cambió; actualiza la vista antes de guardar".to_string(),
        );
    }
    if registry.revision == u64::MAX {
        return Err("La revisión del registro de viajes alcanzó su límite".to_string());
    }
    let trip = registry
        .trips
        .iter_mut()
        .find(|trip| trip.id == request.trip_id)
        .ok_or_else(|| "Viaje no reconocido".to_string())?;
    if request.step == "closure"
        && request.state == "done"
        && trip.steps.iter().any(|step| {
            step.key != "closure" && !matches!(step.state.as_str(), "done" | "not_applicable")
        })
    {
        return Err(
            "Completa o resuelve todos los pasos anteriores antes de confirmar el cierre"
                .to_string(),
        );
    }
    let was_verified = trip.closure_verified;
    let step = trip
        .steps
        .iter_mut()
        .find(|step| step.key == request.step)
        .ok_or_else(|| "El viaje no contiene ese paso".to_string())?;
    step.state = request.state;
    if step.key == "closure" {
        if step.state == "done" {
            trip.status = "history".to_string();
            trip.closure_verified = true;
        } else if was_verified {
            trip.status = "active".to_string();
            trip.closure_verified = false;
        }
    } else if was_verified && !matches!(step.state.as_str(), "done" | "not_applicable") {
        if let Some(closure) = trip
            .steps
            .iter_mut()
            .find(|candidate| candidate.key == "closure")
        {
            closure.state = "pending".to_string();
        }
        trip.status = "active".to_string();
        trip.closure_verified = false;
    }
    trip.next_action = next_travel_action(trip);
    registry.revision = registry
        .revision
        .checked_add(1)
        .ok_or_else(|| "La revisión del registro de viajes alcanzó su límite".to_string())?;
    write_travel_registry(&registry)?;
    Ok(travel_overview_from(&registry))
}

#[tauri::command]
pub async fn travel_update_step(
    request: TravelStepUpdateRequest,
    store: State<'_, TravelStore>,
) -> Result<TravelOverview, String> {
    let store = Arc::clone(&store.0);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = store
            .lock()
            .map_err(|_| "No se pudo bloquear el registro de viajes".to_string())?;
        update_travel_step(request)
    })
    .await
    .map_err(|error| format!("La actualización del viaje se interrumpió: {error}"))?
}

fn canonical_travel_root(trip_id: &str) -> Result<(TravelTrip, PathBuf), String> {
    if !valid_travel_id(trip_id) {
        return Err("Viaje no reconocido".to_string());
    }
    let registry = load_travel_registry()?;
    let trip = registry
        .trips
        .iter()
        .find(|trip| trip.id == trip_id)
        .cloned()
        .ok_or_else(|| "Viaje no reconocido".to_string())?;
    validate_travel_folder_name(&trip.folder)?;
    let trips_root = verified_trips_root()?;
    let root = trips_root.join(&trip.folder);
    let metadata = fs::symlink_metadata(&root)
        .map_err(|error| format!("No se pudo abrir la carpeta de {}: {error}", trip.name))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("La carpeta del viaje no es un directorio local válido".to_string());
    }
    let canonical = root
        .canonicalize()
        .map_err(|error| format!("No se pudo resolver la carpeta del viaje: {error}"))?;
    if !canonical.starts_with(&trips_root) || canonical.parent() != Some(trips_root.as_path()) {
        return Err("La carpeta del viaje queda fuera de Trips".to_string());
    }
    Ok((trip, canonical))
}

fn validate_confined_travel_path(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "La entrada queda fuera de la carpeta del viaje".to_string())?;
    let mut checked = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            return Err("La entrada contiene una ruta no válida".to_string());
        };
        checked.push(part);
        let metadata = fs::symlink_metadata(&checked)
            .map_err(|error| format!("No se pudo inspeccionar la entrada: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Esprit no sigue enlaces simbólicos en Viajes".to_string());
        }
    }
    let canonical = checked
        .canonicalize()
        .map_err(|error| format!("No se pudo resolver la entrada: {error}"))?;
    if !canonical.starts_with(root) {
        return Err("La entrada queda fuera de la carpeta del viaje".to_string());
    }
    Ok(canonical)
}

fn sensitive_travel_path(path: &Path) -> bool {
    let value = path.to_string_lossy().to_lowercase();
    let name = path
        .file_name()
        .and_then(|part| part.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let extension = path
        .extension()
        .and_then(|part| part.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(extension.as_str(), "pem" | "key" | "p12" | "pfx")
        || name == ".env"
        || name.starts_with(".env.")
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
        || [
            "infobank",
            "info bank",
            "datos banc",
            "bancarios",
            "bancaria",
            "iban",
            "datasubmission",
            "password",
            "passwd",
            "contraseña",
            "contrasena",
            "credential",
            "secret",
            "token",
            "clave",
            "api_key",
            "apikey",
        ]
        .iter()
        .any(|pattern| value.contains(pattern))
}

fn hidden_travel_metadata(name: &str) -> bool {
    name == ".DS_Store" || name == "Icon\r" || name == ".esprit" || name.starts_with(".esprit-")
}

fn travel_file_format(path: &Path) -> (&'static str, &'static str, usize) {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(
        file_name.as_str(),
        "makefile"
            | "dockerfile"
            | "license"
            | "readme"
            | ".gitignore"
            | ".gitattributes"
            | ".editorconfig"
            | ".dockerignore"
            | ".python-version"
            | ".rprofile"
    ) {
        return ("text", "text/plain", MAX_TRAVEL_TEXT_BYTES);
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "pdf" => ("pdf", "application/pdf", MAX_TRAVEL_PREVIEW_BYTES),
        "png" => ("image", "image/png", MAX_TRAVEL_PREVIEW_BYTES),
        "jpg" | "jpeg" => ("image", "image/jpeg", MAX_TRAVEL_PREVIEW_BYTES),
        "gif" => ("image", "image/gif", MAX_TRAVEL_PREVIEW_BYTES),
        "webp" => ("image", "image/webp", MAX_TRAVEL_PREVIEW_BYTES),
        "bmp" => ("image", "image/bmp", MAX_TRAVEL_PREVIEW_BYTES),
        "tif" | "tiff" => ("image", "image/tiff", MAX_TRAVEL_PREVIEW_BYTES),
        "md" | "markdown" | "txt" | "rtf" | "csv" | "tsv" | "json" | "yaml" | "yml" | "toml"
        | "tex" | "ltx" | "bib" | "sty" | "cls" | "jl" | "py" | "r" | "rs" | "c" | "cc" | "cpp"
        | "h" | "hpp" | "js" | "jsx" | "ts" | "tsx" | "css" | "scss" | "html" | "xml" | "sh"
        | "zsh" | "fish" | "sql" | "ini" | "cfg" | "log" => {
            ("text", "text/plain", MAX_TRAVEL_TEXT_BYTES)
        }
        _ => ("external", "application/octet-stream", 0),
    }
}

fn display_travel_path(session: &TravelBrowserSession, path: &Path) -> String {
    let relative = path.strip_prefix(&session.root).unwrap_or(Path::new(""));
    if relative.as_os_str().is_empty() {
        session.root_label.clone()
    } else {
        format!("{}/{}", session.root_label, relative.to_string_lossy())
    }
}

fn register_travel_node(
    session: &mut TravelBrowserSession,
    path: PathBuf,
    kind: String,
    sensitive: bool,
) -> Result<String, String> {
    if let Some((existing, node)) = session.nodes.iter_mut().find(|(_, node)| node.path == path) {
        node.kind = kind;
        node.sensitive = sensitive;
        return Ok(existing.clone());
    }
    if session.nodes.len() >= MAX_TRAVEL_BROWSER_NODES {
        return Err("La sesión del visor alcanzó su límite; vuelve a abrir el viaje".to_string());
    }
    let id = new_plan_id();
    session.nodes.insert(
        id.clone(),
        TravelBrowserNode {
            path,
            kind,
            sensitive,
        },
    );
    Ok(id)
}

fn list_travel_browser_directory(
    session_id: &str,
    directory_id: &str,
    browsers: &Arc<Mutex<HashMap<String, TravelBrowserSession>>>,
) -> Result<TravelDirectory, String> {
    validate_plan_id(session_id).map_err(|_| "Sesión de Viajes no válida".to_string())?;
    validate_plan_id(directory_id).map_err(|_| "Carpeta de Viajes no válida".to_string())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut guard = browsers
        .lock()
        .map_err(|_| "No se pudo bloquear el visor de Viajes".to_string())?;
    if guard
        .get(session_id)
        .is_some_and(|session| now.saturating_sub(session.created_at) > TRAVEL_BROWSER_TTL_MS)
    {
        guard.remove(session_id);
        return Err("La sesión del visor caducó; vuelve a abrir el viaje".to_string());
    }
    let session = guard
        .get_mut(session_id)
        .ok_or_else(|| "La sesión del visor ya no existe".to_string())?;
    if !session.root.starts_with(verified_trips_root()?) {
        return Err("La configuración de Viajes cambió; vuelve a abrir el expediente".into());
    }
    let node = session
        .nodes
        .get(directory_id)
        .cloned()
        .ok_or_else(|| "La carpeta no pertenece a esta sesión".to_string())?;
    if node.kind != "directory" {
        return Err("La entrada seleccionada no es una carpeta".to_string());
    }
    let directory = validate_confined_travel_path(&session.root, &node.path)?;
    if !fs::metadata(&directory)
        .map_err(|error| format!("No se pudo inspeccionar la carpeta: {error}"))?
        .is_dir()
    {
        return Err("La entrada seleccionada ya no es una carpeta".to_string());
    }

    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in fs::read_dir(&directory)
        .map_err(|error| format!("No se pudo leer la carpeta del viaje: {error}"))?
    {
        if entries.len() >= MAX_TRAVEL_DIRECTORY_ENTRIES {
            truncated = true;
            break;
        }
        let entry = entry.map_err(|error| format!("No se pudo leer una entrada: {error}"))?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if hidden_travel_metadata(&name) {
            continue;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("No se pudo inspeccionar {name}: {error}"))?;
        let kind = if metadata.file_type().is_symlink() {
            "symlink"
        } else if metadata.is_dir() {
            if name.to_ascii_lowercase().ends_with(".app") {
                "other"
            } else {
                "directory"
            }
        } else if metadata.is_file() {
            "file"
        } else {
            "other"
        };
        let sensitive = sensitive_travel_path(&path);
        let id = register_travel_node(session, path, kind.to_string(), sensitive)?;
        let modified = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs_f64())
            .unwrap_or(0.0);
        entries.push(TravelEntry {
            id,
            name,
            kind: kind.to_string(),
            size: metadata.len(),
            modified,
            sensitive,
        });
    }
    entries.sort_by(|left, right| {
        let left_rank = if left.kind == "directory" { 0 } else { 1 };
        let right_rank = if right.kind == "directory" { 0 } else { 1 };
        left_rank
            .cmp(&right_rank)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    let parent_id = if directory == session.root {
        None
    } else {
        let parent = directory
            .parent()
            .filter(|parent| parent.starts_with(&session.root))
            .unwrap_or(&session.root)
            .to_path_buf();
        Some(register_travel_node(
            session,
            parent,
            "directory".to_string(),
            false,
        )?)
    };
    Ok(TravelDirectory {
        session_id: session_id.to_string(),
        directory_id: directory_id.to_string(),
        parent_id,
        display_path: display_travel_path(session, &directory),
        entries,
        truncated,
    })
}

fn start_travel_browser(
    trip_id: &str,
    browsers: &Arc<Mutex<HashMap<String, TravelBrowserSession>>>,
) -> Result<TravelDirectory, String> {
    let (trip, root) = canonical_travel_root(trip_id)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let session_id = new_plan_id();
    let root_id = new_plan_id();
    {
        let mut guard = browsers
            .lock()
            .map_err(|_| "No se pudo bloquear el visor de Viajes".to_string())?;
        guard.retain(|_, session| now.saturating_sub(session.created_at) <= TRAVEL_BROWSER_TTL_MS);
        if guard.len() >= MAX_TRAVEL_BROWSER_SESSIONS {
            if let Some(oldest) = guard
                .iter()
                .min_by_key(|(_, session)| session.created_at)
                .map(|(id, _)| id.clone())
            {
                guard.remove(&oldest);
            }
        }
        let mut nodes = HashMap::new();
        nodes.insert(
            root_id.clone(),
            TravelBrowserNode {
                path: root.clone(),
                kind: "directory".to_string(),
                sensitive: false,
            },
        );
        guard.insert(
            session_id.clone(),
            TravelBrowserSession {
                root_label: trip.folder,
                root,
                nodes,
                created_at: now,
            },
        );
    }
    match list_travel_browser_directory(&session_id, &root_id, browsers) {
        Ok(directory) => Ok(directory),
        Err(error) => {
            if let Ok(mut guard) = browsers.lock() {
                guard.remove(&session_id);
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn travel_browser_start(
    trip_id: String,
    browsers: State<'_, TravelBrowsers>,
) -> Result<TravelDirectory, String> {
    let browsers = Arc::clone(&browsers.0);
    tauri::async_runtime::spawn_blocking(move || start_travel_browser(&trip_id, &browsers))
        .await
        .map_err(|error| format!("La apertura del visor se interrumpió: {error}"))?
}

#[tauri::command]
pub async fn travel_list(
    session_id: String,
    directory_id: String,
    browsers: State<'_, TravelBrowsers>,
) -> Result<TravelDirectory, String> {
    let browsers = Arc::clone(&browsers.0);
    tauri::async_runtime::spawn_blocking(move || {
        list_travel_browser_directory(&session_id, &directory_id, &browsers)
    })
    .await
    .map_err(|error| format!("La navegación del viaje se interrumpió: {error}"))?
}

fn travel_browser_node_snapshot(
    session_id: &str,
    entry_id: &str,
    browsers: &Arc<Mutex<HashMap<String, TravelBrowserSession>>>,
) -> Result<(PathBuf, String, TravelBrowserNode), String> {
    validate_plan_id(session_id).map_err(|_| "Sesión de Viajes no válida".to_string())?;
    validate_plan_id(entry_id).map_err(|_| "Entrada de Viajes no válida".to_string())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut guard = browsers
        .lock()
        .map_err(|_| "No se pudo bloquear el visor de Viajes".to_string())?;
    if guard
        .get(session_id)
        .is_some_and(|session| now.saturating_sub(session.created_at) > TRAVEL_BROWSER_TTL_MS)
    {
        guard.remove(session_id);
        return Err("La sesión del visor caducó; vuelve a abrir el viaje".to_string());
    }
    let session = guard
        .get(session_id)
        .ok_or_else(|| "La sesión del visor ya no existe".to_string())?;
    if !session.root.starts_with(verified_trips_root()?) {
        return Err("La configuración de Viajes cambió; vuelve a abrir el expediente".into());
    }
    let node = session
        .nodes
        .get(entry_id)
        .cloned()
        .ok_or_else(|| "La entrada no pertenece a esta sesión".to_string())?;
    Ok((session.root.clone(), session.root_label.clone(), node))
}

fn read_travel_file(
    session_id: &str,
    entry_id: &str,
    reveal_sensitive: bool,
    browsers: &Arc<Mutex<HashMap<String, TravelBrowserSession>>>,
) -> Result<TravelFile, String> {
    let (root, root_label, node) = travel_browser_node_snapshot(session_id, entry_id, browsers)?;
    if node.kind != "file" {
        return Err("La entrada seleccionada no es un archivo regular".to_string());
    }
    let path = validate_confined_travel_path(&root, &node.path)?;
    let sensitive = node.sensitive || sensitive_travel_path(&path);
    if sensitive && !reveal_sensitive {
        return Err(
            "Este archivo puede contener datos sensibles; confirma su revelado primero".to_string(),
        );
    }
    let file = open_regular_file_readonly(&path, "el archivo seleccionado")?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("No se pudo inspeccionar el archivo: {error}"))?;
    let (kind, mime, limit) = travel_file_format(&path);
    let relative = path.strip_prefix(&root).unwrap_or(&path);
    let display_path = format!("{root_label}/{}", relative.to_string_lossy());
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "El nombre del archivo no es UTF-8".to_string())?
        .to_string();
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs_f64())
        .unwrap_or(0.0);
    if kind == "external" {
        return Ok(TravelFile {
            id: entry_id.to_string(),
            name,
            display_path,
            kind: kind.to_string(),
            mime: mime.to_string(),
            content: None,
            data_base64: None,
            modified,
            size: metadata.len() as usize,
            sensitive,
        });
    }
    if metadata.len() > limit as u64 {
        return Err(format!(
            "El archivo supera el límite de {} MB del visor",
            limit / 1_048_576
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("No se pudo leer el archivo: {error}"))?;
    if bytes.len() > limit {
        return Err("El archivo creció mientras se leía y supera el límite del visor".to_string());
    }
    let (content, data_base64) = if kind == "text" {
        let content = String::from_utf8(bytes)
            .map_err(|_| "El archivo no es texto UTF-8; ábrelo con su aplicación".to_string())?;
        (Some(content), None)
    } else {
        (None, Some(encode_base64(&bytes)))
    };
    Ok(TravelFile {
        id: entry_id.to_string(),
        name,
        display_path,
        kind: kind.to_string(),
        mime: mime.to_string(),
        content,
        data_base64,
        modified,
        size: metadata.len() as usize,
        sensitive,
    })
}

#[tauri::command]
pub async fn travel_read_file(
    session_id: String,
    entry_id: String,
    reveal_sensitive: bool,
    browsers: State<'_, TravelBrowsers>,
) -> Result<TravelFile, String> {
    let browsers = Arc::clone(&browsers.0);
    tauri::async_runtime::spawn_blocking(move || {
        read_travel_file(&session_id, &entry_id, reveal_sensitive, &browsers)
    })
    .await
    .map_err(|error| format!("La lectura del archivo se interrumpió: {error}"))?
}

fn safe_external_travel_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "pdf"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
            | "tif"
            | "tiff"
            | "doc"
            | "docx"
            | "pages"
            | "ppt"
            | "pptx"
            | "xls"
            | "xlsx"
    )
}

#[tauri::command]
pub async fn travel_open_entry(
    session_id: String,
    entry_id: String,
    confirmed_sensitive: bool,
    browsers: State<'_, TravelBrowsers>,
) -> Result<String, String> {
    let browsers = Arc::clone(&browsers.0);
    tauri::async_runtime::spawn_blocking(move || {
        let (root, _, node) = travel_browser_node_snapshot(&session_id, &entry_id, &browsers)?;
        let path = validate_confined_travel_path(&root, &node.path)?;
        let sensitive = node.sensitive || sensitive_travel_path(&path);
        if sensitive && !confirmed_sensitive {
            return Err(
                "Este archivo puede contener datos sensibles; confirma su apertura primero"
                    .to_string(),
            );
        }
        match node.kind.as_str() {
            "directory" => {
                open_with_macos(&["-a", "Finder", path.to_string_lossy().as_ref()])?;
                Ok("Abriendo la carpeta del viaje en Finder.".to_string())
            }
            "file" if safe_external_travel_extension(&path) => {
                open_with_macos(&[path.to_string_lossy().as_ref()])?;
                Ok("Abriendo el documento con su aplicación.".to_string())
            }
            "file" => {
                open_with_macos(&["-R", path.to_string_lossy().as_ref()])?;
                Ok("Mostrando el archivo en Finder; Esprit no ejecuta este formato.".to_string())
            }
            _ => Err("Los enlaces simbólicos y formatos especiales no se pueden abrir".to_string()),
        }
    })
    .await
    .map_err(|error| format!("La apertura del archivo se interrumpió: {error}"))?
}

#[tauri::command]
pub fn travel_browser_stop(
    session_id: String,
    browsers: State<'_, TravelBrowsers>,
) -> Result<(), String> {
    validate_plan_id(&session_id).map_err(|_| "Sesión de Viajes no válida".to_string())?;
    browsers
        .0
        .lock()
        .map_err(|_| "No se pudo bloquear el visor de Viajes".to_string())?
        .remove(&session_id);
    Ok(())
}

#[tauri::command]
pub async fn travel_open_folder(trip_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, root) = canonical_travel_root(&trip_id)?;
        open_with_macos(&["-a", "Finder", root.to_string_lossy().as_ref()])?;
        Ok("Abriendo la carpeta completa del viaje en Finder.".to_string())
    })
    .await
    .map_err(|error| format!("La apertura de la carpeta se interrumpió: {error}"))?
}

fn percent_encode_mailto_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn travel_agency_mailto(trip: &TravelTrip) -> String {
    let destination = if trip.destination.is_empty() {
        "[COMPLETAR: evento y destino]"
    } else {
        trip.destination.as_str()
    };
    let start = trip.start_date.as_deref().unwrap_or("[COMPLETAR]");
    let end = trip.end_date.as_deref().unwrap_or("[COMPLETAR]");
    let subject = format!(
        "Solicitud de reserva de vuelos/alojamiento - Comisión de servicios {}",
        trip.name
    );
    let body = format!(
        "Buenos días,\n\nMe gustaría solicitar la reserva de [COMPLETAR: vuelos / tren / alojamiento] para asistir a {}.\n\nEvento / destino: {}\nFechas previstas: {} → {}\nCódigo de comisión / proyecto: [COMPLETAR]\n\nTransporte solicitado:\n- Ida: [COMPLETAR fecha, origen, destino, compañía, número y horario]\n- Vuelta: [COMPLETAR fecha, origen, destino, compañía, número y horario]\n- Tarifa / clase: [COMPLETAR; normalmente turista]\n- Equipaje: [COMPLETAR preferencias]\n\nAlojamiento, si procede:\n[COMPLETAR hotel, entrada, salida y preferencias]\n\nAdjunto a este correo:\n- [ADJUNTAR] DNI\n- [ADJUNTAR] Pasaporte, si procede\n- [ADJUNTAR] Formulario de gastos de viaje cumplimentado\n- [ADJUNTAR] Resolución favorable de comisión de servicios\n\nQuedo pendiente de vuestra propuesta y de la fecha límite de emisión. Antes de autorizarla revisaré nombre y apellidos, fechas, horarios, precio, cargo de emisión y equipaje incluido.\n\nMuchas gracias.\n\nUn saludo.",
        trip.name, destination, start, end
    );
    format!(
        "mailto:{}?subject={}&body={}",
        TRAVEL_AGENCY_EMAIL,
        percent_encode_mailto_component(&subject),
        percent_encode_mailto_component(&body)
    )
}

#[tauri::command]
pub async fn travel_open_agency_mail(
    trip_id: String,
    store: State<'_, TravelStore>,
) -> Result<String, String> {
    let store = Arc::clone(&store.0);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = store
            .lock()
            .map_err(|_| "No se pudo bloquear el registro de viajes".to_string())?;
        let registry = load_travel_registry()?;
        let trip = registry
            .trips
            .iter()
            .find(|trip| trip.id == trip_id)
            .ok_or_else(|| "Viaje no reconocido".to_string())?;
        let mailto = travel_agency_mailto(trip);
        open_with_macos(&["-a", "Mail", &mailto])?;
        Ok(format!(
            "Borrador abierto en Mail para {TRAVEL_AGENCY_EMAIL}; completa los datos y adjuntos antes de enviarlo."
        ))
    })
    .await
    .map_err(|error| format!("La preparación del correo se interrumpió: {error}"))?
}

#[tauri::command]
pub fn travel_open_resource(resource_id: String) -> Result<String, String> {
    verified_trips_root()?;
    let (destination, message) = match resource_id.as_str() {
        "uam_overview" => (
            TRAVEL_UAM_OVERVIEW,
            "Abriendo la guía vigente de viajes UAM.",
        ),
        "commission" => (
            TRAVEL_COMMISSION_URL,
            "Abriendo la Comisión de Servicios para PI.",
        ),
        "advance" | "advance_chrome" => (
            TRAVEL_ADVANCE_URL,
            "Abriendo la solicitud online de anticipo.",
        ),
        "advance_form" => (
            TRAVEL_ADVANCE_FORM_URL,
            "Abriendo el formulario alternativo de adelanto.",
        ),
        "justification" | "justification_chrome" => (
            TRAVEL_JUSTIFICATION_URL,
            "Abriendo la justificación online del viaje.",
        ),
        "expense_form" => (
            TRAVEL_EXPENSE_FORM_URL,
            "Abriendo el formulario de gastos de viaje.",
        ),
        "liquidation_form" => (
            TRAVEL_LIQUIDATION_FORM_URL,
            "Abriendo la liquidación de dietas y locomoción.",
        ),
        _ => return Err("Recurso de viaje no autorizado".to_string()),
    };
    if matches!(resource_id.as_str(), "advance_chrome" | "justification_chrome") {
        open_with_macos(&["-b", "com.google.Chrome", destination])
            .map_err(|_| "No se pudo abrir Google Chrome. Comprueba que esté instalado o usa el enlace del navegador habitual.".to_string())?;
    } else {
        open_with_macos(&[destination])?;
    }
    Ok(message.to_string())
}


#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn travel_is_optional_and_confined_to_its_own_workspace() {
        let disabled = config::testing::fixture();
        assert!(travel_root(&disabled.resolved).is_err());
        let fixture = config::testing::fixture_with(|v| { v["modules"]["travel"] = serde_json::json!({"enabled":true,"folder":"Viajes"}); });
        let root = fixture.resolved.workspace.join("Viajes");
        fs::create_dir(&root).unwrap();
        assert_eq!(travel_root(&fixture.resolved).unwrap(), root);
        fs::remove_dir(&root).unwrap();
        #[cfg(unix)] {
            std::os::unix::fs::symlink(&fixture.root, &root).unwrap();
            assert!(travel_root(&fixture.resolved).is_err());
        }
    }
    #[test]
    fn new_travel_registry_is_empty_and_has_nine_uam_steps() {
        let registry = TravelRegistry {version:1,revision:0,trips:Vec::new()};
        validate_travel_registry(&registry).unwrap();
        let overview = travel_overview_from(&registry);
        assert!(overview.trips.is_empty());
        assert_eq!(overview.workflow.len(), 9);
        assert!(overview.workflow.iter().any(|s| s.key == "submission"));
    }
}
