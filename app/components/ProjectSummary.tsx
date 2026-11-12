'use client';

import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getAppTimeZone } from '../appConfig';
import RichText from './RichText';
import PdfViewer from './PdfViewer';
import type { ProjectOption } from './ProjectSpace';
import type { PaperMeta } from './LibraryPaperSheet';
import './ProjectSummary.css';

type Summary = { content: string | null; modified: number | null };
type Paper = PaperMeta & { id: string; name: string; folder: string };
type Preview = { name: string; data_base64: string };
const explain = (reason: unknown) => typeof reason === 'string' ? reason : 'No se pudo cargar esta vista. Vuelve a actualizar.';

function Bibliography({ project, active }: { project: string; active: boolean }) {
  const [papers, setPapers] = useState<Paper[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [query, setQuery] = useState(''), [preview, setPreview] = useState<Preview | null>(null);
  const activity = useMemo(() => ({ project, active }), [project, active]);
  const [openingRequest, setOpeningRequest] = useState<{ id: number; activity: object } | null>(null);
  const opening = active && openingRequest?.activity === activity;
  const [revision, setRevision] = useState(0);
  const requests = useRef({ generation: 0 });
  useEffect(() => { const scope = requests.current; return () => { scope.generation++; }; }, [activity]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void invoke<{ papers: Paper[]; meta_warning?: string | null }>('library_overview').then(result => {
      if (cancelled) return;
      setPapers(result.papers.filter(paper => paper.tags.includes(project) || paper.collection === project));
      setError(result.meta_warning ?? ''); setLoading(false);
    }).catch(reason => { if (!cancelled) { setError(explain(reason)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [project, active, revision]);
  const shown = useMemo(() => papers.filter(paper => `${paper.radar?.title ?? ''} ${paper.name}`.toLocaleLowerCase('es').includes(query.toLocaleLowerCase('es')))
    .sort((a, b) => Number(a.read) - Number(b.read) || a.name.localeCompare(b.name, 'es', { numeric: true })), [papers, query]);
  const open = async (paper: Paper) => {
    if (!active) return;
    const scope = requests.current;
    const request = ++scope.generation; setOpeningRequest({ id: request, activity }); setError('');
    try { const result = await invoke<Preview>('library_read', { paperId: paper.id }); if (request === scope.generation) setPreview(result); }
    catch (reason) { if (request === scope.generation) setError(explain(reason)); }
    finally { setOpeningRequest(current => current?.id === request ? null : current); }
  };
  return <section className={`project-bibliography${preview ? ' reading' : ''}`} aria-label="Bibliografía del proyecto">
    <div className="project-summary-tools"><input aria-label="Buscar en la bibliografía" placeholder="Buscar un paper…" value={query} onChange={event => setQuery(event.target.value)} /><button type="button" disabled={!active} onClick={() => { setLoading(true); setRevision(value => value + 1); }}>Actualizar</button></div>
    {error && <p role="alert">{error}</p>}
    {opening && <p role="status">Abriendo PDF…</p>}
    {preview ? <><div className="project-summary-tools"><strong>{preview.name}</strong><button type="button" onClick={() => { requests.current.generation++; setPreview(null); }}>Volver a los papers</button></div><PdfViewer name={preview.name} dataBase64={preview.data_base64} active={active} storageKey={`esprit.project.bib.${project}.${preview.name}`} /></> : loading ? <p role="status">Cargando bibliografía…</p> : shown.length ? <ul>{shown.map(paper => <li key={paper.id}><button type="button" disabled={!active} onClick={() => void open(paper)}><span>{paper.read ? 'Leído' : 'Por leer'}</span><strong>{paper.radar?.title || paper.name.replace(/\.pdf$/i, '')}</strong>{paper.radar?.tldr && <small>{paper.radar.tldr}</small>}</button></li>)}</ul> : <p>{papers.length ? 'No hay papers que coincidan.' : 'Los PDFs que asignes a este proyecto en Biblioteca aparecerán aquí.'}</p>}
  </section>;
}

type Props = { project: ProjectOption; active: boolean; onOpenState: () => void; libraryEnabled?: boolean };

// A different project gets its own state immediately, including pending reads.
export default function ProjectSummary(props: Props) {
  return <ProjectSummaryView key={props.project.slug} {...props} />;
}

function ProjectSummaryView({ project, active, onOpenState, libraryEnabled = false }: Props) {
  const [view, setView] = useState<'state' | 'papers'>('state');
  const [summary, setSummary] = useState<Summary | null>(null), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void invoke<Summary>('project_summary', { project: project.slug }).then(value => { if (!cancelled) { setSummary(value); setError(''); } }).catch(reason => { if (!cancelled) setError(explain(reason)); });
    return () => { cancelled = true; };
  }, [project.slug, active, revision]);
  return <section className="project-summary" aria-label={`Resumen de ${project.name}`}>
    <nav aria-label="Vistas del resumen"><button type="button" aria-pressed={view === 'state' || !libraryEnabled} onClick={() => setView('state')}>Estado</button>{libraryEnabled && <button type="button" aria-pressed={view === 'papers'} onClick={() => setView('papers')}>Bibliografía</button>}</nav>
    {view === 'papers' && libraryEnabled ? <Bibliography key={project.slug} project={project.slug} active={active} /> : <div className="project-summary-state">
      <header><div><small>{project.eyebrow}</small><h2>{project.name}</h2></div><button type="button" disabled={!active} onClick={() => setRevision(value => value + 1)}>Actualizar</button></header>
      {(project.summary || project.next) && <div className="project-summary-cards">{project.summary && <article><small>En foco</small><RichText content={project.summary} /></article>}{project.next && <article><small>Siguiente paso</small><RichText content={project.next} /></article>}</div>}
      {error ? <p role="alert">{error}</p> : summary ? summary.content !== null ? <article className="project-summary-document"><div className="project-summary-tools"><strong>STATE.md</strong>{summary.modified && <time>{new Intl.DateTimeFormat('es-ES', { timeZone: getAppTimeZone(), dateStyle: 'medium', timeStyle: 'short' }).format(new Date(summary.modified * 1000))}</time>}<button type="button" onClick={onOpenState}>Abrir archivo</button></div><RichText content={summary.content} /></article> : <p>Este proyecto todavía no tiene STATE.md. Puedes crearlo desde el explorador cuando quieras registrar sus objetivos y próximos pasos.</p> : <p role="status">Leyendo el estado del proyecto…</p>}
    </div>}
  </section>;
}
