'use client';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';
import RichText from './RichText';
import { blankNote, noteFields, noteLabels, type Research, type ResearchNote, type ResearchProject, type ResearchReview, type WaitingItem } from '../research';
import './ResearchSpace.css';

type OpenNote = (note: ResearchNote, draftId?: string) => void;
export function ResearchSpace({ research, projects, onOpen, onProject }: { research: Research; projects: ResearchProject[]; onOpen: OpenNote; onProject: (slug: string) => void }) {
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  // One reviewed removal at a time: the native plan holds the exact bytes.
  const [removal, setRemoval] = useState<{ note: ResearchNote; review: ResearchReview | null; busy: boolean; error: string } | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const cancelRemoval = () => {
    if (removal?.review) void invoke('research_cancel', { planId: removal.review.plan_id });
    setRemoval(null);
  };
  const beginRemoval = async (note: ResearchNote) => {
    if (removal?.review) void invoke('research_cancel', { planId: removal.review.plan_id });
    setRemoval({ note, review: null, busy: true, error: '' });
    try { const review = await invoke<ResearchReview>('research_prepare_archive', { note }); setRemoval({ note, review, busy: false, error: '' }); }
    catch (reason) { setRemoval({ note, review: null, busy: false, error: String(reason).replace(/^Error:\s*/, '') }); }
  };
  const confirmRemoval = async () => {
    if (!removal?.review) return;
    setRemoval({ ...removal, busy: true, error: '' });
    try {
      const next = await invoke<{ notes: ResearchNote[]; warnings: string[] }>('research_apply', { planId: removal.review.plan_id, confirmed: true });
      research.setOverview(next);
      // Drafts opened from this meeting would otherwise resurrect it on save.
      Object.entries(research.drafts).forEach(([key, draft]) => { if (draft.id === removal.note.id) research.putDraft(key, null); });
      await research.flush();
      setRemoval(null);
    } catch (reason) { setRemoval({ ...removal, busy: false, error: String(reason).replace(/^Error:\s*/, '') }); }
  };
  const notes = research.notes.filter(note => note.kind === 'meeting' && (!filter || note.project === filter) && `${note.title} ${Object.values(note.fields).join(' ')}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const drafts = Object.entries(research.drafts).filter(([,note]) => note.kind === 'meeting' && (!filter || note.project === filter));
  return <section className="research-space">
    <header className="research-toolbar"><div><span>PREPARAR · DISCUTIR · ACORDAR</span><h3>Reuniones</h3><p>Preguntas claras antes. Decisiones trazables después.</p></div><button type="button" disabled={!research.ready} onClick={() => onOpen(blankNote('meeting', { project: filter, fields: filter ? { agenda: projects.find(p => p.slug === filter)?.next ?? '' } : {} }))}>＋ Preparar reunión</button></header>
    <div className="research-filters"><input aria-label="Buscar reuniones" placeholder="Buscar por tema, pregunta o acuerdo…" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="Filtrar reuniones por proyecto" value={filter} onChange={e => setFilter(e.target.value)}><option value="">Todos los proyectos</option>{projects.map(p => <option key={p.slug} value={p.slug}>{p.name}</option>)}</select><button type="button" onClick={() => void research.refresh()}>↻ Actualizar</button></div>
    {research.error ? <p className="research-warning" role="alert">{research.error}</p> : null}
    {research.warnings.length ? <details className="research-warning"><summary>Hay fuentes sin cargar ({research.warnings.length})</summary>{research.warnings.map((warning,i) => <p key={i}>{warning}</p>)}</details> : null}
    <div className="research-scroll">{drafts.length ? <section className="research-drafts"><h4>Borradores conservados</h4>{drafts.map(([id,note]) => <div className="research-draft-row" key={id}><button type="button" onClick={() => onOpen(note,id)}><span>◌</span><strong>{note.title || 'Reunión por preparar'}</strong><small>{note.date} · Retomar</small></button>{discarding === id ? <span className="research-inline-confirm" role="group" aria-label="Descartar borrador" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDiscarding(null); } }}><button type="button" onClick={() => setDiscarding(null)}>Conservar</button><button type="button" className="danger" autoFocus onClick={() => { research.putDraft(id, null); void research.flush(); setDiscarding(null); }}>Descartar</button></span> : <button type="button" className="research-quiet-action" aria-label={`Descartar borrador ${note.title || 'sin título'}`} onClick={() => setDiscarding(id)}>Descartar…</button>}</div>)}</section> : null}
      {!notes.length ? <div className="research-empty"><span>◎</span><h3>{query || filter ? 'Sin reuniones con este filtro' : 'Prepara tu próxima conversación'}</h3><p>Reúne las preguntas abiertas, las figuras que quieres enseñar y los acuerdos que necesitas cerrar.</p>{!query && !filter ? <button type="button" disabled={!research.ready} onClick={() => onOpen(blankNote('meeting'))}>Crear una agenda</button> : null}</div> : notes.map(note => <article className="research-card" key={note.id}><div><small>{note.date || 'Sin fecha'} · {projects.find(p => p.slug === note.project)?.name ?? note.project}</small><h3>{note.title}</h3><p>{note.fields.participants || 'Participantes sin registrar'}</p></div><div className="research-card-body"><section><h4>Para discutir</h4><p>{note.fields.agenda || 'Agenda abierta'}</p></section><section><h4>Acuerdos y continuidad</h4><p>{note.fields.decisions || 'Todavía no se han registrado acuerdos.'}</p>{note.fields.actions ? <p>{note.fields.actions}</p> : null}</section></div><footer><button type="button" onClick={() => onOpen(note)}>Abrir reunión</button><button type="button" onClick={() => onProject(note.project)}>Ir al proyecto ↗</button><button type="button" className="research-quiet-action danger" disabled={!research.ready || Boolean(removal?.busy)} onClick={() => void beginRemoval(note)}>Borrar…</button></footer>
        {removal?.note.id === note.id ? <div className="research-removal" role="alertdialog" aria-label={`Borrar ${note.title}`} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelRemoval(); } }}>
          {removal.busy && !removal.review ? <p>Preparando la revisión…</p> : null}
          {removal.review ? <><p>La reunión se retira de esta lista y su archivo se mueve a <strong>{removal.review.destination}</strong>. No se destruye: puedes recuperarla desde tu explorador de archivos.</p>{removal.review.state_link ? <p className="research-removal-warning">El STATE.md del proyecto enlaza esta reunión; ese enlace apuntará a la ubicación anterior.</p> : null}</> : null}
          {removal.error ? <p className="research-removal-warning" role="alert">{removal.error}</p> : null}
          <div><button type="button" disabled={removal.busy && Boolean(removal.review)} onClick={cancelRemoval}>Cancelar</button>{removal.review ? <button type="button" className="danger" autoFocus disabled={removal.busy} onClick={() => void confirmRemoval()}>{removal.busy ? 'Borrando…' : 'Confirmar borrado'}</button> : null}</div>
        </div> : null}
      </article>)}
    </div>
  </section>;
}

export function WaitingPanel({ items, updated, research, projects, onOpen, onRefresh, compact = false }: { items: WaitingItem[]; updated: string; research: Research; projects: ResearchProject[]; onOpen: OpenNote; onRefresh?: () => void; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const annotations = research.notes.filter(note => note.kind === 'waiting');
  const shown = compact && !expanded ? items.slice(0, 3) : items;
  return <div className={`waiting-panel ${compact ? 'compact' : ''}`}>
    <div className="waiting-heading"><div>{!compact ? <strong>En espera <span>{items.length}</span></strong> : null}<small>Estado registrado · {updated || 'sin fecha disponible'}</small></div>{onRefresh ? <button type="button" aria-label="Actualizar dependencias del estado local" onClick={onRefresh}>↻</button> : null}<button type="button" disabled={!research.ready} onClick={() => onOpen(blankNote('waiting'))}>＋ Anotar</button></div>
    {!items.length ? <p className="research-muted">No hay dependencias disponibles en el estado global.</p> : shown.map(item => {
      const source = `${item.source}:${item.line}\n${item.owner} — ${item.detail}`;
      // Match the exact documented dependency, independent of line shifts.
      const annotation = annotations.find(note => note.fields.source?.split('\n').slice(1).join('\n') === `${item.owner} — ${item.detail}`);
      return <article key={`${item.line}-${item.owner}`}><div className="waiting-owner"><strong>{annotation?.fields.owner || item.owner}</strong><small>{annotation?.fields.since || 'Inicio sin registrar'}</small></div><p>{item.detail}</p>{annotation?.fields.unblocks ? <p><b>Desbloquea:</b> {annotation.fields.unblocks}</p> : null}{annotation?.fields.meanwhile ? <p className="waiting-next"><b>Mientras tanto:</b> {annotation.fields.meanwhile}</p> : null}<details><summary>Fuente y contexto</summary><p>{item.source} · Waiting on · línea {item.line}</p><blockquote>{item.owner} — {item.detail}</blockquote>{!annotation?.fields.unblocks ? <p>Qué desbloquea: sin registrar.</p> : null}{!annotation?.fields.meanwhile ? <p>Trabajo independiente: sin registrar.</p> : null}{annotation ? <p>Nota en {projects.find(p => p.slug === annotation.project)?.name ?? annotation.project}</p> : null}<button type="button" disabled={!research.ready} onClick={() => onOpen(annotation ?? blankNote('waiting', { title: item.detail.slice(0,140), fields: { source, owner: item.owner } }))}>{annotation ? 'Editar contexto' : 'Añadir contexto'}</button></details></article>;
    })}
    {compact && items.length > 3 ? <button type="button" className="waiting-expand" onClick={() => setExpanded(value => !value)}>{expanded ? 'Mostrar menos' : `Ver las ${items.length} dependencias`}</button> : null}
    {annotations.filter(note => !items.some(item => note.fields.source?.split('\n').slice(1).join('\n') === `${item.owner} — ${item.detail}`)).map(note => <article key={note.id}><small>Anotación de proyecto · comprobar vigencia</small><button type="button" onClick={() => onOpen(note)}>{note.title}</button>{note.fields.meanwhile ? <p>{note.fields.meanwhile}</p> : null}</article>)}
  </div>;
}

export function NoteEditor({ draftId, research, projects, onClose }: { draftId: string; research: Research; projects: ResearchProject[]; onClose: () => void }) {
  const note = research.drafts[draftId];
  const original = useRef(research.bases[draftId] ?? null);
  const [review, setReview] = useState<ResearchReview | null>(null);
  const [reviewState, setReviewState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const reviewRef = useRef<ResearchReview | null>(null);
  useEffect(() => { reviewRef.current = review; }, [review]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLInputElement>('input')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, summary, [tabindex="0"]') ?? [])].filter(el => el.offsetParent !== null);
      if (!elements.length) return;
      const first = elements[0], last = elements.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); previous?.focus(); if (reviewRef.current) void invoke('research_cancel', { planId: reviewRef.current.plan_id }); };
  }, []);
  if (!note) return null;
  const update = (name: string, value: string) => research.putDraft(draftId, name.startsWith('fields.') ? { ...note, fields: { ...note.fields, [name.slice(7)]: value } } : { ...note, [name]: value });
  const attrs = (name: string) => ({ 'data-research-draft': draftId, 'data-research-field': name });
  const prepare = async (stateUpdate: boolean) => {
    setBusy(true); setError('');
    try { research.captureFocused(); const submitted = research.getDraft(draftId) ?? note; await research.flush(); setReview(await invoke<ResearchReview>('research_prepare', { note: submitted, expected: original.current, stateUpdate })); setReviewState(stateUpdate); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!review) return; research.setWriteBusy(true); setBusy(true); setError('');
    try {
      const next = await invoke<{ notes: ResearchNote[]; warnings: string[] }>('research_apply', { planId: review.plan_id, confirmed: true });
      research.setOverview(next); setReview(null); reviewRef.current = null;
      if (reviewState) { setError('Actualización incorporada al STATE.md del proyecto.'); }
      else {
        const pathId = review.destination.split('/').at(-1)?.replace(/\.md$/, '');
        const saved = next.notes.find(item => item.id === pathId);
        if (!saved) throw new Error('La nota se guardó, pero el catálogo no pudo releerla. Conserva el borrador y revisa las fuentes.');
        original.current = saved; research.putDraft(draftId, saved, saved); await research.flush();
        setError('Nota guardada en el proyecto.');
      }
    } catch (reason) { setError(String(reason)); }
    finally { research.setWriteBusy(false); setBusy(false); }
  };
  const close = async () => { setBusy(true); try { research.captureFocused(); await research.flush(); if (original.current && JSON.stringify(original.current) === JSON.stringify(research.getDraft(draftId))) { research.putDraft(draftId, null); await research.flush(); } onClose(); } catch (reason) { setError(String(reason)); setBusy(false); } };
  return <div className="research-modal"><section ref={panel} className="note-editor" onKeyDownCapture={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); if (!review && !busy && note.project && note.title.trim()) void prepare(false); return; } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (discard) setDiscard(false); else if (!busy) void close(); } }} role="dialog" aria-modal="true" aria-labelledby="note-editor-title">
    <header><div><span>{noteLabels[note.kind].toUpperCase()} · {review ? 'REVISIÓN' : 'CUADERNO DE PROYECTO'}</span><h2 id="note-editor-title">{review ? (reviewState ? 'Propuesta para STATE.md' : 'Revisar guardado') : note.title || `Nueva ${noteLabels[note.kind].toLocaleLowerCase()}`}</h2></div><button disabled={busy} type="button" onClick={() => void close()}>{review ? 'Cerrar revisión' : 'Cerrar y conservar'}</button></header>
    {research.error || error ? <p className="research-warning" role="status">{error || research.error}</p> : null}
    {review ? <div className="note-review"><p>Destino: <strong>{review.destination}</strong></p><p>{reviewState ? 'Los acuerdos y las acciones se incorporarán a sus secciones del estado. Revisa el contenido completo antes de confirmar.' : 'Esta escritura guarda la nota en los archivos del proyecto.'}</p>{review.before ? <details><summary>Contenido actual</summary><pre>{review.before}</pre></details> : <p>Archivo nuevo.</p>}<h3>Contenido propuesto</h3><RichText content={review.after} /></div> : <fieldset className="note-form" disabled={busy}>
      <div className="note-meta"><label>Título<input {...attrs('title')} value={note.title} maxLength={150} onChange={e => update('title', e.target.value)} /></label><label>Proyecto<select {...attrs('project')} value={note.project} disabled={Boolean(note.id)} onChange={e => update('project', e.target.value)}><option value="">Selecciona un proyecto</option>{projects.map(p => <option key={p.slug} value={p.slug}>{p.name}</option>)}</select></label><label>Fecha<input {...attrs('date')} type="date" value={note.date} onChange={e => update('date', e.target.value)} /></label></div>
      {note.kind === 'meeting' && note.project ? <details className="note-context"><summary>Contexto registrado del proyecto</summary><p>{projects.find(p => p.slug === note.project)?.summary}</p><p><b>Próximo paso:</b> {projects.find(p => p.slug === note.project)?.next}</p><button type="button" onClick={() => update('fields.agenda', [note.fields.agenda, projects.find(p => p.slug === note.project)?.next].filter(Boolean).join('\n\n'))}>Añadir próximo paso a la agenda</button></details> : null}
      {noteFields[note.kind].map(([name,label,placeholder]) => <label key={name}>{label}<textarea {...attrs(`fields.${name}`)} value={note.fields[name] ?? ''} placeholder={placeholder} rows={name === 'source' || name === 'participants' || name === 'since' || name === 'owner' ? 2 : 4} maxLength={6000} onChange={e => update(`fields.${name}`,e.target.value)} /></label>)}
    </fieldset>}
    <footer><span>{busy ? 'Guardando…' : research.saving ? 'Conservando borrador…' : 'Borrador local · el proyecto cambia al confirmar'}</span><div>{review ? <><button disabled={busy} type="button" onClick={() => { void invoke('research_cancel', { planId: review.plan_id }); setReview(null); }}>Volver a editar</button><button disabled={busy} type="button" onClick={() => void apply()}>Confirmar {reviewState ? 'actualización de estado' : 'guardado'}</button></> : <><button disabled={busy} type="button" onClick={() => setDiscard(true)}>Descartar borrador…</button>{note.kind === 'meeting' && note.id ? <button disabled={busy} type="button" onClick={() => void prepare(true)}>Proponer actualización de estado</button> : null}<button disabled={busy || !note.project || !note.title.trim()} type="button" title="Ctrl/⌘S" onClick={() => void prepare(false)}>Revisar y guardar</button></>}</div></footer>
    {discard ? <div className="note-discard" role="alertdialog" aria-label="Descartar borrador"><p>Se descartarán las ediciones de este borrador. Una nota ya guardada en el proyecto seguirá disponible.</p><button type="button" onClick={() => setDiscard(false)}>Conservar</button><button type="button" onClick={() => { research.putDraft(draftId, null); void research.flush().then(onClose).catch(reason => setError(String(reason))); }}>Confirmar descarte</button></div> : null}
  </section></div>;
}
