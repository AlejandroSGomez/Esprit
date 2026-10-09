'use client';

import { useEffect, useState, type KeyboardEvent } from 'react';
import RichText from './RichText';

export type RadarSheet = {
  title: string; authors: string[]; published: string; tldr: string; takeaways: string[];
  why_relevant: string; summary: string; project: string; concrete_use: string; relevance_score: number; source_id: string;
};
export type PaperMeta = { collection: string; tags: string[]; read: boolean; note: string; updated_ms: number; radar: RadarSheet | null };
export type MetaPatch = { tags?: string[]; read?: boolean; note?: string };
type Tag = { slug: string; label: string };

const firstSentence = (text: string) => (text.match(/^.{20,240}?[.!?](?=\s|$)/)?.[0] ?? text.slice(0, 220)).trim();
/** The radar's one-line idea; cards older than 0.34.4 fall back to the abstract. */
export const radarIdea = (radar: RadarSheet) => radar.tldr || firstSentence(radar.summary);
/** Starting text when the user edits: what the radar said, as editable Markdown. */
export const radarDraft = (radar: RadarSheet | null) => !radar ? '' : [
  radarIdea(radar),
  radar.takeaways.map((point) => `- ${point}`).join('\n'),
  radar.why_relevant ? `**Para qué me sirve:** ${radar.why_relevant}` : '',
].filter(Boolean).join('\n\n');

/** First line of a note as plain text, for one-line previews. */
export const notePreview = (note: string) => (note.split('\n').find((line) => line.trim()) ?? '')
  .replace(/^[#>*\-\s]+/, '').replace(/\$([^$]*)\$/g, '$1').replace(/[*_`]+/g, '').trim();

const OPEN_KEY = 'esprit.library.sheet.open';

/** Read marker toggle: red while unread, green once read. */
export function ReadToggle({ read, busy, onToggle }: { read: boolean; busy?: boolean; onToggle: () => void }) {
  return <button type="button" className={`paper-read${read ? ' read' : ''}`} aria-pressed={read} disabled={busy} onClick={onToggle} title={read ? 'Marcar como no leído' : 'Marcar como leído'}><i aria-hidden="true" />{read ? 'Leído' : 'Sin leer'}</button>;
}

/** Summary, notes and tags of the open paper, above the PDF. */
export default function LibraryPaperSheet({ meta, tags, label, onUpdate }: { meta: PaperMeta; tags: Tag[]; label: (slug: string) => string; onUpdate: (patch: MetaPatch) => Promise<void> }) {
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Restored after mount: the static export prerenders the default.
  useEffect(() => { queueMicrotask(() => { try { if (localStorage.getItem(OPEN_KEY) === '0') setOpen(false); } catch { /* preference only */ } }); }, []);
  const toggleOpen = () => setOpen((value) => { try { localStorage.setItem(OPEN_KEY, value ? '0' : '1'); } catch { /* preference only */ } return !value; });
  const save = async (patch: MetaPatch, after?: () => void) => {
    setBusy(true); setError(null);
    try { await onUpdate(patch); after?.(); } catch (reason) { setError(String(reason).replace(/^Error:\s*/, '')); } finally { setBusy(false); }
  };
  const toggleTag = (slug: string) => {
    const next = meta.tags.includes(slug) ? meta.tags.filter((tag) => tag !== slug) : [...meta.tags, slug];
    void save({ tags: next });
  };
  const keyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(null); }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && editing !== null) { event.preventDefault(); void save({ note: editing }, () => setEditing(null)); }
  };
  const radar = meta.radar;
  const summary = meta.note ? <RichText content={meta.note} /> : radar ? <>
    <p className="paper-idea">{radarIdea(radar)}</p>
    {radar.takeaways.length ? <ul className="paper-takeaways">{radar.takeaways.map((point) => <li key={point}>{point}</li>)}</ul> : null}
    {radar.why_relevant ? <p className="paper-why"><b>Para qué me sirve · {label(radar.project)}</b>{radar.why_relevant}</p> : null}
  </> : <p className="paper-empty">Sin resumen todavía. Anota para qué te sirve este paper.</p>;

  return <section className={`paper-sheet${open ? ' open' : ''}`} aria-label="Ficha del paper">
    <div className="paper-sheet-bar">
      <button type="button" className="paper-sheet-toggle" onClick={toggleOpen} aria-expanded={open} title={open ? 'Plegar ficha' : 'Ver resumen y notas'}>{open ? '▾' : '▸'} {meta.note ? 'Mis notas' : radar ? 'Del radar' : 'Ficha'}</button>
      {!open ? <span className="paper-sheet-peek">{meta.note ? notePreview(meta.note) : radar ? radarIdea(radar) : 'Sin resumen'}</span> : null}
      <span className="paper-tags" role="group" aria-label="Etiquetas">
        {meta.tags.map((slug) => <span key={slug} className={`paper-tag tone-${slug}`}><i aria-hidden="true" />{label(slug)}</span>)}
        <button type="button" className="paper-tag-add" onClick={() => setPicking((value) => !value)} aria-expanded={picking} disabled={busy}>{picking ? 'Listo' : '＋ Etiquetas'}</button>
      </span>
    </div>
    {picking ? <div className="paper-tag-picker" role="group" aria-label="Elegir etiquetas">{tags.map((tag) => <button type="button" key={tag.slug} className={`tone-${tag.slug}`} aria-pressed={meta.tags.includes(tag.slug)} disabled={busy} onClick={() => toggleTag(tag.slug)}><i aria-hidden="true" />{tag.label}</button>)}</div> : null}
    {open ? <div className="paper-sheet-body">
      {editing !== null ? <div className="paper-note-edit" onKeyDown={keyDown}>
        <textarea value={editing} autoFocus rows={7} maxLength={8000} onChange={(event) => setEditing(event.target.value)} placeholder="Para qué sirve, qué coger del paper, dudas… Markdown y $\LaTeX$" aria-label="Resumen y notas del paper" />
        <footer><small>{radar ? 'Empieza con lo que dijo el radar; cámbialo a tu gusto.' : ''} Ctrl/⌘↵ guardar · Esc cancelar</small><button type="button" onClick={() => setEditing(null)} disabled={busy}>Cancelar</button><button type="button" className="primary" onClick={() => void save({ note: editing }, () => setEditing(null))} disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button></footer>
      </div> : <div className="paper-summary">
        {summary}
        <button type="button" className="paper-edit" onClick={() => setEditing(meta.note || radarDraft(radar))}>✎ {meta.note ? 'Editar notas' : radar ? 'Editar resumen y añadir notas' : 'Añadir notas'}</button>
      </div>}
      {meta.note && radar && editing === null ? <details className="paper-radar-original"><summary>Ficha original del radar · afinidad {radar.relevance_score}</summary><p>{radarIdea(radar)}</p>{radar.takeaways.length ? <ul>{radar.takeaways.map((point) => <li key={point}>{point}</li>)}</ul> : null}<p>{radar.why_relevant}</p>{radar.concrete_use ? <p><b>Qué probar:</b> {radar.concrete_use}</p> : null}</details> : null}
      {error ? <p className="paper-error" role="alert">{error}</p> : null}
    </div> : null}
  </section>;
}
