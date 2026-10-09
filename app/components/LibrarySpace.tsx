'use client';

import { invoke } from '@tauri-apps/api/core';
import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PdfViewer from './PdfViewer';
import LibraryPaperSheet, { ReadToggle, notePreview, radarIdea, type MetaPatch, type PaperMeta } from './LibraryPaperSheet';
import SplitDivider from './SplitDivider';
import { useResizableSplit } from './useResizableSplit';
import './LibrarySpace.css';
import type { PaperTarget } from './GlobalSearch';
import { blankNote, type Research, type ResearchNote } from '../research';
import { coalescedRead } from '../coalescedRead';
import { registerScreen } from '../screenContext';
import { extractPdfText } from './pdfExtract';

type LibraryPaper = PaperMeta & {
  id: string;
  name: string;
  folder: string;
  size: number;
};

type LibraryOverview = {
  checked_at: number;
  papers: LibraryPaper[];
  /** Current projects: valid tags and destinations. */
  tags?: LibraryCollection[];
  meta_warning?: string | null;
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
  /** One-line idea and key points (0.34.4+); older cards fall back to the summary. */
  tldr?: string;
  takeaways?: string[];
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

/** Title shown for a paper: the radar's title when it came from the radar. */
const paperTitle = (paper: LibraryPaper) => paper.radar?.title || displayName(paper.name);
const firstSentence = (text: string) => (text.match(/^.{20,240}?[.!?](?=\s|$)/)?.[0] ?? text.slice(0, 220)).trim();
const shortAuthors = (authors: string[]) => authors.length <= 3 ? authors.join(', ') : `${authors.slice(0, 2).join(', ')} y ${authors.length - 2} más`;
const paperSource = (paper: Pick<LibraryPaper, 'folder' | 'name'>) => `${paper.folder}/${paper.name}`;
const displayName = (name: string) => name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ');

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
  const mode = radarEnabled ? storedMode : 'library';
  const FALLBACK_COLLECTIONS = useMemo(() => [{slug:'general', label:'Biblioteca general'}, ...projectCollections], [projectCollections]);
  const PROJECT_SHORT: Record<string,string> = useMemo(() => Object.fromEntries(FALLBACK_COLLECTIONS.map(p=>[p.slug,p.label])), [FALLBACK_COLLECTIONS]);
  const shortLabel = useCallback((slug: string) => PROJECT_SHORT[slug] ?? slug, [PROJECT_SHORT]);
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
  const [folderFilter, setFolderFilter] = useState<string>('all');
  const [readFilter, setReadFilter] = useState<'all' | 'unread' | 'read'>('all');
  const [metaBusy, setMetaBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveCollection, setMoveCollection] = useState('general');
  const [moveBusy, setMoveBusy] = useState(false);
  // Organizar also renames and moves to the Trash; ＋ adds PDFs from el explorador del sistema.
  const [renameName, setRenameName] = useState('');
  const [trashConfirm, setTrashConfirm] = useState(false);
  const [organizeError, setOrganizeError] = useState<string | null>(null);
  const [pendingPdfs, setPendingPdfs] = useState<File[] | null>(null);
  const [pdfCollection, setPdfCollection] = useState('general');
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
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

  // A paper can carry several project tags; the filters work on tags, not folders.
  const papers = useMemo(() => {
    const search = query.trim().toLocaleLowerCase('es');
    const scoped = (overview?.papers ?? []).filter((paper) => (folderFilter === 'all' || paper.tags.includes(folderFilter))
      && (readFilter === 'all' || (readFilter === 'read') === paper.read));
    if (!search) return scoped;
    return scoped.filter((paper) => `${paper.name} ${paper.folder} ${paper.radar?.title ?? ''} ${paper.radar ? radarIdea(paper.radar) : ''} ${paper.note}`.toLocaleLowerCase('es').includes(search));
  }, [overview, query, folderFilter, readFilter]);
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const paper of overview?.papers ?? []) paper.tags.forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1));
    return [...counts.entries()].sort((left, right) => right[1] - left[1]);
  }, [overview]);
  const unreadCount = overview?.papers.filter((paper) => !paper.read).length ?? 0;
  const libraryTags = overview?.tags?.length ? overview.tags : FALLBACK_COLLECTIONS;
  /** Saves tags, the read marker or the note; the PDF itself is never touched. */
  const updateMeta = async (paper: LibraryPaper, patch: MetaPatch) => {
    setMetaBusy(true);
    try {
      const meta = await invoke<PaperMeta>('library_update_meta', { request: { paper_id: paper.id, ...patch } });
      setOverview((current) => current ? { ...current, papers: current.papers.map((item) => item.id === paper.id ? { ...item, ...meta } : item) } : current);
    } finally { setMetaBusy(false); }
  };

  const selectedPaper = overview?.papers.find((paper) => paper.id === selectedId) ?? null;
  const radarPapers = radar?.pending.filter((paper) => radarFilter === 'new' ? paper.is_new : !paper.is_new) ?? [];
  const selectedRadar = radarPapers.find((paper) => paper.id === selectedRadarId) ?? radarPapers[0] ?? null;
  const collections = radar?.collections?.length ? radar.collections : overview?.tags?.length ? overview.tags : FALLBACK_COLLECTIONS;

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

  const readBase64 = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`No se pudo leer ${file.name}.`));
    reader.onload = () => { const value = String(reader.result ?? ''); const comma = value.indexOf(','); if (comma < 0) reject(new Error(`${file.name} no se pudo preparar.`)); else resolve(value.slice(comma + 1)); };
    reader.readAsDataURL(file);
  });
  const stagePdfs = (files: File[]) => {
    const pdfs = files.filter((file) => /\.pdf$/i.test(file.name));
    if (!pdfs.length) { onNotice?.('La biblioteca solo guarda PDFs.'); return; }
    const tooLarge = pdfs.find((file) => file.size > 80 * 1_048_576);
    setPdfError(tooLarge ? `${tooLarge.name} supera los 80 MB.` : pdfs.length < files.length ? 'Solo se añadirán los PDFs.' : null);
    setPdfCollection(folderFilter !== 'all' && collections.some((item) => item.slug === folderFilter) ? folderFilter : 'general');
    setPendingPdfs(pdfs.filter((file) => file.size <= 80 * 1_048_576));
  };
  const addPdfs = async () => {
    if (!pendingPdfs?.length || pdfBusy) return;
    setPdfBusy(true); setPdfError(null);
    let last: LibraryMoveReply | null = null;
    try {
      for (const file of pendingPdfs) {
        last = await invoke<LibraryMoveReply>('library_import_pdf', { request: { collection: pdfCollection, name: file.name, data_base64: await readBase64(file), confirmed: true } });
      }
      onNotice?.(pendingPdfs.length === 1 ? last!.message : `${pendingPdfs.length} PDFs añadidos a la biblioteca.`);
      setPendingPdfs(null);
    } catch (reason) { setPdfError(String(reason).replace(/^Error:\s*/, '')); }
    finally {
      setPdfBusy(false);
      if (last) setOverview(last.overview);
    }
  };
  const openOrganize = () => {
    if (!selectedPaper) return;
    setMoveCollection(selectedPaper.collection === 'general' ? (selectedPaper.tags.find((tag) => tag !== 'general') ?? 'general') : 'general');
    setRenameName(selectedPaper.name.replace(/\.pdf$/i, ''));
    setTrashConfirm(false); setOrganizeError(null); setMoveOpen(true);
  };
  const renamePaper = async () => {
    if (!selectedPaper || moveBusy) return;
    const name = renameName.trim();
    if (!name || `${name}.pdf` === selectedPaper.name) return;
    setMoveBusy(true); setOrganizeError(null);
    try {
      const reply = await invoke<LibraryMoveReply>('library_rename_paper', { request: { paper_id: selectedPaper.id, name, confirmed: true } });
      setOverview(reply.overview);
      const renamed = reply.overview.papers.find((paper) => paper.folder === selectedPaper.folder && paper.name.toLowerCase() === `${name}.pdf`.toLowerCase());
      if (renamed) { selectedKeyRef.current = paperKey(renamed); await openPaper(renamed.id); }
      setMoveOpen(false);
      onNotice?.(reply.message);
    } catch (reason) { setOrganizeError(String(reason).replace(/^Error:\s*/, '')); }
    finally { setMoveBusy(false); }
  };
  const trashPaper = async () => {
    if (!selectedPaper || moveBusy) return;
    setMoveBusy(true); setOrganizeError(null);
    try {
      const reply = await invoke<LibraryMoveReply>('library_trash_paper', { request: { paper_id: selectedPaper.id, confirmed: true } });
      setOverview(reply.overview);
      setSelectedId(null); selectedIdRef.current = null; setPreview(null); selectedKeyRef.current = null;
      setMoveOpen(false);
      onNotice?.(reply.message);
    } catch (reason) { setOrganizeError(String(reason).replace(/^Error:\s*/, '')); }
    finally { setMoveBusy(false); }
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
      setOrganizeError(String(reason).replace(/^Error:\s*/, ''));
    } finally {
      setMoveBusy(false);
    }
  };

  // Ctrl/⌘J sees the open paper (sheet, note, tags and its first pages) or the radar card.
  const screenRef = useRef({ mode, selectedPaper, preview, selectedRadar });
  useEffect(() => { screenRef.current = { mode, selectedPaper, preview, selectedRadar }; });
  const pdfTextCache = useRef<{ id: string; text: string } | null>(null);
  useEffect(() => {
    if (!visible) return;
    return registerScreen('library', async () => {
      const { mode: current, selectedPaper: paper, preview: open, selectedRadar: card } = screenRef.current;
      if (current === 'radar') {
        if (!card) return { space: 'Biblioteca · Radar', title: 'sin recomendación seleccionada', text: '' };
        return { space: 'Biblioteca · Radar de lectura', title: card.title, text: [`Autores: ${card.authors.join(', ')}`, `Publicado: ${card.published} · ${card.primary_category} · afinidad ${card.relevance_score}`, `Proyecto sugerido: ${card.suggested_projects.join(', ')}`, `Idea: ${card.tldr || card.summary}`, card.takeaways?.length ? `Puntos: ${card.takeaways.join(' | ')}` : '', `Por qué le importa: ${card.why_relevant}`, `Abstract: ${card.summary}`, card.evidence ? `Qué probar: ${card.evidence.concrete_use}\nLímites: ${card.evidence.limitations}` : ''].filter(Boolean).join('\n') };
      }
      if (!paper) return { space: 'Biblioteca', title: 'sin paper abierto', text: '' };
      let pages = '';
      if (open && open.id === paper.id) {
        if (pdfTextCache.current?.id !== paper.id) {
          try { pdfTextCache.current = { id: paper.id, text: await extractPdfText(open.data_base64) }; } catch { pdfTextCache.current = { id: paper.id, text: '' }; }
        }
        pages = pdfTextCache.current.text;
      }
      const radarSheet = paper.radar ? [`Ficha del radar · idea: ${radarIdea(paper.radar)}`, paper.radar.takeaways.length ? `Puntos: ${paper.radar.takeaways.join(' | ')}` : '', `Para qué le sirve: ${paper.radar.why_relevant}`].filter(Boolean).join('\n') : '';
      return { space: 'Biblioteca', title: paperTitle(paper), text: [`Archivo: ${paperSource(paper)}`, `Etiquetas: ${paper.tags.map(shortLabel).join(', ')} · ${paper.read ? 'leído' : 'sin leer'}`, radarSheet, paper.note ? `Notas personales:\n${paper.note}` : '', pages ? `Texto de las primeras páginas:\n${pages}` : ''].filter(Boolean).join('\n\n') };
    });
  }, [visible, shortLabel]);

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
        <p>{mode === 'library' ? 'PDFs guardados y organizados dentro de Bib' : 'Criterio estricto · hasta dos lecturas útiles por análisis'}</p>
      </nav>

      <div className="library-space" hidden={mode !== 'library'} style={splitStyle(librarySplit)}>
          <aside className="library-rail">
            <header>
              <div><span>BIB / PHD</span><h3>Papers</h3><p>{overview ? `${overview.papers.length} documentos locales` : 'Biblioteca local'}</p></div>
              <div><button onClick={() => pdfInputRef.current?.click()} disabled={loading || pdfBusy} type="button" aria-label="Añadir PDFs a la biblioteca" title="Añadir PDFs · también puedes arrastrarlos a la lista">＋</button><button onClick={() => void refreshLibrary()} disabled={loading} type="button" aria-label="Actualizar biblioteca">{loading ? '…' : '↻'}</button><button onClick={onOpenFolder} type="button" aria-label="Abrir carpeta Bib">↗</button></div>
            </header>
            <label className="library-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por título, idea o nota…" aria-label="Buscar papers" /></label>
            {overview?.papers.length ? <div className="library-folder-chips" role="group" aria-label="Filtrar por etiqueta y lectura">
              <span className="library-read-filter" role="group" aria-label="Leído o no"><button type="button" className="unread" aria-pressed={readFilter === 'unread'} onClick={() => setReadFilter(readFilter === 'unread' ? 'all' : 'unread')}><i aria-hidden="true" />Sin leer <small>{unreadCount}</small></button><button type="button" className="read" aria-pressed={readFilter === 'read'} onClick={() => setReadFilter(readFilter === 'read' ? 'all' : 'read')}><i aria-hidden="true" />Leídos <small>{(overview?.papers.length ?? 0) - unreadCount}</small></button></span>
              <button type="button" aria-pressed={folderFilter === 'all'} onClick={() => setFolderFilter('all')}>Todas <small>{overview?.papers.length ?? 0}</small></button>
              {tagCounts.map(([slug, count]) => <button type="button" key={slug} className={`tone-${slug}`} aria-pressed={folderFilter === slug} onClick={() => setFolderFilter(folderFilter === slug ? 'all' : slug)}><i aria-hidden="true" />{shortLabel(slug)} <small>{count}</small></button>)}
            </div> : null}
            {overview?.meta_warning ? <p className="library-meta-warning" role="alert">{overview.meta_warning}</p> : null}
            <input ref={pdfInputRef} className="library-pdf-input" type="file" accept="application/pdf,.pdf" multiple hidden onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; stagePdfs(files); }} />
            <div className="library-paper-list" onDragOver={(event) => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }} onDrop={(event) => { if (![...event.dataTransfer.types].includes('Files')) return; event.preventDefault(); stagePdfs([...event.dataTransfer.files]); }} ref={(node) => { if (node) node.scrollTop = scrollPositions.current.library ?? 0; }} onScroll={(event) => { scrollPositions.current.library = event.currentTarget.scrollTop; }}>
              {loading && !overview ? <div className="desk-skeleton" role="status" aria-label="Leyendo Bib"><i /><i /><i /><i /><i /><i /></div> : null}
              {!loading && !error && papers.length === 0 ? <div className="library-state">{query.trim() ? 'No hay PDFs que coincidan con la búsqueda.' : 'Esta colección todavía no tiene PDFs.'}</div> : null}
              {papers.map((paper) => (
                <button className={`library-item tone-${paper.tags[0] ?? paper.collection}${selectedId === paper.id ? ' active' : ''}${paper.read ? ' is-read' : ''}`} onClick={() => { selectedKeyRef.current = paperKey(paper); void openPaper(paper.id); }} type="button" key={paper.id} aria-current={selectedId === paper.id ? 'true' : undefined} title={`${paper.name} · ${paper.folder} · ${formatSize(paper.size)}`}>
                  <i aria-hidden="true" /><span><strong>{paperTitle(paper)}</strong>{paper.note || paper.radar ? <em>{paper.note ? notePreview(paper.note) : radarIdea(paper.radar!)}</em> : null}<small>{paper.tags.map((tag) => <b key={tag} className={`tone-${tag}`}>{shortLabel(tag)}</b>)}</small></span>
                  <span className={`library-read-dot${paper.read ? ' read' : ''}`} aria-label={paper.read ? 'Leído' : 'Sin leer'} title={paper.read ? 'Leído' : 'Sin leer'} />
                </button>
              ))}
            </div>
            <footer><span>PDFs locales</span><button onClick={onOpenFolder} type="button">Abrir carpeta Bib ↗</button></footer>
          </aside>

          <SplitDivider split={librarySplit} className="library-resizer" label="Cambiar ancho entre papers y visor" paneLabel="la lista de papers" />

          <section className="library-viewer">
            <header>
              <div><span>VISOR PDF</span><h3 title={selectedPaper?.name}>{selectedPaper ? paperTitle(selectedPaper) : preview?.name ?? (previewLoading ? 'Abriendo paper…' : 'Selecciona un paper')}</h3></div>
              <div className="library-viewer-actions">{selectedPaper ? <ReadToggle read={selectedPaper.read} busy={metaBusy} onToggle={() => void updateMeta(selectedPaper, { read: !selectedPaper.read }).catch((reason) => setError(String(reason)))} /> : null}{selectedPaper ? <button disabled={!research.ready} type="button" onClick={() => onOpenNote(blankNote('reading', { title: selectedPaper.name.replace(/\.pdf$/i, ''), fields: { source: paperSource(selectedPaper) } }))}>＋ Lectura activa</button> : null}{preview ? <small>{formatSize(preview.size)}</small> : null}{selectedPaper ? <button onClick={openOrganize} type="button" title="Mover, renombrar o mover a la Papelera">Organizar…</button> : null}</div>
            </header>
            {selectedPaper ? <div className="library-reading-links">{research.notes.filter(note => note.kind === 'reading' && note.fields.source === paperSource(selectedPaper)).map(note => <button type="button" key={note.id} onClick={() => onOpenNote(note)}>↗ {note.title}</button>)}{Object.entries(research.drafts).filter(([,note]) => note.kind === 'reading' && note.fields.source === paperSource(selectedPaper)).map(([id,note]) => <button type="button" key={id} onClick={() => onOpenNote(note,id)}>◌ Retomar borrador</button>)}</div> : null}
            {selectedPaper ? <LibraryPaperSheet key={selectedPaper.id} meta={selectedPaper} tags={libraryTags} label={shortLabel} onUpdate={(patch) => updateMeta(selectedPaper, patch)} /> : null}
            {error ? <div className="library-viewer-state error"><span>!</span><p>{error}</p><button onClick={() => void refreshLibrary()} type="button">Reintentar</button></div> : null}
            {!error && previewLoading ? <div className="library-viewer-state"><i />Preparando vista previa…</div> : null}
            {!error && !previewLoading && preview ? <PdfViewer key={selectedPaper ? paperKey(selectedPaper) : preview.id} dataBase64={preview.data_base64} name={preview.name} active={visible && mode === 'library'} storageKey={`esprit.library.pdf.${selectedPaper ? paperKey(selectedPaper) : preview.id}`} /> : null}
            {!error && !previewLoading && !preview ? <div className="library-viewer-state"><span>PDF</span><p>Elige un paper en la columna izquierda.</p></div> : null}
            {moveOpen && selectedPaper ? (
              <div className="library-dialog-backdrop">
                <section className="library-dialog library-organize" role="dialog" aria-modal="true" aria-label="Organizar paper" onKeyDown={(event) => { if (event.key === 'Escape' && !moveBusy) { event.stopPropagation(); setMoveOpen(false); } }}>
                  <span>ORGANIZAR EN BIB</span><h3 title={selectedPaper.name}>{paperTitle(selectedPaper)}</h3>
                  <fieldset disabled={moveBusy}><legend>Mover a otra carpeta</legend>
                    <p>Sigue dentro de <b>tu biblioteca</b>, en la subcarpeta del proyecto. Etiquetas, lectura y notas se conservan; para que salga en varios proyectos usa <b>＋ Etiquetas</b>.</p>
                    <div><select value={moveCollection} onChange={(event) => setMoveCollection(event.target.value)} aria-label="Carpeta de destino">{collections.map((collection) => <option key={collection.slug} value={collection.slug}>{collection.label}</option>)}</select><button onClick={() => void movePaper()} type="button">{moveBusy ? 'Moviendo…' : 'Mover'}</button></div>
                  </fieldset>
                  <fieldset disabled={moveBusy}><legend>Renombrar</legend>
                    <div><input value={renameName} onChange={(event) => { setRenameName(event.target.value); setOrganizeError(null); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void renamePaper(); } }} maxLength={176} spellCheck={false} aria-label="Nombre nuevo" /><small>.pdf</small><button onClick={() => void renamePaper()} disabled={!renameName.trim() || `${renameName.trim()}.pdf` === selectedPaper.name} type="button">Renombrar</button></div>
                    <p>Nunca reemplaza otro PDF; la ficha del radar y tus notas siguen enlazadas.</p>
                  </fieldset>
                  <fieldset disabled={moveBusy} className="danger-zone"><legend>Papelera</legend>
                    {trashConfirm ? <div><p>Irá a la Papelera del sistema y dejará de estar en Biblioteca, con sus etiquetas y notas. Puedes recuperar el PDF desde la Papelera.</p><button onClick={() => setTrashConfirm(false)} type="button">No</button><button className="danger" onClick={() => void trashPaper()} type="button">{moveBusy ? 'Moviendo…' : 'Mover a la Papelera'}</button></div> : <button className="danger" onClick={() => setTrashConfirm(true)} type="button">Mover a la Papelera…</button>}
                  </fieldset>
                  {organizeError ? <p className="library-organize-error" role="alert">{organizeError}</p> : null}
                  <div><button onClick={() => setMoveOpen(false)} disabled={moveBusy} type="button">Cerrar</button></div>
                </section>
              </div>
            ) : null}
            {pendingPdfs ? (
              <div className="library-dialog-backdrop">
                <section className="library-dialog" role="dialog" aria-modal="true" aria-label="Añadir PDFs" onKeyDown={(event) => { if (event.key === 'Escape' && !pdfBusy) { event.stopPropagation(); setPendingPdfs(null); } }}>
                  <span>AÑADIR A BIBLIOTECA</span><h3>{pendingPdfs.length === 1 ? pendingPdfs[0].name : `${pendingPdfs.length} PDFs`}</h3>
                  {pendingPdfs.length > 1 ? <ul className="library-add-list">{pendingPdfs.slice(0, 10).map((file) => <li key={`${file.name}-${file.size}`}>{file.name} <small>{formatSize(file.size)}</small></li>)}</ul> : null}
                  <p>Se copiarán a la carpeta elegida dentro de <b>tu biblioteca</b>; los originales no se tocan y nunca se reemplaza un PDF existente. Podrás etiquetarlos y anotarlos después.</p>
                  <label><span>CARPETA</span><select value={pdfCollection} onChange={(event) => setPdfCollection(event.target.value)} disabled={pdfBusy}>{collections.map((collection) => <option key={collection.slug} value={collection.slug}>{collection.label}</option>)}</select></label>
                  {pdfError ? <p className="library-organize-error" role="alert">{pdfError}</p> : null}
                  <div><button onClick={() => setPendingPdfs(null)} disabled={pdfBusy} type="button">Cancelar</button><button onClick={() => void addPdfs()} disabled={pdfBusy || !pendingPdfs.length} type="button" autoFocus>{pdfBusy ? 'Copiando…' : 'Añadir'}</button></div>
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
            <div className={`radar-status compact ${radar?.status ?? 'not_checked'}`} title={radar?.coverage ? `${radar.coverage.evaluated} de ${radar.coverage.recovered} candidatos evaluados · ${radar.coverage.remaining} por revisar · ventana ${radar.coverage.window_start.slice(0, 8)}–${radar.coverage.window_end.slice(0, 8)} UTC${radar.coverage.truncated ? ' · consulta truncada' : ''}` : undefined}><i />
              <div><strong>{radar?.status === 'recommendations' ? `${radar.pending_count} ${radar.pending_count === 1 ? 'lectura pendiente' : 'lecturas pendientes'}` : radar?.status === 'nothing_relevant' ? 'Nada nuevo que merezca tu tiempo' : radar?.status === 'unavailable' ? 'Radar no disponible' : 'Esperando al Login'}</strong><p>{radar?.message ?? 'Haz Login para buscar papers recientes.'}</p>{radar?.status === 'unavailable' ? <button onClick={() => void retryRadar()} disabled={radarBusy} type="button">{radarBusy ? 'Analizando…' : 'Reintentar análisis'}</button> : null}</div>
            </div>
            <nav className="radar-reading-tabs" aria-label="Antigüedad de recomendaciones"><button type="button" className={radarFilter === 'new' ? 'active' : ''} onClick={() => setRadarFilter('new')}>Novedades <span>{radar?.pending.filter((paper) => paper.is_new).length ?? 0}</span></button><button type="button" className={radarFilter === 'pending' ? 'active' : ''} onClick={() => setRadarFilter('pending')}>Pendientes anteriores <span>{radar?.pending.filter((paper) => !paper.is_new).length ?? 0}</span></button></nav>
            <div className="radar-paper-list" ref={(node) => { if (node) node.scrollTop = scrollPositions.current[`radar-${radarFilter}`] ?? 0; }} onScroll={(event) => { scrollPositions.current[`radar-${radarFilter}`] = event.currentTarget.scrollTop; }}>
              {radarLoading && !radar ? <div className="library-state">Leyendo el radar…</div> : null}
              {!radarLoading && radarError ? <div className="library-state error">{radarError}</div> : null}
              {!radarLoading && !radarError && radar && radarPapers.length === 0 ? <div className="radar-empty"><span>∅</span><h4>{radarFilter === 'new' ? 'Sin novedades seleccionadas' : 'Sin pendientes anteriores'}</h4><p>{radarFilter === 'new' ? radar.message : 'Las lecturas del último análisis están en Novedades.'}</p></div> : null}
              {radarPapers.map((paper) => (
                <button className={`radar-item tone-${paper.suggested_projects[0] ?? 'general'}${paper.id === selectedRadar?.id ? ' active' : ''}`} onClick={() => { setSelectedRadarId(paper.id); setAddOpen(false); setDismissConfirm(false); }} type="button" key={paper.id} aria-current={paper.id === selectedRadar?.id ? 'true' : undefined}>
                  <span className="radar-ring small" style={{ '--score': paper.relevance_score } as CSSProperties} title={`Afinidad ${paper.relevance_score}/100`}><b>{paper.relevance_score}</b></span>
                  <span className="radar-item-copy"><strong>{paper.title}</strong><small><i aria-hidden="true" />{PROJECT_SHORT[paper.suggested_projects[0]] ?? 'General'} · {formatPaperDate(paper.published)}</small></span>
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
                {(() => {
                  const project = selectedRadar.suggested_projects[0] ?? 'general';
                  const heroFigure = selectedRadar.figures.map((figure) => figureData[figure.id]).find(Boolean);
                  const moreFigures = selectedRadar.figures.map((figure) => figureData[figure.id]).filter(Boolean).slice(1);
                  const figuresPending = selectedRadar.figures.length > 0 && selectedRadar.figures.some((figure) => !figureData[figure.id] && !figureFailures[figure.id]);
                  return <>
                    <header className={`radar-hero tone-${project}`}>
                      <div className="radar-hero-copy">
                        <div className="radar-chips"><span className="radar-chip project"><i aria-hidden="true" />{PROJECT_SHORT[project] ?? project}</span><span className="radar-chip">{selectedRadar.recommendation_kind === 'scientific' ? 'Conexión científica' : selectedRadar.recommendation_kind === 'methodological' ? 'Método transferible' : 'Exploratorio'}</span><span className="radar-chip muted">{selectedRadar.primary_category || 'arXiv'} · {formatPaperDate(selectedRadar.published)}</span></div>
                        <h2>{selectedRadar.title}</h2>
                        <p className="radar-authors" title={selectedRadar.authors.join(', ')}>{shortAuthors(selectedRadar.authors)}</p>
                      </div>
                      <div className="radar-ring" style={{ '--score': selectedRadar.relevance_score } as CSSProperties} title="Afinidad estimada desde el abstract; no mide calidad científica"><b>{selectedRadar.relevance_score}</b><small>afinidad</small></div>
                    </header>
                    <div className="radar-detail-scroll" ref={(node) => { if (node) node.scrollTop = scrollPositions.current[selectedRadar.id] ?? 0; }} onScroll={(event) => { scrollPositions.current[selectedRadar.id] = event.currentTarget.scrollTop; }}>
                      {heroFigure ? <figure className="radar-hero-figure">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`data:${heroFigure.mime_type};base64,${heroFigure.data_base64}`} alt={heroFigure.caption || `Figura de ${selectedRadar.title}`} />
                        {heroFigure.caption ? <figcaption>{heroFigure.caption}</figcaption> : null}
                      </figure> : figuresPending ? <div className="radar-hero-figure loading" aria-label="Recuperando figura"><i /></div> : null}
                      <p className="radar-tldr">{selectedRadar.tldr || firstSentence(selectedRadar.summary)}</p>
                      {selectedRadar.takeaways?.length ? <ul className="radar-takeaways">{selectedRadar.takeaways.map((point) => <li key={point}>{point}</li>)}</ul> : null}
                      <section className={`radar-why tone-${project}`}><span>Por qué te importa · {PROJECT_SHORT[project] ?? project}</span><p>{selectedRadar.why_relevant}</p></section>
                      <details className="radar-more"><summary>Resumen completo</summary><p>{selectedRadar.summary}</p><small>Basado solo en el abstract.</small></details>
                      {selectedRadar.evidence ? <details className="radar-more"><summary>Evidencia y límites</summary><blockquote>{selectedRadar.evidence.quote}</blockquote><dl><dt>Mecanismo</dt><dd>{selectedRadar.evidence.mechanism}</dd><dt>Qué probar en el proyecto</dt><dd>{selectedRadar.evidence.concrete_use}</dd><dt>Lo que falta verificar</dt><dd>{selectedRadar.evidence.limitations}</dd></dl></details> : null}
                      {moreFigures.length ? <details className="radar-more"><summary>Más figuras · {moreFigures.length}</summary>{moreFigures.map((figure) => figure ? <figure key={figure.id}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`data:${figure.mime_type};base64,${figure.data_base64}`} alt={figure.caption || 'Figura'} /><figcaption>{figure.caption}</figcaption></figure> : null)}</details> : null}
                      {selectedRadar.figures.some((figure) => figureFailures[figure.id]) ? <div className="radar-figure-state error"><span>Figura no disponible</span><button onClick={retrySelectedFigures} type="button">Reintentar</button></div> : null}
                      <div className="radar-source-actions"><button onClick={() => void openRadarPaper('abstract')} type="button">Abstract ↗</button><button onClick={() => void openRadarPaper('pdf')} type="button">PDF ↗</button></div>
                      <p className="radar-ack">{radar?.acknowledgement}</p>
                    </div>
                  </>;
                })()}
                <footer className="radar-decision-bar">
                  {dismissConfirm ? <div className="radar-confirm"><span>¿Descartar definitivamente esta recomendación?</span><label>Motivo opcional<select value={dismissReason} onChange={(event) => setDismissReason(event.target.value)}><option value="">Sin indicar</option><option value="too_generic">Demasiado genérico</option><option value="already_known">Ya lo conocía</option><option value="outside_projects">No sirve para mis proyectos</option><option value="not_now">Bueno, pero no ahora</option></select></label><button onClick={() => setDismissConfirm(false)} disabled={radarBusy} type="button">Volver</button><button onClick={() => void dismissPaper()} disabled={radarBusy} type="button">{radarBusy ? 'Guardando…' : 'Sí, descartar'}</button></div> : <button className="dismiss" onClick={() => { setDismissConfirm(true); setAddOpen(false); }} disabled={radarBusy} type="button">Descartar</button>}
                  {!dismissConfirm ? <button className="add" onClick={chooseAdd} disabled={radarBusy} type="button">Añadir a biblioteca →</button> : null}
                </footer>
                {addOpen ? (
                  <div className="library-dialog-backdrop">
                    <section className="library-dialog radar-add-dialog" role="dialog" aria-modal="true" aria-label="Añadir paper a biblioteca">
                      <span>AÑADIR A BIBLIOTECA</span><h3>¿Dónde lo guardamos?</h3><p>Esprit descargará el PDF original de arXiv solo después de esta confirmación. En Biblioteca conservará su ficha del radar (idea, puntos clave y para qué te sirve), que podrás editar y completar con tus notas.</p>
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
