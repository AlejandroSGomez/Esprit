'use client';
import { getAppTimeZone } from '../appConfig';

import { useEffect, useMemo, useState } from 'react';
import RichText from './RichText';
import { baseCategories, QUICK_NOTE_SHORTCUT, type MeetingLink, type QuickNote, type QuickNotes } from '../quickNotes';

type Category = { slug: string; label: string };

const noteDate = (ms: number) => new Date(ms).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: getAppTimeZone() });
const noteTime = (ms: number) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: getAppTimeZone() });

/** Sticky notes grouped by category; pending ones feed the next Logout. */
export default function NotesSpace({ quick, projects, onNew, onEdit, onOpenMeeting, onClose }: {
  quick: QuickNotes;
  projects: Category[];
  onNew: (category?: string) => void;
  onEdit: (note: QuickNote) => void;
  onOpenMeeting: (link: MeetingLink) => void;
  onClose: () => void;
}) {
  const [category, setCategory] = useState('all');
  const [scope, setScope] = useState<'pending' | 'all'>('all');
  const [query, setQuery] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reread on open: another Esprit window or a Logout may have changed the register.
  const { refresh } = quick;
  useEffect(() => { void refresh(); }, [refresh]);
  const categories = [...baseCategories, ...projects];
  const label = (slug: string) => categories.find((item) => item.slug === slug)?.label ?? slug;
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    quick.notes.forEach((note) => map.set(note.category, (map.get(note.category) ?? 0) + 1));
    return map;
  }, [quick.notes]);
  const pendingCount = quick.notes.filter((note) => !note.logged).length;
  const shown = quick.notes.filter((note) => (category === 'all' || note.category === category)
    && (scope === 'all' || !note.logged)
    && `${note.title} ${note.body}`.toLocaleLowerCase('es').includes(query.trim().toLocaleLowerCase('es')));
  const remove = async (note: QuickNote) => {
    setBusy(true); setError(null);
    try { await quick.remove(note.id); setConfirming(null); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };

  return <section className="notes-space">
    <header className="notes-toolbar">
      <h3>Notas</h3>
      <div className="notes-scope" role="group" aria-label="Qué notas mostrar">
        <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>Todas</button>
        <button type="button" aria-pressed={scope === 'pending'} onClick={() => setScope('pending')} title="Aún no las ha leído el Logout">Pendientes de Logout{pendingCount ? <b>{pendingCount}</b> : null}</button>
      </div>
      <label className="notes-search"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar" aria-label="Buscar notas" /></label>
      <button type="button" className="notes-new" onClick={() => onNew(category === 'all' ? undefined : category)} title={`Nueva nota · ${QUICK_NOTE_SHORTCUT}`}>＋ Nota <kbd>{QUICK_NOTE_SHORTCUT}</kbd></button>
      <button type="button" className="notes-close" onClick={onClose} aria-label="Cerrar Notas">×</button>
    </header>
    <nav className="notes-categories" aria-label="Categorías">
      <button type="button" aria-pressed={category === 'all'} onClick={() => setCategory('all')}>Todas <small>{quick.notes.length}</small></button>
      {categories.filter((item) => counts.get(item.slug) || item.slug === 'general' || item.slug === 'burocracia').map((item) => <button type="button" key={item.slug} className={`tone-${item.slug}`} aria-pressed={category === item.slug} onClick={() => setCategory(category === item.slug ? 'all' : item.slug)}><i aria-hidden="true" />{item.label} <small>{counts.get(item.slug) ?? 0}</small></button>)}
    </nav>
    {quick.error || error ? <p className="notes-error" role="alert">{error ?? quick.error}</p> : null}
    <div className="notes-board">
      {!shown.length ? <div className="notes-empty"><span>✎</span><h4>{quick.notes.length ? 'Nada con este filtro' : 'Apunta lo que no quieres olvidar'}</h4><p>Reuniones, cosas que han pasado, recordatorios. El Logout las leerá y las anotará en tu cierre del día.</p><button type="button" onClick={() => onNew(category === 'all' ? undefined : category)}>＋ Nueva nota · {QUICK_NOTE_SHORTCUT}</button></div> : null}
      {shown.map((note) => <article className={`sticky-note tone-${note.category}`} key={note.id}>
        <header><span className="sticky-category"><i aria-hidden="true" />{label(note.category)}</span><time title={new Date(note.updated_ms).toLocaleString('es-ES', { timeZone: getAppTimeZone() })}>{noteDate(note.updated_ms)} · {noteTime(note.updated_ms)}</time></header>
        <button type="button" className="sticky-content" onClick={() => onEdit(note)} aria-label={`Editar ${note.title || 'nota'}`}>
          {note.title ? <h4>{note.title}</h4> : null}
          {note.body ? <div className="sticky-body"><RichText content={note.body} /></div> : null}
        </button>
        {note.meeting ? <button type="button" className="sticky-meeting" onClick={() => onOpenMeeting(note.meeting!)} disabled={!note.meeting_exists} title={note.meeting_exists ? 'Abrir la reunión' : 'La reunión ya no existe'}>◎ {note.meeting.title || 'Reunión'}{note.meeting_exists ? ' ↗' : ' · borrada'}</button> : null}
        <footer>
          <span className={`sticky-status${note.logged ? ' logged' : ''}`}>{note.logged ? `✓ Anotada en Logout${note.logged_ms ? ` · ${noteDate(note.logged_ms)}` : ''}` : '● Pendiente de Logout'}</span>
          {confirming === note.id ? <span className="sticky-confirm" role="group" aria-label="Confirmar borrado"><button type="button" onClick={() => setConfirming(null)} disabled={busy}>No</button><button type="button" className="danger" onClick={() => void remove(note)} disabled={busy}>{busy ? '…' : 'Borrar'}</button></span>
            : <><button type="button" onClick={() => onEdit(note)} aria-label="Editar">✎</button><button type="button" onClick={() => setConfirming(note.id)} title="Borrar nota" aria-label="Borrar">🗑</button></>}
        </footer>
        {confirming === note.id && note.delete_reason ? <p className="sticky-warning" role="status">{note.delete_reason}</p> : null}
      </article>)}
    </div>
  </section>;
}
