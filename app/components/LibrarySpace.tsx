'use client';

import { invoke } from '@tauri-apps/api/core';
import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PdfViewer from './PdfViewer';
import SplitDivider from './SplitDivider';
import { useResizableSplit } from './useResizableSplit';
import './LibrarySpace.css';
import type { PaperTarget } from './GlobalSearch';
import { blankNote, type Research, type ResearchNote } from '../research';
import { coalescedRead } from '../coalescedRead';

type LibraryPaper = {
  id: string;
  name: string;
  folder: string;
  size: number;
};

type LibraryOverview = {
  checked_at: number;
  papers: LibraryPaper[];
};

type LibraryPreview = {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  data_base64: string;
};

type LibraryCollection = { slug: string; label: string };

type RadarFigure = { id: string; caption: string; mime_type: string };

type RadarCard = {
  id: string;
  source_id: string;
  title: string;
  authors: string[];
  published: string;
  updated: string;
  primary_category: string;
  categories: string[];
  summary: string;
  why_relevant: string;
  suggested_projects: string[];
  evidence_scope: string;
  relevance_score: number;
  recommendation_kind: 'scientific' | 'methodological' | 'exploratory';
  figures: RadarFigure[];
  figure_warning: string;
  evidence: { quote: string; mechanism: string; concrete_use: string; limitations: string } | null;
  shown_at: string;
  is_new: boolean;
};

type PaperRadarOverview = {
  revision: number;
  checked_at: string | null;
  status: 'not_checked' | 'recommendations' | 'nothing_relevant' | 'unavailable';
  message: string;
  source_stale: boolean;
  coverage: { source_total: number | null; recovered: number; evaluated: number; evaluated_this_run: number; remaining: number; truncated: boolean; window_start: string; window_end: string } | null;
  pending: RadarCard[];
  pending_count: number;
  added_count: number;
  dismissed_count: number;
  collections: LibraryCollection[];
  acknowledgement: string;
};

type PaperRadarFigureReply = {
  id: string;
  caption: string;
  mime_type: string;
  data_base64: string;
};

type PaperRadarMutationReply = { message: string; overview: PaperRadarOverview };
type LibraryMoveReply = { message: string; overview: LibraryOverview };

/** Colección raíz de la biblioteca; siempre existe aunque no haya proyectos con colección. */
const GENERAL_COLLECTION: LibraryCollection = { slug: 'general', label: 'Biblioteca general' };

/** Referencia estable de un PDF para las notas de lectura: carpeta y nombre tal como los lista la biblioteca. */
const paperSource = (paper: Pick<LibraryPaper, 'folder' | 'name'>) => `${paper.folder}/${paper.name}`;

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
};

const formatPaperDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
};

const formatRadarCheck = (value: string | null) => {
  if (!value) return 'Todavía no revisado';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
};

const WORKSPACE_KEY = 'esprit.library.workspace.v1';
const paperKey = (paper: Pick<LibraryPaper, 'name' | 'folder'>) => {
  // Catalogue handles are recreated on every native refresh. This local-only
  // identity never becomes a path or URL passed to the action broker.
  const text = `${paper.folder}\n${paper.name}`;
  let hash = 2166136261;
  let second = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
    second = Math.imul(second, 33) ^ text.charCodeAt(index);
  }
  return `${(hash >>> 0).toString(16)}${(second >>> 0).toString(16)}`;
};

export default function LibrarySpace({ onOpenFolder, onNotice, active = true, research, onOpenNote, externalPaper, ritualModel, ritualEffort, radarEnabled = true, projectCollections = [] }: { radarEnabled?: boolean; projectCollections?: LibraryCollection[]; onOpenFolder: () => void; onNotice?: (message: string) => void; active?: boolean; research: Research; externalPaper?: PaperTarget | null; onOpenNote: (note: ResearchNote, draftId?: string) => void; /** Mismo perfil que Login y Logout: el radar forma parte del ritual. */ ritualModel: string; ritualEffort: string }) {
  const [storedMode, setMode] = useState<'library' | 'radar'>('library');
  // Sin Radar de lectura en la configuración, la biblioteca es el único modo.
  const mode = radarEnabled ? storedMode : 'library';
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [windowVisible, setWindowVisible] = useState(true);
  const visible = active && windowVisible;
  const visibleRef = useRef(visible);
  const modeRef = useRef(mode);
  const selectedKeyRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const externalHandled = useRef(0);
  const pendingExternalPaper = useRef<PaperTarget | null>(null);
  const previewRef = useRef<LibraryPreview | null>(null);
  const overviewLoadedRef = useRef(false);
  const libraryRequestRef = useRef(0);
  const readLibraryOverview = useMemo(() => coalescedRead(() => invoke<LibraryOverview>('library_overview')), []);
  const radarRequestRef = useRef(0);
  const scrollPositions = useRef<Record<string, number>>({});
  const [radarFilter, setRadarFilter] = useState<'new' | 'pending'>('new');
  const [dismissReason, setDismissReason] = useState('');
  const [overview, setOverview] = useState<LibraryOverview | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<LibraryPreview | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveCollection, setMoveCollection] = useState('general');
  const [moveBusy, setMoveBusy] = useState(false);
  const previewRequestRef = useRef(0);

  const [radar, setRadar] = useState<PaperRadarOverview | null>(null);
  const [radarLoading, setRadarLoading] = useState(true);
  const [radarError, setRadarError] = useState<string | null>(null);
  const [selectedRadarId, setSelectedRadarId] = useState<string | null>(null);
  const [figureData, setFigureData] = useState<Record<string, PaperRadarFigureReply>>({});
  const [figureFailures, setFigureFailures] = useState<Record<string, boolean>>({});
  const [figureRetry, setFigureRetry] = useState(0);
  const [radarBusy, setRadarBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addCollection, setAddCollection] = useState('general');
  const [dismissConfirm, setDismissConfirm] = useState(false);

  useEffect(() => { visibleRef.current = visible; modeRef.current = mode; }, [visible, mode]);
  useEffect(() => { previewRef.current = preview; selectedIdRef.current = selectedId; }, [preview, selectedId]);
  useEffect(() => {
    const changed = () => setWindowVisible(!document.hidden);
    const timer = window.setTimeout(() => {
      changed();
      try {
        const saved = JSON.parse(localStorage.getItem(WORKSPACE_KEY) ?? '{}');
        if (saved.mode === 'library' || saved.mode === 'radar') setMode(saved.mode);
        if (typeof saved.paperKey === 'string' && /^[a-f0-9]{1,16}$/.test(saved.paperKey)) selectedKeyRef.current = saved.paperKey;
        if (typeof saved.radarId === 'string' && saved.radarId.length <= 100) setSelectedRadarId(saved.radarId);
        if (typeof saved.query === 'string' && saved.query.length <= 300) setQuery(saved.query);
        if (saved.radarFilter === 'new' || saved.radarFilter === 'pending') setRadarFilter(saved.radarFilter);
      } catch { /* Corrupt preferences cannot block the reading desk. */ }
      setPreferencesReady(true);
    }, 0);
    document.addEventListener('visibilitychange', changed);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', changed); };
  }, []);
  useEffect(() => {
    if (!preferencesReady) return;
    try { localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ mode, paperKey: selectedKeyRef.current, radarId: selectedRadarId, query, radarFilter })); } catch { /* Storage is optional. */ }
  }, [mode, selectedId, selectedRadarId, query, radarFilter, preferencesReady]);

  // Antes había un segundo hook de redimensionado propio de este espacio, que
  // se comportaba distinto al del resto de Esprit. Ahora usa el compartido.
  const librarySplit = useResizableSplit({ storageKey: 'esprit.library.split', defaultValue: 36, min: 22, max: 68, collapsible: true });
  const radarSplit = useResizableSplit({ storageKey: 'esprit.library.radar.split', defaultValue: 34, min: 22, max: 68, collapsible: true });
  const splitStyle = (split: typeof librarySplit) => ({
    gridTemplateColumns: `minmax(0, ${split.size}fr) 7px minmax(0, ${100 - split.size}fr)`,
  } as CSSProperties);

  const openPaper = useCallback(async (paperId: string) => {
    if (!visibleRef.current || modeRef.current !== 'library') return;
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    setSelectedId(paperId);
    setPreview(null);
    setPreviewLoading(true);
    setError(null);
    setMoveOpen(false);
    try {
      const next = await invoke<LibraryPreview>('library_read', { paperId });
      if (previewRequestRef.current !== requestId) return;
      setPreview(next);
    } catch (reason) {
      if (previewRequestRef.current !== requestId) return;
      setError(String(reason));
    } finally {
      if (previewRequestRef.current === requestId) setPreviewLoading(false);
    }
  }, []);

  const refreshLibrary = useCallback(async () => {
    if (!visibleRef.current || modeRef.current !== 'library') return;
    const requestId = ++libraryRequestRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await readLibraryOverview();
      if (requestId !== libraryRequestRef.current) return;
      overviewLoadedRef.current = true;
      setOverview(result);
      const requested = pendingExternalPaper.current;
      const selected = requested ? result.papers.find(paper => paper.name === requested.name && paper.folder === requested.folder) : result.papers.find((paper) => paperKey(paper) === selectedKeyRef.current) ?? result.papers[0];
      pendingExternalPaper.current = null;
      if (requested && !selected) { setSelectedId(null); selectedIdRef.current = null; setPreview(null); setError('El paper seleccionado cambió de ubicación o ya no está disponible. Busca de nuevo para abrirlo.'); return; }
      setSelectedId(selected?.id ?? null);
      selectedIdRef.current = selected?.id ?? null;
      if (selected) {
        selectedKeyRef.current = paperKey(selected);
        // Refresh may finish after navigation. Keep the catalogue, but defer
        // reading the selected PDF until this subspace is visible again.
        if (visibleRef.current && modeRef.current === 'library') await openPaper(selected.id);
      } else { setPreview(null); }
    } catch (reason) {
      if (requestId === libraryRequestRef.current) setError(String(reason));
    } finally {
      if (requestId === libraryRequestRef.current) setLoading(false);
    }
  }, [openPaper, readLibraryOverview]);

  useEffect(() => {
    if (!visible || !preferencesReady || !externalPaper || externalHandled.current === externalPaper.nonce) return;
    externalHandled.current = externalPaper.nonce;
    pendingExternalPaper.current = externalPaper;
    selectedKeyRef.current = paperKey(externalPaper);
    setQuery(''); setMode('library'); modeRef.current = 'library';
    void refreshLibrary();
  }, [externalPaper, visible, preferencesReady, refreshLibrary]);

  const refreshRadar = useCallback(async () => {
    if (!visibleRef.current || modeRef.current !== 'radar') return;
    const requestId = ++radarRequestRef.current;
    setRadarLoading(true);
    setRadarError(null);
    try {
      const result = await invoke<PaperRadarOverview>('paper_radar_overview');
      if (requestId !== radarRequestRef.current) return;
      setRadar(result);
      setSelectedRadarId((current) => result.pending.some((paper) => paper.id === current) ? current : result.pending[0]?.id ?? null);
      if (!result.pending.some((paper) => paper.is_new)) setRadarFilter('pending');
    } catch (reason) {
      if (requestId === radarRequestRef.current) setRadarError(String(reason));
    } finally {
      if (requestId === radarRequestRef.current) setRadarLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!preferencesReady || !visible) return;
    const initialLoad = window.setTimeout(() => {
      if (mode === 'library') {
        if (!overviewLoadedRef.current) void refreshLibrary();
        else if (selectedIdRef.current && previewRef.current?.id !== selectedIdRef.current) void openPaper(selectedIdRef.current);
      } else { void refreshRadar(); }
    }, 0);
    return () => window.clearTimeout(initialLoad);
  }, [preferencesReady, visible, mode, refreshLibrary, refreshRadar, openPaper]);

  const papers = useMemo(() => {
    const search = query.trim().toLocaleLowerCase('es');
    if (!search) return overview?.papers ?? [];
    return (overview?.papers ?? []).filter((paper) => `${paper.name} ${paper.folder}`.toLocaleLowerCase('es').includes(search));
  }, [overview, query]);

  const selectedPaper = overview?.papers.find((paper) => paper.id === selectedId) ?? null;
  const radarPapers = radar?.pending.filter((paper) => radarFilter === 'new' ? paper.is_new : !paper.is_new) ?? [];
  const selectedRadar = radarPapers.find((paper) => paper.id === selectedRadarId) ?? radarPapers[0] ?? null;
  // Las colecciones vienen del lado nativo; mientras tanto, las de la configuración.
  const fallbackCollections = useMemo(() => [GENERAL_COLLECTION, ...projectCollections], [projectCollections]);
  const collections = radar?.collections?.length ? radar.collections : fallbackCollections;
  const projectLabels: Record<string, string> = useMemo(() => Object.fromEntries([...fallbackCollections, ...collections].map((value) => [value.slug, value.label])), [fallbackCollections, collections]);

  useEffect(() => {
    if (!visible || mode !== 'radar' || !selectedRadar?.figures.length) return;
    let cancelled = false;
    const figures = selectedRadar.figures.filter((figure) => !figureData[figure.id] && !figureFailures[figure.id]);
    if (!figures.length) return;
    void Promise.allSettled(figures.map((figure) => invoke<PaperRadarFigureReply>('paper_radar_figure', { cardId: selectedRadar.id, figureId: figure.id }))).then((results) => {
      if (cancelled) return;
      const loaded: PaperRadarFigureReply[] = [];
      const failed: Record<string, boolean> = {};
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') loaded.push(result.value);
        else failed[figures[index].id] = true;
      });
      if (loaded.length) setFigureData((current) => Object.fromEntries(Object.entries({ ...current, ...Object.fromEntries(loaded.map((value) => [value.id, value])) }).slice(-12)));
      if (Object.keys(failed).length) setFigureFailures((current) => ({ ...current, ...failed }));
    });
    return () => { cancelled = true; };
  }, [figureRetry, selectedRadar, visible, mode, figureData, figureFailures]);

  const retrySelectedFigures = () => {
    if (!selectedRadar) return;
    setFigureFailures((current) => {
      const next = { ...current };
      selectedRadar.figures.forEach((figure) => delete next[figure.id]);
      return next;
    });
    setFigureRetry((value) => value + 1);
  };

  const movePaper = async () => {
    if (!selectedPaper || moveBusy) return;
    setMoveBusy(true);
    setError(null);
    try {
      const reply = await invoke<LibraryMoveReply>('library_move_paper', {
        request: { paper_id: selectedPaper.id, collection: moveCollection, confirmed: true },
      });
      setOverview(reply.overview);
      const moved = reply.overview.papers.find((paper) => paper.name === selectedPaper.name);
      if (moved) { selectedKeyRef.current = paperKey(moved); await openPaper(moved.id); }
      setMoveOpen(false);
      onNotice?.(reply.message);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setMoveBusy(false);
    }
  };

  const updateRadar = (reply: PaperRadarMutationReply) => {
    setRadar(reply.overview);
    setSelectedRadarId(reply.overview.pending[0]?.id ?? null);
    setAddOpen(false);
    setDismissConfirm(false);
    setDismissReason('');
    onNotice?.(reply.message);
  };

  const retryRadar = async () => {
    if (radarBusy) return;
    setRadarBusy(true);
    setRadarError(null);
    try {
      updateRadar(await invoke<PaperRadarMutationReply>('paper_radar_retry', { model: ritualModel, effort: ritualEffort }));
    } catch (reason) {
      setRadarError(String(reason));
    } finally {
      setRadarBusy(false);
    }
  };

  const dismissPaper = async () => {
    if (!selectedRadar || !radar || radarBusy) return;
    setRadarBusy(true);
    setRadarError(null);
    try {
      updateRadar(await invoke<PaperRadarMutationReply>('paper_radar_dismiss', {
        request: { card_id: selectedRadar.id, expected_revision: radar.revision, reason: dismissReason || null },
      }));
    } catch (reason) {
      setRadarError(String(reason));
    } finally {
      setRadarBusy(false);
    }
  };

  const addPaper = async () => {
    if (!selectedRadar || !radar || radarBusy) return;
    setRadarBusy(true);
    setRadarError(null);
    try {
      const reply = await invoke<PaperRadarMutationReply>('paper_radar_add', {
        request: {
          card_id: selectedRadar.id,
          collection: addCollection,
          expected_revision: radar.revision,
          confirmed: true,
        },
      });
      updateRadar(reply);
      overviewLoadedRef.current = false;
    } catch (reason) {
      setRadarError(String(reason));
    } finally {
      setRadarBusy(false);
    }
  };

  const openRadarPaper = async (kind: 'abstract' | 'pdf') => {
    if (!selectedRadar) return;
    try {
      onNotice?.(await invoke<string>('paper_radar_open', { request: { card_id: selectedRadar.id, kind } }));
    } catch (reason) {
      setRadarError(String(reason));
    }
  };

  const chooseAdd = () => {
    const suggested = selectedRadar?.suggested_projects.find((slug) => collections.some((value) => value.slug === slug));
    setAddCollection(suggested ?? 'general');
    setAddOpen(true);
    setDismissConfirm(false);
  };

  return (
    <div className="library-shell">
      <nav className="library-subnav" aria-label="Espacios de Biblioteca">
        <div>
          <button className={mode === 'library' ? 'active' : ''} onClick={() => setMode('library')} type="button" aria-current={mode === 'library' ? 'page' : undefined}><span>Biblioteca local</span><small>{overview?.papers.length ?? '—'}</small></button>
          {radarEnabled ? <button className={mode === 'radar' ? 'active' : ''} onClick={() => setMode('radar')} type="button" aria-current={mode === 'radar' ? 'page' : undefined}><span>Radar de lectura</span><small>{radar?.pending_count ?? '—'}</small></button> : null}
        </div>
        <p>{mode === 'library' ? 'PDFs guardados y organizados en tu carpeta de biblioteca' : 'Criterio estricto · hasta dos lecturas útiles por análisis'}</p>
      </nav>

      <div className="library-space" hidden={mode !== 'library'} style={splitStyle(librarySplit)}>
          <aside className="library-rail">
            <header>
              <div><span>BIBLIOTECA</span><h3>Papers</h3><p>{overview ? `${overview.papers.length} documentos locales` : 'Biblioteca local'}</p></div>
              <div><button onClick={() => void refreshLibrary()} disabled={loading} type="button" aria-label="Actualizar biblioteca">{loading ? '…' : '↻'}</button><button onClick={onOpenFolder} type="button" aria-label="Abrir carpeta de la biblioteca">↗</button></div>
            </header>
            <label className="library-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por título o carpeta…" aria-label="Buscar papers" /></label>
            <div className="library-paper-list" ref={(node) => { if (node) node.scrollTop = scrollPositions.current.library ?? 0; }} onScroll={(event) => { scrollPositions.current.library = event.currentTarget.scrollTop; }}>
              {loading && !overview ? <div className="desk-skeleton" role="status" aria-label="Leyendo la biblioteca"><i /><i /><i /><i /><i /><i /></div> : null}
              {!loading && !error && papers.length === 0 ? <div className="library-state">{query.trim() ? 'No hay PDFs que coincidan con la búsqueda.' : 'Esta colección todavía no tiene PDFs.'}</div> : null}
              {papers.map((paper) => (
                <button className={selectedId === paper.id ? 'active' : ''} onClick={() => { selectedKeyRef.current = paperKey(paper); void openPaper(paper.id); }} type="button" key={paper.id} aria-current={selectedId === paper.id ? 'true' : undefined}>
                  <i>PDF</i><span><strong>{paper.name}</strong><small>{paper.folder} · {formatSize(paper.size)}</small></span><b aria-hidden="true">›</b>
                </button>
              ))}
            </div>
            <footer><span>PDFs locales</span><button onClick={onOpenFolder} type="button">Abrir carpeta ↗</button></footer>
          </aside>

          <SplitDivider split={librarySplit} className="library-resizer" label="Cambiar ancho entre papers y visor" paneLabel="la lista de papers" />

          <section className="library-viewer">
            <header>
              <div><span>VISOR PDF</span><h3>{preview?.name ?? (previewLoading ? 'Abriendo paper…' : 'Selecciona un paper')}</h3></div>
              <div className="library-viewer-actions">{selectedPaper ? <button disabled={!research.ready} type="button" onClick={() => onOpenNote(blankNote('reading', { title: selectedPaper.name.replace(/\.pdf$/i, ''), fields: { source: paperSource(selectedPaper) } }))}>＋ Lectura activa</button> : null}{preview ? <small>{formatSize(preview.size)}</small> : null}{selectedPaper ? <button onClick={() => { setMoveCollection('general'); setMoveOpen(true); }} type="button">Organizar…</button> : null}</div>
            </header>
            {selectedPaper ? <div className="library-reading-links">{research.notes.filter(note => note.kind === 'reading' && note.fields.source === paperSource(selectedPaper)).map(note => <button type="button" key={note.id} onClick={() => onOpenNote(note)}>↗ {note.title}</button>)}{Object.entries(research.drafts).filter(([,note]) => note.kind === 'reading' && note.fields.source === paperSource(selectedPaper)).map(([id,note]) => <button type="button" key={id} onClick={() => onOpenNote(note,id)}>◌ Retomar borrador</button>)}</div> : null}
            {error ? <div className="library-viewer-state error"><span>!</span><p>{error}</p><button onClick={() => void refreshLibrary()} type="button">Reintentar</button></div> : null}
            {!error && previewLoading ? <div className="library-viewer-state"><i />Preparando vista previa…</div> : null}
            {!error && !previewLoading && preview ? <PdfViewer key={selectedPaper ? paperKey(selectedPaper) : preview.id} dataBase64={preview.data_base64} name={preview.name} active={visible && mode === 'library'} storageKey={`esprit.library.pdf.${selectedPaper ? paperKey(selectedPaper) : preview.id}`} /> : null}
            {!error && !previewLoading && !preview ? <div className="library-viewer-state"><span>PDF</span><p>Elige un paper en la columna izquierda.</p></div> : null}
            {moveOpen && selectedPaper ? (
              <div className="library-dialog-backdrop">
                <section className="library-dialog" role="dialog" aria-modal="true" aria-label="Organizar paper">
                  <span>ORGANIZAR EN LA BIBLIOTECA</span><h3>Mover a una colección</h3><p>El archivo seguirá dentro de la biblioteca; solo cambiará a la subcarpeta de la colección elegida.</p>
                  <label><span>DESTINO</span><select value={moveCollection} onChange={(event) => setMoveCollection(event.target.value)}>{collections.map((collection) => <option key={collection.slug} value={collection.slug}>{collection.label}</option>)}</select></label>
                  <div><button onClick={() => setMoveOpen(false)} disabled={moveBusy} type="button">Cancelar</button><button onClick={() => void movePaper()} disabled={moveBusy} type="button">{moveBusy ? 'Moviendo…' : 'Confirmar movimiento'}</button></div>
                </section>
              </div>
            ) : null}
          </section>
        </div>
        <div className="radar-space" hidden={mode !== 'radar'} style={splitStyle(radarSplit)}>
          <aside className="radar-rail">
            <header>
              <div><span>RADAR / LOGIN</span><h3>Lecturas nuevas</h3><p>{formatRadarCheck(radar?.checked_at ?? null)}</p></div>
              <button onClick={() => void refreshRadar()} disabled={radarLoading} type="button" aria-label="Actualizar estado del radar">{radarLoading ? '…' : '↻'}</button>
            </header>
            <div className={`radar-status ${radar?.status ?? 'not_checked'}`}><i />
              <div><strong>{radar?.status === 'recommendations' ? `${radar.pending_count} pendiente${radar.pending_count === 1 ? '' : 's'}` : radar?.status === 'nothing_relevant' ? 'Sin selección nueva' : radar?.status === 'unavailable' ? 'Radar no disponible' : 'Esperando Login'}</strong><p>{radar?.message ?? 'Haz Login para buscar papers recientes.'}</p>{radar?.status === 'unavailable' ? <button onClick={() => void retryRadar()} disabled={radarBusy} type="button">{radarBusy ? 'Analizando…' : 'Reintentar análisis'}</button> : null}</div>
            </div>
            <div className="radar-coverage-slot">{radar?.coverage ? <details className="radar-coverage"><summary>{radar.coverage.evaluated} de {radar.coverage.recovered} evaluados · {radar.coverage.remaining} por revisar</summary><p>Esta ejecución: {radar.coverage.evaluated_this_run}. Recuperados: {radar.coverage.recovered}{radar.coverage.source_total !== null ? ` de ${radar.coverage.source_total} coincidencias de arXiv` : '; arXiv no informó del total'}.</p>{radar.coverage.truncated ? <p>La consulta está truncada: la selección cubre solo los candidatos recuperados.</p> : null}<p>Ventana: {radar.coverage.window_start.slice(0, 8)}–{radar.coverage.window_end.slice(0, 8)} UTC.</p></details> : null}</div>
            <nav className="radar-reading-tabs" aria-label="Antigüedad de recomendaciones"><button type="button" className={radarFilter === 'new' ? 'active' : ''} onClick={() => setRadarFilter('new')}>Novedades <span>{radar?.pending.filter((paper) => paper.is_new).length ?? 0}</span></button><button type="button" className={radarFilter === 'pending' ? 'active' : ''} onClick={() => setRadarFilter('pending')}>Pendientes anteriores <span>{radar?.pending.filter((paper) => !paper.is_new).length ?? 0}</span></button></nav>
            <div className="radar-paper-list" ref={(node) => { if (node) node.scrollTop = scrollPositions.current[`radar-${radarFilter}`] ?? 0; }} onScroll={(event) => { scrollPositions.current[`radar-${radarFilter}`] = event.currentTarget.scrollTop; }}>
              {radarLoading && !radar ? <div className="library-state">Leyendo el radar…</div> : null}
              {!radarLoading && radarError ? <div className="library-state error">{radarError}</div> : null}
              {!radarLoading && !radarError && radar && radarPapers.length === 0 ? <div className="radar-empty"><span>∅</span><h4>{radarFilter === 'new' ? 'Sin novedades seleccionadas' : 'Sin pendientes anteriores'}</h4><p>{radarFilter === 'new' ? radar.message : 'Las lecturas del último análisis están en Novedades.'}</p></div> : null}
              {radarPapers.map((paper) => (
                <button className={paper.id === selectedRadar?.id ? 'active' : ''} onClick={() => { setSelectedRadarId(paper.id); setAddOpen(false); setDismissConfirm(false); }} type="button" key={paper.id} aria-current={paper.id === selectedRadar?.id ? 'true' : undefined}>
                  <div><span>{paper.primary_category || 'arXiv'}</span><b>{paper.relevance_score}</b></div><strong>{paper.title}</strong><small>{formatPaperDate(paper.published)} · {projectLabels[paper.suggested_projects[0]] ?? 'Biblioteca general'}</small>
                </button>
              ))}
            </div>
            <footer><span>{radar?.added_count ?? 0} guardados · {radar?.dismissed_count ?? 0} descartados</span>{radar?.source_stale ? <b>Fuente en caché</b> : <b>arXiv</b>}</footer>
          </aside>

          <SplitDivider split={radarSplit} className="library-resizer" label="Cambiar ancho entre radar y artículo" paneLabel="el radar" />

          <section className="radar-detail">
            {radarError ? <div className="radar-inline-error">{radarError}<button onClick={() => setRadarError(null)} type="button">×</button></div> : null}
            {!selectedRadar ? <div className="radar-detail-empty"><span>RADAR</span><h3>Tu próxima lectura útil aparecerá aquí.</h3><p>Esprit compara cada tanda nueva con el estado real de tus proyectos. Si no encuentra una conexión concreta, no recomienda nada.</p></div> : (
              <>
                <header>
                  <div className="radar-kicker"><span>{selectedRadar.primary_category || 'arXiv'}</span><i>{selectedRadar.recommendation_kind === 'scientific' ? 'Conexión científica' : selectedRadar.recommendation_kind === 'methodological' ? 'Transferencia metodológica' : 'Dirección exploratoria'}</i><b title="Afinidad estimada desde el abstract; no mide calidad científica">Afinidad {selectedRadar.relevance_score}/100</b></div>
                  <h2>{selectedRadar.title}</h2>
                  <p>{selectedRadar.authors.slice(0, 8).join(' · ')}{selectedRadar.authors.length > 8 ? ` · +${selectedRadar.authors.length - 8}` : ''}</p>
                  <div className="radar-meta"><time>{formatPaperDate(selectedRadar.published)}</time><span>Resumen basado en abstract</span>{selectedRadar.suggested_projects.map((slug) => <i key={slug}>{projectLabels[slug] ?? slug}</i>)}</div>
                </header>
                <div className="radar-detail-scroll" ref={(node) => { if (node) node.scrollTop = scrollPositions.current[selectedRadar.id] ?? 0; }} onScroll={(event) => { scrollPositions.current[selectedRadar.id] = event.currentTarget.scrollTop; }}>
                  <section className="radar-copy"><span>EN DOS MINUTOS</span><p>{selectedRadar.summary}</p></section>
                  <section className="radar-relevance"><span>POR QUÉ TE IMPORTA</span><p>{selectedRadar.why_relevant}</p></section>
                  {selectedRadar.evidence ? <section className="radar-evidence"><span>EVIDENCIA DEL ABSTRACT</span><blockquote>{selectedRadar.evidence.quote}</blockquote><dl><dt>Mecanismo</dt><dd>{selectedRadar.evidence.mechanism}</dd><dt>Uso en el proyecto</dt><dd>{selectedRadar.evidence.concrete_use}</dd><dt>Lo que aún falta verificar</dt><dd>{selectedRadar.evidence.limitations}</dd></dl></section> : <p className="radar-legacy-note">Recomendación anterior al criterio estricto. Conserva su evaluación original.</p>}
                  <section className="radar-figures">
                    <header><span>FIGURA DESTACADA</span><small>Selección automática desde el HTML de arXiv</small></header>
                    {selectedRadar.figures.length > 0 && selectedRadar.figures.some((figure) => !figureData[figure.id] && !figureFailures[figure.id]) ? <div className="radar-figure-state"><i />Recuperando figuras…</div> : null}
                    {selectedRadar.figures.map((figure) => {
                      const loaded = figureData[figure.id];
                      return loaded ? (
                        <figure key={figure.id}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={`data:${loaded.mime_type};base64,${loaded.data_base64}`} alt={loaded.caption || `Figura de ${selectedRadar.title}`} />
                          <figcaption>{loaded.caption}</figcaption>
                        </figure>
                      ) : null;
                    })}
                    {selectedRadar.figures.some((figure) => figureFailures[figure.id]) ? <div className="radar-figure-state error"><span>Vista no disponible</span><p>La figura guardada en la caché local ya no se pudo leer.</p><button onClick={retrySelectedFigures} type="button">Reintentar</button></div> : null}
                    {selectedRadar.figures.length === 0 ? <div className="radar-figure-state"><span>Sin figura</span><p>{selectedRadar.figure_warning || 'No hay una figura raster recuperable para este paper.'}</p></div> : null}
                  </section>
                  <div className="radar-source-actions"><button onClick={() => void openRadarPaper('abstract')} type="button">Abstract en arXiv ↗</button><button onClick={() => void openRadarPaper('pdf')} type="button">PDF original ↗</button></div>
                  <p className="radar-ack">{radar?.acknowledgement}</p>
                </div>
                <footer className="radar-decision-bar">
                  {dismissConfirm ? <div className="radar-confirm"><span>¿Descartar definitivamente esta recomendación?</span><label>Motivo opcional<select value={dismissReason} onChange={(event) => setDismissReason(event.target.value)}><option value="">Sin indicar</option><option value="too_generic">Demasiado genérico</option><option value="already_known">Ya lo conocía</option><option value="outside_projects">No sirve para mis proyectos</option><option value="not_now">Bueno, pero no ahora</option></select></label><button onClick={() => setDismissConfirm(false)} disabled={radarBusy} type="button">Volver</button><button onClick={() => void dismissPaper()} disabled={radarBusy} type="button">{radarBusy ? 'Guardando…' : 'Sí, descartar'}</button></div> : <button className="dismiss" onClick={() => { setDismissConfirm(true); setAddOpen(false); }} disabled={radarBusy} type="button">Descartar</button>}
                  {!dismissConfirm ? <button className="add" onClick={chooseAdd} disabled={radarBusy} type="button">Añadir a biblioteca →</button> : null}
                </footer>
                {addOpen ? (
                  <div className="library-dialog-backdrop">
                    <section className="library-dialog radar-add-dialog" role="dialog" aria-modal="true" aria-label="Añadir paper a biblioteca">
                      <span>AÑADIR A LA BIBLIOTECA</span><h3>¿Dónde lo guardamos?</h3><p>Esprit descargará el PDF original de arXiv solo después de esta confirmación.</p>
                      <label><span>COLECCIÓN</span><select value={addCollection} onChange={(event) => setAddCollection(event.target.value)}>{collections.map((collection) => <option key={collection.slug} value={collection.slug}>{collection.label}</option>)}</select></label>
                      <div><button onClick={() => setAddOpen(false)} disabled={radarBusy} type="button">Cancelar</button><button onClick={() => void addPaper()} disabled={radarBusy} type="button">{radarBusy ? 'Descargando…' : 'Confirmar y añadir'}</button></div>
                    </section>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </div>
    </div>
  );
}
