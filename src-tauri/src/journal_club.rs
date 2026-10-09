//! Personal preparation register. No authenticated scraping, remote publishing or PDF copies.
use serde::{Deserialize, Serialize};
use std::{fs::{self, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}, sync::{Arc, Mutex}};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use tauri::State;
const MAX_BYTES: usize = 8 * 1024 * 1024;
#[derive(Default)] pub struct JournalLock(pub Mutex<()>);
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Paper {
    pub id: String, pub title: String, pub url: String, pub library_uid: Option<String>,
    pub read: bool, pub reason: String,
    #[serde(default)] pub notes: String,
    #[serde(default)] pub questions: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Preparation {
    pub question: String, pub result: String, pub mechanism: String, pub model: String,
    pub figure: String, pub questions: String, pub connections: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Session {
    pub id: String, pub title: String, pub presenter: String, pub start: String, pub end: String,
    pub status: String, pub source: String, pub source_url: String, pub calendar_uid: Option<String>,
    pub papers: Vec<String>, pub projects: Vec<String>, pub preparation: Preparation,
    pub discussion: String, pub conclusions: String, pub tasks: String, pub ai: String,
    pub prepared: bool, pub recording_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Register { pub version: u8, pub revision: u64, pub sessions: Vec<Session>, pub papers: Vec<Paper> }
impl Default for Register { fn default() -> Self { Self { version: 1, revision: 0, sessions: vec![], papers: vec![] } } }
fn path() -> Result<PathBuf,String> { super::optional_register_path("journal", "journal-club.json") }
fn read_options() -> OpenOptions { let mut o=OpenOptions::new(); o.read(true); #[cfg(unix)] o.custom_flags(libc::O_NOFOLLOW); o }
fn write_options() -> OpenOptions { let mut o=OpenOptions::new(); o.write(true).create_new(true); #[cfg(unix)] o.mode(0o600); o }
fn id(s: &str) -> bool { !s.is_empty() && s.len() <= 80 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') }
fn url(s: &str) -> bool { s.is_empty() || url::Url::parse(s).is_ok_and(|u| matches!(u.scheme(), "https" | "http") && u.host_str().is_some() && u.username().is_empty() && u.password().is_none()) }
fn bounded(s: &str, n: usize) -> bool { s.chars().count() <= n && !s.contains('\0') }
fn validate(r: &Register) -> Result<(), String> {
    if r.version != 1 || r.sessions.len() > 300 || r.papers.len() > 600 { return Err("Registro de Journal Club no válido o demasiado grande".into()); }
    let mut ids = std::collections::HashSet::new();
    for p in &r.papers {
        if !id(&p.id) || !ids.insert(&p.id) || !bounded(&p.title, 600) || !bounded(&p.url, 2000) || !url(&p.url) || !bounded(&p.reason, 4000) || !bounded(&p.notes, 20000) || !bounded(&p.questions, 20000) || p.library_uid.as_ref().is_some_and(|s| !id(s)) { return Err("Paper de Journal Club no válido".into()); }
    }
    let mut sessions = std::collections::HashSet::new();
    for s in &r.sessions {
        if !id(&s.id) || !sessions.insert(&s.id) || s.title.trim().is_empty() || !bounded(&s.title,600) || !bounded(&s.presenter,200) || !bounded(&s.source,2000) || !bounded(&s.source_url,2000) || !url(&s.source_url)
            || !["proposed","confirmed","held","cancelled"].contains(&s.status.as_str())
            || s.papers.len() > 30 || s.papers.iter().any(|p| !ids.contains(p))
            || s.projects.len() > 10 || s.projects.iter().any(|p| !super::config::current().is_ok_and(|cfg| cfg.project(p).is_some()))
            || s.calendar_uid.as_ref().is_some_and(|v| !bounded(v, 500)) || s.recording_id.as_ref().is_some_and(|v| !id(v)) { return Err("Sesión de Journal Club no válida".into()); }
        if s.start.is_empty() != s.end.is_empty() { return Err("Indica inicio y fin de sesión".into()); }
        if !s.start.is_empty() { let start=chrono::DateTime::parse_from_rfc3339(&s.start).map_err(|_|"Inicio no válido")?; let end=chrono::DateTime::parse_from_rfc3339(&s.end).map_err(|_|"Fin no válido")?; if end<=start {return Err("El fin debe ser posterior al inicio".into());} }
        for text in [&s.preparation.question,&s.preparation.result,&s.preparation.mechanism,&s.preparation.model,&s.preparation.figure,&s.preparation.questions,&s.preparation.connections,&s.discussion,&s.conclusions,&s.tasks] { if !bounded(text,20000) { return Err("Un campo supera 20.000 caracteres".into()); } }
        if !bounded(&s.ai, 60000) { return Err("La ayuda generada supera el límite".into()); }
    }
    Ok(())
}
fn load_from(p: &Path) -> Result<Register,String> {
    if !fs::symlink_metadata(p.parent().ok_or("Ruta no válida")?).map_err(|e|e.to_string())?.is_dir() {return Err("Directorio no válido".into());}
    match fs::symlink_metadata(p) {
        Err(e) if e.kind()==std::io::ErrorKind::NotFound => return Ok(Register::default()),
        Err(e) => return Err(e.to_string()),
        Ok(m) if !m.is_file() || m.len()>MAX_BYTES as u64 => return Err("El registro no es un archivo normal o supera 8 MB".into()),
        _ => ()
    }
    let mut text=String::new();
    read_options().open(p).and_then(|f| f.take(MAX_BYTES as u64+1).read_to_string(&mut text)).map_err(|e| e.to_string())?;
    let r: Register=serde_json::from_str(&text).map_err(|e| format!("Registro dañado; se conserva sin sobrescribir: {e}"))?;
    validate(&r)?; Ok(r)
}
fn write_to(p: &Path, r: &Register) -> Result<(),String> {
    validate(r)?;
    let bytes=serde_json::to_vec_pretty(r).map_err(|e|e.to_string())?;
    if bytes.len()>MAX_BYTES { return Err("Journal Club supera 8 MB".into()); }
    let parent=p.parent().ok_or("Ruta no válida")?;
    if !fs::symlink_metadata(parent).map_err(|e|e.to_string())?.is_dir() { return Err("El directorio no es normal".into()); }
    if let Ok(m)=fs::symlink_metadata(p) { if !m.is_file() {return Err("No se siguen enlaces simbólicos".into());} }
    let temp=parent.join(format!(".journal-{}.tmp", super::new_plan_id()));
    let result=(|| { let mut file=write_options().open(&temp)?; file.write_all(&bytes)?; file.sync_all()?; fs::rename(&temp,p) })();
    if result.is_err() {let _=fs::remove_file(&temp);} result.map_err(|e|e.to_string())
}
fn checked(r: &Register, revision: u64) -> Result<(),String> { if r.revision!=revision { Err("Journal Club cambió en otra ventana. Tu borrador se conserva; vuelve a cargar antes de guardar.".into()) } else {Ok(())} }
#[tauri::command] pub fn journal_load(lock: State<'_,JournalLock>) -> Result<Register,String> { let _g=lock.0.lock().map_err(|_|"Journal Club ocupado")?; load_from(&path()?) }
#[tauri::command] pub fn journal_save(mut register: Register, expected_revision: u64, lock: State<'_,JournalLock>) -> Result<Register,String> {
    let _g=lock.0.lock().map_err(|_|"Journal Club ocupado")?; let old=load_from(&path()?)?; checked(&old,expected_revision)?;
    // Saving the editor never silently drops sessions or papers.
    if old.sessions.iter().any(|s| !register.sessions.iter().any(|n|n.id==s.id)) || old.papers.iter().any(|p|!register.papers.iter().any(|n|n.id==p.id)) {return Err("Se conservarán las sesiones y papers existentes; usa Cancelada para retirar una sesión".into());}
    register.revision=old.revision+1; write_to(&path()?,&register)?; Ok(register)
}
// Metadata UID survives reviewed library renames and moves.
#[tauri::command] pub async fn journal_link_library(paper_id: String, catalog: State<'_,super::LibraryCatalog>) -> Result<String,String> {
    let _ = path()?;
    let (key, collection) = super::library_key(&paper_id, &catalog.0)?;
    super::library_meta::ensure_uid(&key, &collection)
}
#[tauri::command] pub async fn journal_read_pdf(uid: String) -> Result<super::LibraryPreview,String> {
    let _ = path()?;
    if !id(&uid) {return Err("Referencia PDF no válida".into());}
    let cfg=super::config::current()?; let root=super::verified_library_root(&cfg)?;
    let register=super::library_meta::load_from(&root.join(".esprit-biblioteca.json"))?;
    let key=register.entries.iter().find(|entry|entry.uid.as_deref()==Some(&uid)).map(|entry|&entry.key).ok_or("El PDF ya no está vinculado; selecciónalo de nuevo en Biblioteca")?;
    let target=super::validate_confined_path(&root,&root.join(key))?;
    let id=super::new_plan_id(); let catalog=Arc::new(Mutex::new(std::collections::HashMap::from([(id.clone(),target)])));
    super::read_library_preview(&cfg,id,catalog)
}
fn markdown(s:&Session,r:&Register)->String {
    let mut out=format!("# {}\n\nPonente: {}\n\nFecha: {} — {}\n\nEstado: {}\n\nFuente: {} {}\n\n",s.title,s.presenter,s.start,s.end,s.status,s.source,s.source_url);
    for id in &s.papers {if let Some(p)=r.papers.iter().find(|p|&p.id==id) {out+=&format!("\n## {}\n\n{}\n",p.title,p.url); if !p.notes.is_empty() {out+=&format!("\n### Notas\n\n{}\n",p.notes);} if !p.questions.is_empty() {out+=&format!("\n### Preguntas\n\n{}\n",p.questions);}}}
    for (title,text) in [("Pregunta",&s.preparation.question),("Resultado demostrado",&s.preparation.result),("Mecanismo e intuición",&s.preparation.mechanism),("Modelo y supuestos",&s.preparation.model),("Figura clave y referencias",&s.preparation.figure),("Preguntas para el debate",&s.preparation.questions),("Conexiones propuestas",&s.preparation.connections),("Discusión",&s.discussion),("Conclusiones personales",&s.conclusions),("Decisiones y tareas",&s.tasks),("Texto generado anteriormente · archivo",&s.ai)] {if !text.is_empty() {out+=&format!("\n## {title}\n\n{text}\n");}} out
}
#[tauri::command] pub fn journal_export(id:String, expected_revision:u64, confirmed:bool, lock:State<'_,JournalLock>)->Result<String,String> {
    if !confirmed {return Err("Revisa la ficha antes de exportar".into());}
    let _g=lock.0.lock().map_err(|_|"Journal Club ocupado")?;let r=load_from(&path()?)?;checked(&r,expected_revision)?;
    let s=r.sessions.iter().find(|s|s.id==id).ok_or("Sesión no encontrada")?;
    let folder=path()?.parent().unwrap().join("JournalClubExports");
    match fs::symlink_metadata(&folder) {Ok(m) if !m.is_dir()=>return Err("Destino de exportación no válido".into()),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>fs::create_dir(&folder).map_err(|e|e.to_string())?,Err(e)=>return Err(e.to_string()),_=>()}
    let dest=folder.join(format!("journal-{}-{}.md",s.id,super::new_plan_id()));
    let mut f=write_options().open(&dest).map_err(|e|e.to_string())?;f.write_all(markdown(s,&r).as_bytes()).map_err(|e|e.to_string())?; f.sync_all().map_err(|e|e.to_string())?;Ok(dest.display().to_string())
}
#[cfg(test)] mod tests {
 use super::*;
 #[test] fn paper_notes_are_optional_for_legacy_records_and_exported() {
  let legacy=r#"{"id":"paper1","title":"Paper","url":"https://doi.org/10.1/test","library_uid":null,"read":false,"reason":"Existing reason"}"#;
  let mut paper:Paper=serde_json::from_str(legacy).unwrap();
  assert!(paper.notes.is_empty());assert!(paper.questions.is_empty());
  paper.notes="A personal observation".into();paper.questions="Why does this happen?".into();
  let session=Session{id:"s1".into(),title:"Session".into(),status:"proposed".into(),papers:vec!["paper1".into()],discussion:"Older discussion".into(),ai:"Legacy generated text".into(),..Default::default()};
  let mut register=Register{papers:vec![paper],sessions:vec![session],..Default::default()};
  validate(&register).unwrap();
  let loaded:Register=serde_json::from_str(&serde_json::to_string(&register).unwrap()).unwrap();
  assert_eq!(loaded.papers[0].notes,"A personal observation");assert_eq!(loaded.sessions[0].ai,"Legacy generated text");
  let output=markdown(&loaded.sessions[0],&loaded);
  for text in ["A personal observation","Why does this happen?","Older discussion","Legacy generated text"] {assert!(output.contains(text));}
  assert!(!output.contains("## Resultado demostrado"));
  register.papers[0].questions="x".repeat(20001);assert!(validate(&register).is_err());
 }
 #[test] fn persistence_conflicts_bounds_and_symlinks() {
  let dir=std::env::temp_dir().join(format!("esprit-journal-test-{}",super::super::new_plan_id()));fs::create_dir(&dir).unwrap();let p=dir.join("register.json");
  let mut r=Register::default();r.sessions.push(Session{id:"s1".into(),title:"Journal".into(),status:"proposed".into(),..Default::default()});r.sessions[0].preparation.result="Mis notas".into();write_to(&p,&r).unwrap();assert_eq!(load_from(&p).unwrap().sessions[0].preparation.result,"Mis notas");assert!(checked(&r,1).is_err());
  #[cfg(unix)] {let link=dir.join("link");std::os::unix::fs::symlink(&p,&link).unwrap();assert!(load_from(&link).is_err());assert!(write_to(&link,&r).is_err());}r.sessions[0].papers.push("missing".into());assert!(validate(&r).is_err());r.sessions[0].papers.clear();r.sessions[0].source_url="javascript:alert(1)".into();assert!(validate(&r).is_err());fs::remove_dir_all(dir).unwrap();
 }
}
