'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import RichText from './RichText';
import type { ResearchNote } from '../research';
import { baseCategories, QUICK_NOTE_SHORTCUT, type QuickNoteDraft, type QuickNotes } from '../quickNotes';

type Category = { slug: string; label: string };

/**
 * Floating sticky-note composer (⇧Ctrl/⌘N). Project notes can link an existing
 * meeting or create one at the same time; the meeting editor then opens
 * prefilled and the note links itself once that meeting is saved.
 */
export default function QuickNoteComposer({ quick, initial, projects, meetings, onClose, onCreateMeeting }: {
  quick: QuickNotes;
  initial: QuickNoteDraft;
  projects: Category[];
  meetings: ResearchNote[];
  onClose: () => void;
  onCreateMeeting: (noteId: string, project: string, title: string, body: string) => void;
}) {
  const [draft, setDraft] = useState<QuickNoteDraft>(initial);
  const [meetingChoice, setMeetingChoice] = useState<string>(initial.meeting ? initial.meeting.id : '');
  const [preview, setPreview] = useState(() => { try { return localStorage.getItem('esprit-quick-note-preview') !== '0'; } catch { return true; } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { body.current?.focus(); }, []);
  const categories = [...baseCategories, ...projects];
  const isProject = projects.some((project) => project.slug === draft.category);
  const projectMeetings = meetings.filter((meeting) => meeting.project === draft.category).sort((left, right) => right.date.localeCompare(left.date));
  const togglePreview = () => setPreview((value) => { try { localStorage.setItem('esprit-quick-note-preview', value ? '0' : '1'); } catch { /* preference only */ } return !value; });

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    if (!draft.title.trim() && !draft.body.trim()) { setError('Escribe algo en la nota.'); return; }
    setBusy(true); setError(null);
    try {
      const chosen = isProject && meetingChoice && meetingChoice !== '__new__' ? projectMeetings.find((meeting) => meeting.id === meetingChoice) : null;
      const meeting = chosen ? { project: chosen.project, id: chosen.id, title: chosen.title } : isProject && draft.meeting && meetingChoice === draft.meeting.id ? draft.meeting : null;
      const before = new Set(quick.notes.map((note) => note.id));
      const next = await quick.save({ ...draft, meeting });
      const savedId = draft.id ?? next.notes.find((note) => !before.has(note.id))?.id;
      if (isProject && meetingChoice === '__new__' && savedId) onCreateMeeting(savedId, draft.category, draft.title.trim(), draft.body.trim());
      onClose();
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); onClose(); }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void submit(); }
  };

  return <div className="quick-note-layer" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className={`quick-note-composer tone-${draft.category}`} role="dialog" aria-modal="true" aria-label={draft.id ? 'Editar nota' : 'Nueva nota rápida'} onSubmit={submit} onKeyDown={keyDown}>
      <header><strong>{draft.id ? 'Editar nota' : 'Nota rápida'}</strong><kbd>{QUICK_NOTE_SHORTCUT}</kbd><button type="button" onClick={onClose} aria-label="Cerrar">×</button></header>
      <div className="quick-note-categories" role="radiogroup" aria-label="Categoría">
        {categories.map((category) => <button type="button" role="radio" aria-checked={draft.category === category.slug} className={`tone-${category.slug}`} key={category.slug} onClick={() => { setDraft((current) => ({ ...current, category: category.slug, meeting: current.meeting?.project === category.slug ? current.meeting : null })); if (draft.meeting?.project !== category.slug) setMeetingChoice(''); }}><i aria-hidden="true" />{category.label}</button>)}
      </div>
      <input className="quick-note-title" value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder="Título (opcional)" maxLength={160} aria-label="Título" />
      <textarea ref={body} value={draft.body} onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))} placeholder="Qué ha pasado, qué no olvidar… Markdown y $\LaTeX$" rows={5} maxLength={12000} aria-label="Nota" />
      {preview && draft.body.trim() ? <div className="quick-note-preview" aria-label="Vista previa"><RichText content={draft.body} /></div> : null}
      {isProject ? <label className="quick-note-meeting"><span>Reunión</span><select value={meetingChoice} onChange={(event) => setMeetingChoice(event.target.value)}>
        <option value="">Sin reunión</option>
        {draft.meeting && !projectMeetings.some((meeting) => meeting.id === draft.meeting?.id) ? <option value={draft.meeting.id}>{draft.meeting.title || 'Reunión vinculada'}</option> : null}
        {projectMeetings.map((meeting) => <option key={meeting.id} value={meeting.id}>{meeting.title} · {meeting.date}</option>)}

      </select></label> : null}
      {error ? <p className="quick-note-error" role="alert">{error}</p> : null}
      <footer>
        <button type="button" className="quick-note-preview-toggle" aria-pressed={preview} onClick={togglePreview} title="Vista previa de Markdown y LaTeX">Aa</button>
        <small>{meetingChoice === '__new__' ? 'Se abrirá la reunión para revisarla y guardarla.' : meetingChoice ? 'Vinculada a la reunión · irá al próximo Logout.' : 'Irá al próximo Logout.'} · Ctrl/⌘↵ guardar</small>
        <button type="button" onClick={onClose} disabled={busy}>Cancelar</button>
        <button type="submit" className="primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button>
      </footer>
    </form>
  </div>;
}
