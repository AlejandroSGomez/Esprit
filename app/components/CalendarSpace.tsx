'use client';

import { CSSProperties, FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import SplitDivider from './SplitDivider';
import { useResizableSplit } from './useResizableSplit';
import { getAppTimeZone } from '../appConfig';
import { dateKeyFromParts, zonedDateKey, zonedParts, zonedWallTimeIso } from '../timeZone';

export type CalendarEvent = {
  id: string;
  calendar: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string | null;
};

export type CalendarOverview = {
  connected: boolean;
  checked_at: number;
  calendars: string[];
  selected_calendars: string[];
  writable_calendars: string[];
  total_events: number;
  truncated: boolean;
  events: CalendarEvent[];
  range_end: string;
};

const weekdays = ['LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB', 'DOM'];

/** Hora de reloj de la zona configurada como instante ISO con desplazamiento. */
const wallTimeIso = (date: string, time: string) => zonedWallTimeIso(date, time, getAppTimeZone());

const abstractDateKey = (date: Date) => dateKeyFromParts({
  year: date.getFullYear(),
  month: date.getMonth() + 1,
  day: date.getDate(),
});

/** Hoy en la zona configurada, como fecha abstracta al mediodía. */
const zonedToday = () => {
  const parts = zonedParts(new Date(), getAppTimeZone());
  return new Date(parts.year, parts.month - 1, parts.day, 12, 0, 0);
};

const startOfMonth = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1);

/** Lunes de la semana de `date`, en fecha abstracta al mediodía. */
const startOfWeek = (date: Date) => {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
};

const addDays = (date: Date, amount: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
};

type CalendarView = 'month' | 'week' | 'day';

const calendarViews: Array<{ id: CalendarView; label: string }> = [
  { id: 'month', label: 'Mes' },
  { id: 'week', label: 'Semana' },
  { id: 'day', label: 'Día' },
];
const CALENDAR_VIEW_KEY = 'esprit-calendar-view';
const isCalendarView = (value: string | null): value is CalendarView => (
  value === 'month' || value === 'week' || value === 'day'
);

/**
 * Las vistas de semana y día muestran las 24 horas y se desplazan. Recortar la
 * franja escondía sin avisar cualquier evento fuera de ella, incluida la cola
 * de uno que cruza la medianoche.
 */
const GRID_START_HOUR = 0;
const GRID_END_HOUR = 24;
const GRID_HOURS = Array.from({ length: GRID_END_HOUR - GRID_START_HOUR }, (_, index) => GRID_START_HOUR + index);
const GRID_SLOT_HEIGHT = 80;
/** Hora a la que se sitúa el desplazamiento inicial. */
const GRID_FOCUS_HOUR = 7;
const localDateKey = (date = new Date()) => zonedDateKey(date, getAppTimeZone());

const formatEventTime = (event: CalendarEvent) => {
  if (event.all_day) return 'Todo el día';
  const start = new Date(event.start);
  return `${start.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: getAppTimeZone() })}–${new Date(event.end).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: getAppTimeZone() })}`;
};

const formatEventDate = (event: CalendarEvent) => {
  const start = new Date(event.start);
  const day = start.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: getAppTimeZone() });
  if (event.all_day) return `${day} · todo el día`;
  return `${day} · ${formatEventTime(event)}`;
};

/**
 * Color de cada calendario según su posición en `modules.calendar.read`: el
 * primero y el segundo tienen tono propio; el resto comparte uno neutro.
 */
const calendarRole = (calendar: string, readCalendars: string[]) => {
  const index = readCalendars.indexOf(calendar);
  if (index === 0) return 'cal-primary';
  if (index === 1) return 'cal-secondary';
  return 'additional';
};

const calendarRoleLabel = (calendar: string, overview: CalendarOverview | null) => {
  if (!overview?.calendars.includes(calendar)) return null;
  return overview.writable_calendars.includes(calendar) ? 'EDITABLE' : 'SOLO LECTURA';
};

export default function CalendarSpace({
  overview,
  loading,
  error,
  readCalendars,
  writeCalendars,
  onRefresh,
  onOpenCalendar,
  onCreateEvent,
}: {
  overview: CalendarOverview | null;
  loading: boolean;
  error: string | null;
  /** Calendarios de la configuración que Esprit lee, en su orden. */
  readCalendars: string[];
  /** Calendarios donde la configuración permite crear eventos. */
  writeCalendars: string[];
  onRefresh: () => void;
  onOpenCalendar: () => void;
  onCreateEvent: (event: { calendar: string; title: string; start: string; end: string; all_day: boolean; confirmed: boolean }) => Promise<void>;
}) {
  const [view, setView] = useState<CalendarView>(() => {
    if (typeof window === 'undefined') return 'month';
    const stored = window.localStorage.getItem(CALENDAR_VIEW_KEY);
    return isCalendarView(stored) ? stored : 'month';
  });
  // Un único ancla para las tres vistas: el mes, la semana y el día se derivan
  // de ella, así que cambiar de vista conserva la fecha que estabas mirando.
  const [anchor, setAnchor] = useState(() => zonedToday());
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createReview, setCreateReview] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ calendar: writeCalendars[0] ?? '', title: '', date: localDateKey(), all_day: true, start_time: '09:00', end_time: '10:00' });
  const sourceSplit = useResizableSplit({ collapsible: true, storageKey: 'esprit-calendar-source-split', defaultValue: 18, min: 14, max: 30 });
  const agendaSplit = useResizableSplit({ collapsible: true, storageKey: 'esprit-calendar-agenda-split', defaultValue: 76, min: 62, max: 86 });
  const events = useMemo(() => overview?.events ?? [], [overview]);
  // Solo se ofrecen los calendarios de escritura de la configuración que
  // Calendar confirma como disponibles y editables en este momento.
  const writableCalendars = useMemo(() => {
    if (error) return [];
    const available = new Set(overview?.calendars ?? []);
    const writable = new Set(overview?.writable_calendars ?? []);
    return writeCalendars
      .filter((name, index, values) => values.indexOf(name) === index && available.has(name) && writable.has(name));
  }, [error, overview, writeCalendars]);
  const coreSources = useMemo(() => readCalendars.map((name) => ({ name, role: calendarRole(name, readCalendars) })), [readCalendars]);
  const availableSourceCount = coreSources.filter((source) => overview?.calendars.includes(source.name)).length;

  const visibleMonth = useMemo(() => startOfMonth(anchor), [anchor]);

  const days = useMemo(() => {
    const first = startOfMonth(visibleMonth);
    const mondayOffset = (first.getDay() + 6) % 7;
    const gridStart = new Date(first);
    gridStart.setDate(first.getDate() - mondayOffset);
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + index);
      return date;
    });
  }, [visibleMonth]);

  // Días de la vista de semana o día. La de mes sigue usando `days`.
  const rangeDays = useMemo(() => {
    if (view === 'day') return [new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 12, 0, 0)];
    if (view === 'week') return Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(anchor), index));
    return [];
  }, [anchor, view]);

  /** Eventos de un día, separando los de todo el día de los que tienen hora. */
  const dayBuckets = useMemo(() => rangeDays.map((date) => {
    const key = abstractDateKey(date);
    const dayStart = new Date(wallTimeIso(key, '00:00'));
    const dayEnd = new Date(wallTimeIso(abstractDateKey(addDays(date, 1)), '00:00'));
    const inDay = events.filter((event) => new Date(event.start) < dayEnd && new Date(event.end) > dayStart);
    const spanMs = dayEnd.getTime() - dayStart.getTime();
    return {
      date,
      key,
      allDay: inDay.filter((event) => event.all_day),
      timed: inDay.filter((event) => !event.all_day).map((event) => {
        // Se recorta a los límites del día para que un evento que cruza la
        // medianoche no se salga de la columna.
        const from = Math.max(new Date(event.start).getTime(), dayStart.getTime());
        const to = Math.min(new Date(event.end).getTime(), dayEnd.getTime());
        return {
          event,
          startFraction: (from - dayStart.getTime()) / spanMs,
          endFraction: (to - dayStart.getTime()) / spanMs,
          /** Tramo que viene del día anterior, no un evento que empiece aquí. */
          continues: new Date(event.start).getTime() < dayStart.getTime(),
        };
      }),
    };
  }), [events, rangeDays]);

  const selectedEvent = events.find((event) => event.id === selectedEventId) ?? events[0] ?? null;
  const currentMonth = startOfMonth(zonedToday());
  const rangeEnd = overview ? startOfMonth(new Date(overview.range_end)) : null;
  const todayAnchor = zonedToday();
  const canGoPrevious = view === 'month'
    ? visibleMonth.getTime() > currentMonth.getTime()
    : anchor.getTime() > todayAnchor.getTime();
  const canGoNext = view === 'month'
    ? (!rangeEnd || visibleMonth.getTime() < rangeEnd.getTime())
    : (!overview || anchor.getTime() < new Date(overview.range_end).getTime());

  const rangeTitle = view === 'month'
    ? visibleMonth.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })
    : view === 'day'
      ? anchor.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })
      : (() => {
        const monday = startOfWeek(anchor);
        const sunday = addDays(monday, 6);
        const sameMonth = monday.getMonth() === sunday.getMonth();
        const from = monday.toLocaleDateString('es-ES', sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' });
        const to = sunday.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });
        return `${from} – ${to}`;
      })();

  // La rejilla arranca cerca de la mañana en lugar de a medianoche, pero sin
  // recortar el día: todo sigue alcanzable desplazándose.
  const timegridRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (view === 'month') return;
    const node = timegridRef.current;
    if (!node) return;
    // Los tramos heredados del día anterior empiezan a las 00:00 y no deben
    // arrastrar la vista hasta la medianoche.
    const earliest = dayBuckets
      .flatMap((bucket) => bucket.timed)
      .filter((entry) => !entry.continues)
      .reduce((value, entry) => Math.min(value, entry.startFraction * 24), GRID_FOCUS_HOUR);
    node.scrollTop = Math.max(0, Math.floor(earliest) - 1) * GRID_SLOT_HEIGHT;
  }, [dayBuckets, view]);

  const selectView = (next: CalendarView) => {
    setView(next);
    window.localStorage.setItem(CALENDAR_VIEW_KEY, next);
  };

  const eventsByDay = useMemo(() => days.map((date) => {
    const nextDate = new Date(date);
    nextDate.setDate(nextDate.getDate() + 1);
    const dayStart = new Date(wallTimeIso(abstractDateKey(date), '00:00'));
    const dayEnd = new Date(wallTimeIso(abstractDateKey(nextDate), '00:00'));
    return events.filter((event) => new Date(event.start) < dayEnd && new Date(event.end) > dayStart);
  }), [days, events]);
  const todayKey = localDateKey();

  /** Avanza un mes, una semana o un día según la vista activa. */
  const moveRange = (amount: number) => {
    if (view === 'month') {
      const next = new Date(visibleMonth);
      next.setMonth(next.getMonth() + amount);
      setAnchor(startOfMonth(next));
      return;
    }
    setAnchor(addDays(anchor, view === 'week' ? amount * 7 : amount));
  };

  const openCreate = () => {
    const defaultCalendar = writableCalendars.includes(draft.calendar) ? draft.calendar : writableCalendars[0] ?? '';
    setDraft((current) => ({ ...current, calendar: defaultCalendar, date: localDateKey() }));
    setCreateOpen(true);
    setCreateReview(false);
    setCreateError(null);
  };

  const reviewCreate = (event: FormEvent) => {
    event.preventDefault();
    if (!writableCalendars.includes(draft.calendar)) { setCreateError('Calendar ya no confirma que ese destino sea editable. Sincroniza y vuelve a seleccionarlo.'); return; }
    if (draft.title.trim().length < 2) { setCreateError('Escribe un título para el evento.'); return; }
    if (!draft.all_day && draft.end_time <= draft.start_time) { setCreateError('La hora final debe ser posterior a la inicial.'); return; }
    try {
      wallTimeIso(draft.date, draft.all_day ? '00:00' : draft.start_time);
      wallTimeIso(draft.date, draft.all_day ? '00:00' : draft.end_time);
    } catch (reason) { setCreateError(String(reason)); return; }
    setCreateError(null);
    setCreateReview(true);
  };

  const confirmCreate = async () => {
    if (!writableCalendars.includes(draft.calendar)) {
      setCreateReview(false);
      setCreateError('Calendar ya no confirma que ese destino sea editable. Sincroniza y vuelve a seleccionarlo.');
      return;
    }
    setCreateBusy(true);
    try {
      let endDate = draft.date;
      if (draft.all_day) {
        const end = new Date(`${draft.date}T12:00:00`);
        end.setDate(end.getDate() + 1);
        endDate = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
      }
      await onCreateEvent({
        calendar: draft.calendar,
        title: draft.title.trim(),
        start: wallTimeIso(draft.date, draft.all_day ? '00:00' : draft.start_time),
        end: wallTimeIso(endDate, draft.all_day ? '00:00' : draft.end_time),
        all_day: draft.all_day,
        confirmed: true,
      });
      setCreateOpen(false);
      setCreateReview(false);
      setDraft((current) => ({ ...current, title: '' }));
    } catch (reason) { setCreateError(String(reason)); }
    finally { setCreateBusy(false); }
  };

  return (
    <div className="calendar-space" style={{ '--calendar-source-track': sourceSplit.track(170), '--calendar-agenda-track': agendaSplit.collapsed ? '0px' : `minmax(var(--split-min, 210px), ${100 - agendaSplit.value}%)` } as CSSProperties}>
      <aside className="calendar-sources">
        <header><div><span>FUENTES</span><h3>Mis calendarios</h3></div><button onClick={onRefresh} disabled={loading} type="button" aria-label="Sincronizar calendarios">{loading ? '…' : '↻'}</button></header>
        <button className="calendar-create-trigger" onClick={openCreate} disabled={loading || writableCalendars.length === 0} title={writableCalendars.length === 0 ? 'Calendar no informa de ningún destino editable' : undefined} type="button">＋ Nuevo evento</button>
        <div className="calendar-source-list">
          {coreSources.map((source) => {
            const available = overview?.calendars.includes(source.name) ?? false;
            return <article className={`core ${source.role}${available ? ' available' : ''}`} key={source.name}><i aria-hidden="true">{available ? '✓' : overview ? '!' : '·'}</i><div><strong>{source.name}</strong><span>{available ? calendarRoleLabel(source.name, overview) : overview ? 'NO DISPONIBLE' : 'SINCRONIZANDO'}</span></div></article>;
          })}
          {!overview && !error ? <div className="calendar-source-state">Leyendo Calendar…</div> : null}
          {error ? <div className="calendar-source-state error">{error}</div> : null}
        </div>
        <footer><i className={error ? 'error' : ''} /><div><strong>{error ? 'Acceso pendiente' : 'Calendar de macOS'}</strong><span>{error ? 'Permisos sin verificar' : overview ? `${availableSourceCount}/${coreSources.length} disponibles · ${writableCalendars.length} editables` : 'Conexión local'}</span></div></footer>
      </aside>
      <SplitDivider split={sourceSplit} className="calendar-resizer" label="Cambiar ancho de los calendarios" paneLabel="los calendarios" />
      <section className="calendar-month">
        <header>
          <div><span>AGENDA SINCRONIZADA</span><h3>{rangeTitle}</h3></div>
          <div className="calendar-month-actions">
            <div className="calendar-view-switch" role="tablist" aria-label="Vista del calendario">
              {calendarViews.map((option) => (
                <button
                  className={view === option.id ? 'active' : ''}
                  onClick={() => selectView(option.id)}
                  type="button"
                  role="tab"
                  aria-selected={view === option.id}
                  key={option.id}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <button onClick={() => setAnchor(zonedToday())} type="button">Hoy</button>
            <button onClick={() => moveRange(-1)} disabled={!canGoPrevious} type="button" aria-label={view === 'month' ? 'Mes anterior' : view === 'week' ? 'Semana anterior' : 'Día anterior'}>←</button>
            <button onClick={() => moveRange(1)} disabled={!canGoNext} type="button" aria-label={view === 'month' ? 'Mes siguiente' : view === 'week' ? 'Semana siguiente' : 'Día siguiente'}>→</button>
          </div>
        </header>
        {view === 'month' ? (
        <div className="calendar-month-grid">
          {weekdays.map((weekday) => <div className="calendar-weekday" key={weekday}>{weekday}</div>)}
          {days.map((date, index) => {
            const dayEvents = eventsByDay[index];
            const outside = date.getMonth() !== visibleMonth.getMonth();
            const today = abstractDateKey(date) === todayKey;
            return <div className={`${outside ? 'calendar-day outside ' : 'calendar-day '}${today ? 'today' : ''}`.trim()} key={date.toISOString()}><span>{date.getDate()}</span><div>{dayEvents.slice(0, 2).map((event) => <button className={calendarRole(event.calendar, readCalendars)} key={`${event.id}-${date.toISOString()}`} onClick={() => setSelectedEventId(event.id)} type="button" aria-pressed={selectedEventId === event.id}><i />{event.all_day ? '' : new Date(event.start).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: getAppTimeZone() }) + ' '}{event.title}</button>)}{dayEvents.length > 2 ? <small>+ {dayEvents.length - 2} más</small> : null}</div></div>;
          })}
        </div>
        ) : null}

        {view !== 'month' ? (
          <div className={`calendar-timegrid${view === 'day' ? ' single' : ''}`} style={{ '--calendar-columns': String(dayBuckets.length), '--calendar-hour-height': `${GRID_SLOT_HEIGHT}px` } as CSSProperties}>
            <div className="calendar-timegrid-head">
              <span className="calendar-timegrid-corner" aria-hidden="true" />
              {dayBuckets.map((bucket) => (
                <div className={`calendar-timegrid-day${bucket.key === todayKey ? ' today' : ''}`} key={bucket.key}>
                  <b>{bucket.date.toLocaleDateString('es-ES', { weekday: 'short' })}</b>
                  <i>{bucket.date.getDate()}</i>
                </div>
              ))}
            </div>

            {dayBuckets.some((bucket) => bucket.allDay.length) ? (
              <div className="calendar-timegrid-allday">
                <span>TODO EL DÍA</span>
                {dayBuckets.map((bucket) => (
                  <div key={bucket.key}>
                    {bucket.allDay.map((event) => (
                      <button
                        className={`${selectedEvent?.id === event.id ? 'active ' : ''}${calendarRole(event.calendar, readCalendars)}`.trim()}
                        onClick={() => setSelectedEventId(event.id)}
                        type="button"
                        title={event.title}
                        key={event.id}
                      >
                        {event.title}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}

            <div className="calendar-timegrid-body" ref={timegridRef}>
              <div className="calendar-timegrid-hours" aria-hidden="true">
                {GRID_HOURS.map((hour) => <span key={hour}>{String(hour).padStart(2, '0')}:00</span>)}
              </div>
              {dayBuckets.map((bucket) => (
                <div className="calendar-timegrid-column" key={bucket.key}>
                  {GRID_HOURS.map((hour) => <div className="calendar-timegrid-slot" key={hour} />)}
                  {bucket.timed.map(({ event, startFraction, endFraction }) => {
                    // Las fracciones cubren el día completo; aquí se reescalan a
                    // la franja visible, y lo que quede fuera se recorta.
                    const windowStart = GRID_START_HOUR / 24;
                    const windowSpan = (GRID_END_HOUR - GRID_START_HOUR) / 24;
                    const top = (Math.max(startFraction, windowStart) - windowStart) / windowSpan;
                    const bottom = (Math.min(endFraction, GRID_END_HOUR / 24) - windowStart) / windowSpan;
                    if (bottom <= 0 || top >= 1) return null;
                    return (
                      <button
                        className={`calendar-timegrid-event ${calendarRole(event.calendar, readCalendars)}${selectedEvent?.id === event.id ? ' active' : ''}`}
                        style={{ top: `${top * 100}%`, height: `${Math.max(bottom - top, 0.02) * 100}%` }}
                        onClick={() => setSelectedEventId(event.id)}
                        type="button"
                        title={`${event.title} · ${formatEventTime(event)}`}
                        key={`${event.id}-${bucket.key}`}
                      >
                        <b>{formatEventTime(event)}</b>
                        <span>{event.title}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {selectedEventId && selectedEvent ? (
          <article className={`calendar-compact-detail ${calendarRole(selectedEvent.calendar, readCalendars)}`} aria-live="polite">
            <div><small>{calendarRoleLabel(selectedEvent.calendar, overview) ?? selectedEvent.calendar}</small><strong>{selectedEvent.title}</strong><span>{formatEventDate(selectedEvent)}{selectedEvent.location ? ` · ${selectedEvent.location}` : ''}</span></div>
            <button onClick={() => setSelectedEventId(null)} type="button" aria-label="Cerrar detalle del evento">×</button>
          </article>
        ) : null}
      </section>
      <SplitDivider split={agendaSplit} className="calendar-resizer" label="Cambiar ancho de la agenda" paneLabel="la agenda" />
      <aside className="calendar-agenda">
        <header><span>PRÓXIMOS</span><button onClick={onOpenCalendar} type="button">Abrir Calendar ↗</button></header>
        {selectedEvent ? <article className={`calendar-event-detail ${calendarRole(selectedEvent.calendar, readCalendars)}`}><small>{calendarRoleLabel(selectedEvent.calendar, overview) ? `${calendarRoleLabel(selectedEvent.calendar, overview)} · ` : ''}{selectedEvent.calendar}</small><h3>{selectedEvent.title}</h3><p>{formatEventDate(selectedEvent)}</p>{selectedEvent.location ? <p className="location">⌖ {selectedEvent.location}</p> : null}</article> : null}
        <div className="calendar-agenda-list">
          {events.slice(0, 16).map((event) => <button className={`${selectedEvent?.id === event.id ? 'active ' : ''}${calendarRole(event.calendar, readCalendars)}`.trim()} key={event.id} onClick={() => setSelectedEventId(event.id)} type="button" aria-pressed={selectedEvent?.id === event.id}><time><strong>{new Date(event.start).toLocaleDateString('es-ES', { day: 'numeric', timeZone: getAppTimeZone() })}</strong><span>{new Date(event.start).toLocaleDateString('es-ES', { month: 'short', timeZone: getAppTimeZone() })}</span></time><div><small>{event.calendar}</small><h4>{event.title}</h4><p>{formatEventTime(event)}</p></div></button>)}
          {!loading && !error && events.length === 0 ? <div className="calendar-agenda-empty">No hay eventos en los próximos cuatro meses para la selección actual.</div> : null}
        </div>
        <footer>{overview ? `Actualizado ${new Date(overview.checked_at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}` : 'Sincronización local y privada'}</footer>
      </aside>

      {createOpen ? <div className="calendar-create-layer" role="dialog" aria-modal="true" aria-label="Crear evento"><form onSubmit={reviewCreate}><header><div><span>CALENDAR / REVISIÓN</span><h3>{createReview ? 'Confirmar evento' : 'Nuevo evento'}</h3></div><button onClick={() => setCreateOpen(false)} type="button">×</button></header>{!createReview ? <><label><span>DESTINO</span><select value={draft.calendar} onChange={(event) => setDraft((current) => ({ ...current, calendar: event.target.value }))}>{writableCalendars.map((calendar) => <option key={calendar}>{calendar}</option>)}</select></label><label><span>TÍTULO</span><input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} autoFocus /></label><label><span>FECHA</span><input type="date" value={draft.date} onChange={(event) => setDraft((current) => ({ ...current, date: event.target.value }))} /></label><label className="calendar-all-day"><span>TODO EL DÍA</span><input type="checkbox" checked={draft.all_day} onChange={(event) => setDraft((current) => ({ ...current, all_day: event.target.checked }))} /></label>{!draft.all_day ? <div><label><span>INICIO</span><input type="time" value={draft.start_time} onChange={(event) => setDraft((current) => ({ ...current, start_time: event.target.value }))} /></label><label><span>FIN</span><input type="time" value={draft.end_time} onChange={(event) => setDraft((current) => ({ ...current, end_time: event.target.value }))} /></label></div> : null}<footer><button type="submit">Revisar →</button></footer></> : <div className="calendar-create-review"><small>{draft.calendar}</small><h4>{draft.title}</h4><p>{draft.date} · {draft.all_day ? 'todo el día' : `${draft.start_time}–${draft.end_time}`}</p><aside>Este evento se guardará en el calendario «{draft.calendar}»; si está compartido, sus miembros también lo verán. Esprit volverá a comprobar el permiso justo antes de crearlo; los próximos Login y Logout lo leerán desde Calendar.</aside><footer><button onClick={() => setCreateReview(false)} type="button">Editar</button><button className="primary" onClick={() => void confirmCreate()} disabled={createBusy} type="button">{createBusy ? 'Creando…' : 'Confirmar y crear'}</button></footer></div>}{createError ? <p className="calendar-create-error">{createError}</p> : null}</form></div> : null}
    </div>
  );
}
