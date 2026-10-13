#![cfg_attr(not(target_os = "macos"), allow(dead_code))]
//! Lectura de Calendario en macOS mediante EventKit.
//!
//! La automatización de Calendar (JXA) devuelve solo el primer evento de cada
//! serie recurrente y puede tardar segundos por consulta en calendarios
//! grandes: un seminario semanal creado hace meses no aparecía nunca.
//! EventKit expande cada repetición y responde al momento. Las escrituras
//! (crear eventos) siguen por las rutas JXA revisadas de `lib.rs`. Sin acceso
//! completo a Calendarios, `lib.rs` vuelve a la lectura JXA, que expande las
//! series con `resources/calendar_recurrence.js`.

use chrono::{Duration, NaiveDate, SecondsFormat, TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::{json, Value};

/// Instante (ms) de las 00:00 de una fecha civil en la zona configurada.
fn local_midnight_ms(zone: &Tz, date: NaiveDate) -> i64 {
    let naive = date.and_hms_opt(0, 0, 0).expect("medianoche válida");
    zone.from_local_datetime(&naive)
        .earliest()
        // Si un cambio de hora salta la medianoche, la primera hora válida.
        .or_else(|| zone.from_local_datetime(&(naive + Duration::hours(1))).earliest())
        .map(|value| value.timestamp_millis())
        .unwrap_or_else(|| naive.and_utc().timestamp_millis())
}

/// Ventana leída: desde hoy hasta 120 días después, en la zona configurada.
pub fn read_range(now_ms: i64, zone: &str) -> (i64, i64) {
    let tz: Tz = zone.parse().unwrap_or(chrono_tz::UTC);
    let now = Utc.timestamp_millis_opt(now_ms).single().unwrap_or_else(Utc::now);
    let today = now.with_timezone(&tz).date_naive();
    (local_midnight_ms(&tz, today), local_midnight_ms(&tz, today + Duration::days(120)))
}

/// Mismo formato que `Date.prototype.toISOString`.
pub fn iso_ms(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms).single().map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true)).unwrap_or_default()
}

pub struct RawEvent {
    pub calendar: String,
    pub uid: String,
    pub title: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub all_day: bool,
    pub location: Option<String>,
}

/// Da a los eventos de EventKit la forma que ya lee el espacio Calendario.
/// Un calendario añadido dos veces (mismo nombre) aporta cada evento una vez.
#[allow(clippy::too_many_arguments)]
pub fn overview(read: &[String], write: &[String], calendars: &[(String, bool)], mut raw: Vec<RawEvent>, range: (i64, i64), now_ms: i64, zone: &str, limit: usize) -> Value {
    let selected: Vec<&String> = read.iter().filter(|name| calendars.iter().any(|(title, _)| title == *name)).collect();
    let missing: Vec<&String> = read.iter().filter(|name| !calendars.iter().any(|(title, _)| title == *name)).collect();
    let writable: Vec<&String> = selected
        .iter()
        .copied()
        .filter(|name| write.contains(name) && calendars.iter().any(|(title, allowed)| title == *name && *allowed))
        .collect();
    raw.retain(|event| selected.iter().any(|name| **name == event.calendar) && event.start_ms < range.1 && event.end_ms > range.0);
    raw.sort_by(|a, b| a.start_ms.cmp(&b.start_ms).then_with(|| a.title.cmp(&b.title)).then_with(|| a.uid.cmp(&b.uid)));
    let mut seen = std::collections::HashSet::new();
    raw.retain(|event| seen.insert((event.calendar.clone(), event.title.clone(), event.start_ms, event.end_ms, event.all_day)));
    let total = raw.len();
    let events: Vec<Value> = raw
        .iter()
        .take(limit)
        .map(|event| {
            let start = iso_ms(event.start_ms);
            let key = if event.uid.is_empty() { event.title.as_str() } else { event.uid.as_str() };
            json!({
                // Las repeticiones de una serie comparten UID: el inicio las distingue.
                "id": format!("{}::{}::{}", event.calendar, key, start),
                "calendar": event.calendar,
                "title": event.title,
                "start": start,
                "end": iso_ms(event.end_ms),
                "all_day": event.all_day,
                "location": event.location,
            })
        })
        .collect();
    json!({
        "connected": true,
        "source": "eventkit",
        "checked_at": now_ms,
        "time_zone": zone,
        "calendars": selected,
        "selected_calendars": selected,
        "read_calendars": read,
        "write_calendars": write,
        "writable_calendars": writable,
        "missing_calendars": missing,
        "total_events": total,
        "truncated": total > limit,
        "events": events,
        "range_end": iso_ms(range.1),
    })
}

#[cfg(target_os = "macos")]
pub mod native {
    use super::RawEvent;
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_event_kit::{EKAuthorizationStatus, EKEntityType, EKEventStore};
    use objc2_foundation::{NSArray, NSDate, NSError};
    use std::sync::mpsc;
    use std::time::Duration;

    pub enum Read {
        Events { calendars: Vec<(String, bool)>, events: Vec<RawEvent> },
        /// Sin acceso completo: quien llama vuelve a la lectura JXA.
        NoAccess(&'static str),
    }

    fn ensure_access(store: &EKEventStore) -> Result<(), &'static str> {
        let status = unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Event) };
        if status == EKAuthorizationStatus::FullAccess {
            return Ok(());
        }
        if status != EKAuthorizationStatus::NotDetermined {
            return Err(if status == EKAuthorizationStatus::WriteOnly {
                "macOS solo permite a Esprit añadir eventos, no leerlos"
            } else {
                "macOS no permite a Esprit leer Calendarios"
            });
        }
        // Primera vez: macOS pregunta una sola vez; la respuesta llega en otra cola.
        let (sender, receiver) = mpsc::channel::<bool>();
        let block = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
            let _ = sender.send(granted.as_bool());
        });
        unsafe { store.requestFullAccessToEventsWithCompletion(&*block as *const _ as *mut _) };
        match receiver.recv_timeout(Duration::from_secs(180)) {
            Ok(true) => Ok(()),
            Ok(false) => Err("macOS no permite a Esprit leer Calendarios"),
            Err(_) => Err("La solicitud de acceso a Calendarios no recibió respuesta"),
        }
    }

    pub fn read(start_ms: i64, end_ms: i64, wanted: &[String], refresh: bool) -> Read {
        let store = unsafe { EKEventStore::new() };
        if let Err(reason) = ensure_access(&store) {
            return Read::NoAccess(reason);
        }
        if refresh {
            unsafe { store.refreshSourcesIfNecessary() };
        }
        let all = unsafe { store.calendarsForEntityType(EKEntityType::Event) };
        let mut calendars = Vec::new();
        let mut chosen = Vec::new();
        for calendar in all.iter() {
            let title = unsafe { calendar.title() }.to_string();
            if !wanted.contains(&title) {
                continue;
            }
            calendars.push((title, unsafe { calendar.allowsContentModifications() }));
            chosen.push(calendar);
        }
        if calendars.is_empty() {
            return Read::Events { calendars, events: Vec::new() };
        }
        let chosen = NSArray::from_retained_slice(&chosen);
        let start = NSDate::dateWithTimeIntervalSince1970(start_ms as f64 / 1000.0);
        let end = NSDate::dateWithTimeIntervalSince1970(end_ms as f64 / 1000.0);
        let predicate = unsafe { store.predicateForEventsWithStartDate_endDate_calendars(&start, &end, Some(&chosen)) };
        let found = unsafe { store.eventsMatchingPredicate(&predicate) };
        let mut events = Vec::with_capacity(found.count());
        for event in found.iter() {
            let calendar = match unsafe { event.calendar() } {
                Some(calendar) => unsafe { calendar.title() }.to_string(),
                None => continue,
            };
            let ms = |date: objc2::rc::Retained<NSDate>| (date.timeIntervalSince1970() * 1000.0).round() as i64;
            let title = unsafe { event.title() }.to_string();
            events.push(RawEvent {
                calendar,
                uid: unsafe { event.calendarItemExternalIdentifier() }.map(|value| value.to_string()).unwrap_or_default(),
                title: if title.trim().is_empty() { "Sin título".to_string() } else { title },
                start_ms: ms(unsafe { event.startDate() }),
                end_ms: ms(unsafe { event.endDate() }),
                all_day: unsafe { event.isAllDay() },
                location: unsafe { event.location() }.map(|value| value.to_string()).filter(|value| !value.trim().is_empty()),
            });
        }
        Read::Events { calendars, events }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_read_window_follows_the_configured_zone() {
        let now = Utc.with_ymd_and_hms(2026, 10, 13, 12, 0, 0).unwrap().timestamp_millis();
        let (start, end) = read_range(now, "Europe/Madrid");
        assert_eq!(iso_ms(start), "2026-10-12T22:00:00.000Z");
        assert_eq!(iso_ms(end), "2027-02-09T23:00:00.000Z");
        let (start, _) = read_range(now, "America/Santiago");
        assert_eq!(iso_ms(start), "2026-10-13T03:00:00.000Z");
        assert_eq!(read_range(now, "no/zone").0, Utc.with_ymd_and_hms(2026, 10, 13, 0, 0, 0).unwrap().timestamp_millis());
    }

    fn event(calendar: &str, uid: &str, start_ms: i64) -> RawEvent {
        RawEvent { calendar: calendar.into(), uid: uid.into(), title: "Seminario".into(), start_ms, end_ms: start_ms + 3_600_000, all_day: false, location: None }
    }

    #[test]
    fn series_occurrences_get_distinct_ids_and_duplicate_copies_count_once() {
        let day = 86_400_000;
        let read = vec!["Grupo".to_string(), "Personal".to_string(), "Ausente".to_string()];
        let write = vec!["Personal".to_string()];
        let calendars = vec![("Grupo".to_string(), true), ("Grupo".to_string(), true), ("Personal".to_string(), true), ("Otro".to_string(), true)];
        let raw = vec![event("Grupo", "s", day), event("Grupo", "copy", day), event("Grupo", "s", 8 * day), event("Otro", "x", day), event("Personal", "p", 200 * day)];
        let value = overview(&read, &write, &calendars, raw, (0, 10 * day), 0, "Europe/Madrid", 1000);
        assert_eq!(value["total_events"], 2);
        assert_eq!(value["events"][0]["id"], "Grupo::copy::1970-01-02T00:00:00.000Z");
        assert_eq!(value["events"][1]["id"], "Grupo::s::1970-01-09T00:00:00.000Z");
        assert_eq!(value["writable_calendars"], json!(["Personal"]));
        assert_eq!(value["missing_calendars"], json!(["Ausente"]));
    }
}
