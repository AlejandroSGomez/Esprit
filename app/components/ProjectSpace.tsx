'use client';

/* Local previews use authenticated data URLs, so Next Image is not applicable. */
/* eslint-disable @next/next/no-img-element */

import { invoke } from '@tauri-apps/api/core';
import { CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { registerScreen } from '../screenContext';
import { extractPdfText } from './pdfExtract';
import SpreadsheetEditor from './SpreadsheetEditor';
import { officeText } from '../xlsx';
import FileTypeIcon, { FILE_TYPE_ORDER, fileVisualType } from './FileTypeIcon';
import HtmlViewer, { isHtmlFile } from './HtmlViewer';
import LatexEditor, { LatexEditorHandle } from './LatexEditor';
import MarkdownEditor, { MarkdownEditorHandle } from './MarkdownEditor';
import PdfViewer from './PdfViewer';
import ScientificEditor, { EditorImageDrop, editorLanguageForFileName, type ScientificEditorHandle } from './ScientificEditor';
import { findMarkdownImages } from './markdownImageSyntax';
import SplitDivider from './SplitDivider';
import { useResizableSplit } from './useResizableSplit';
import { searchProjectFiles, type SearchFile } from './projectNavigation';
import './workspaceRefinements.css';

export type ProjectOption = {
  slug: string;
  name: string;
  shortName?: string;
  eyebrow: string;
  summary: string;
  next: string;
};

type ProjectEntry = {
  id: string;
  name: string;
  kind: 'directory' | 'file' | 'symlink' | 'other';
  size: number;
  modified: number;
  sensitive: boolean;
};

type ProjectDirectory = {
  session_id: string;
  directory_id: string;
  parent_id: string | null;
  display_path: string;
  entries: ProjectEntry[];
  truncated: boolean;
};

type ProjectFile = {
  id: string;
  name: string;
  display_path: string;
  kind: 'text' | 'pdf' | 'image' | 'external' | 'office';
  mime: string;
  content: string | null;
  data_base64: string | null;
  modified: number;
  size: number;
  sensitive: boolean;
};

type ProjectImagePlan = {
  plan_id: string;
  file_name: string;
  alt: string;
  mime: string;
  size: number;
  relative_url: string;
  destination: string;
  data_base64: string;
};

type ProjectImageInsertion = {
  alt: string;
  mime: string;
  size: number;
  relative_url: string;
  data_base64: string;
};

type ProjectMarkdownAsset = {
  source: string;
  mime: string;
  data_base64: string;
};

type ProjectCreateDraft = {
  sessionId: string;
  directoryId: string;
  directoryPath: string;
  kind: 'file' | 'directory';
  name: string;
};

type LatexMaster = {
  id: string;
  name: string;
  display_path: string;
  modified: number;
  recommended: boolean;
  reason: string;
};

type LatexPreparation = {
  compiler_available: boolean;
  unavailable_reason: string | null;
  engine_hint: 'pdflatex' | 'xelatex' | 'lualatex';
  masters: LatexMaster[];
  labels: string[];
  citation_keys: string[];
};

type LatexCompileResult = {
  success: boolean;
  build_id: string;
  engine: string;
  master_name: string;
  log: string;
  diagnostics: Array<{ line: number | null; source: string | null; message: string }>;
  pdf_name: string | null;
  pdf_base64: string | null;
};

const formatSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1_048_576) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1_048_576).toFixed(size < 10_485_760 ? 1 : 0)} MB`;
};

const extensionOf = (name: string) => name.split('.').pop()?.toLocaleLowerCase('en') ?? '';
const isMarkdown = (name: string) => ['md', 'markdown'].includes(extensionOf(name));
const isLatex = (name: string) => ['tex', 'ltx', 'bib', 'sty', 'cls'].includes(extensionOf(name));
const isRasterImage = (name: string) => ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extensionOf(name));
const MAX_MARKDOWN_LIVE_CHARACTERS = 500_000;
type EntrySort = 'name' | 'type' | 'modified' | 'size';
const compareEntryNames = (left: ProjectEntry, right: ProjectEntry) => left.name.localeCompare(right.name, 'es', { numeric: true, sensitivity: 'base' });
const typeRank = (entry: ProjectEntry) => FILE_TYPE_ORDER.indexOf(fileVisualType(entry.kind, entry.name, entry.sensitive));
// Folders always lead, as in el explorador del sistema; the chosen key orders what follows.
const sortProjectEntries = (values: ProjectEntry[], sort: EntrySort = 'name') => [...values].sort((left, right) => {
  const folders = (left.kind === 'directory' ? 0 : 1) - (right.kind === 'directory' ? 0 : 1);
  if (folders) return folders;
  if (sort === 'type') return typeRank(left) - typeRank(right) || extensionOf(left.name).localeCompare(extensionOf(right.name), 'en') || compareEntryNames(left, right);
  if (sort === 'modified') return (right.modified ?? 0) - (left.modified ?? 0) || compareEntryNames(left, right);
  if (sort === 'size' && left.kind !== 'directory') return right.size - left.size || compareEntryNames(left, right);
  return compareEntryNames(left, right);
});
const markdownImageSources = (content: string) => {
  const sources: string[] = [];
  const seen = new Set<string>();
  let fence = '';
  for (const line of content.split(/\r\n|\r|\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? '';
    if (marker && (!fence || marker[0] === fence[0] && marker.length >= fence.length)) {
      fence = fence ? '' : marker;
      continue;
    }
    if (fence) continue;
    const inlineCode = [...line.matchAll(/`+[^`]*`+/g)].map((match) => [match.index, match.index + match[0].length] as const);
    for (const image of findMarkdownImages(line)) {
      if (inlineCode.some(([from, to]) => image.from < to && image.to > from)) continue;
      if (seen.has(image.source)) continue;
      seen.add(image.source);
      sources.push(image.source);
      if (sources.length >= 64) return sources;
    }
  }
  return sources;
};

const fileToBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error('No se pudo leer la imagen seleccionada.'));
  reader.onload = () => {
    const value = typeof reader.result === 'string' ? reader.result : '';
    const separator = value.indexOf(',');
    if (separator < 0) reject(new Error('La imagen no se pudo preparar.'));
    else resolve(value.slice(separator + 1));
  };
  reader.readAsDataURL(file);
});
export type ProjectOpenRequest = { project: string; relativePath: string; nonce: number };
type DocumentTarget = { key: string; name: string; folders: string[] };
type PaneStatus = { unsaved: boolean; busy: boolean };
type ProjectSpaceProps = {
  openRequest?: ProjectOpenRequest | null;
  projects: ProjectOption[];
  initialProject: string | null;
  onOpenFolder: (slug: string) => void;
  onAskCodex: (slug: string) => void;
  onSelectProject: (slug: string) => void;
  onNotice: (message: string) => void;
  showHiddenFiles: boolean;
  onEditorStatusChange: (status: { unsaved: boolean; busy: boolean }) => void;
  onClose: () => void;
  active?: boolean;
  /** Docencia reuses the explorer on its fixed root, without project chips or Codex. */
  variant?: 'projects' | 'teaching';
  latexEnabled?: boolean;
};

const fileBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error(`No se pudo leer ${file.name}.`));
  reader.onload = () => {
    const value = typeof reader.result === 'string' ? reader.result : '';
    const separator = value.indexOf(',');
    if (separator < 0) reject(new Error(`${file.name} no se pudo preparar.`)); else resolve(value.slice(separator + 1));
  };
  reader.readAsDataURL(file);
});
const MAX_IMPORT_BYTES = 80 * 1_048_576;

/** Mounted workspaces retain their native handle, editor undo history and scroll. */
export default function ProjectSpace(props: ProjectSpaceProps) {
  const initial = props.initialProject ?? props.projects[0]?.slug ?? null;
  const [selectedSlug, setSelectedSlug] = useState(initial);
  const [visited, setVisited] = useState<string[]>(initial ? [initial] : []);
  const statuses = useRef(new Map<string, { unsaved: boolean; busy: boolean }>());
  const statusCallback = useRef(props.onEditorStatusChange);
  useLayoutEffect(() => { statusCallback.current = props.onEditorStatusChange; }, [props.onEditorStatusChange]);
  const select = useCallback((slug: string) => {
    setVisited((current) => current.includes(slug) ? current : [...current, slug]);
    setSelectedSlug(slug);
  }, []);
  const [lastInitialProject, setLastInitialProject] = useState(props.initialProject);
  if (props.active !== false && props.initialProject !== lastInitialProject) {
    setLastInitialProject(props.initialProject);
    if (props.initialProject && props.projects.some((project) => project.slug === props.initialProject)) select(props.initialProject);
  }
  const [unsavedSlugs, setUnsavedSlugs] = useState<string[]>([]);
  const reportStatus = useCallback((slug: string, status: { unsaved: boolean; busy: boolean }) => {
    statuses.current.set(slug, status);
    const all = [...statuses.current.values()];
    statusCallback.current({ unsaved: all.some((entry) => entry.unsaved), busy: all.some((entry) => entry.busy) });
    const unsaved = [...statuses.current].filter(([, entry]) => entry.unsaved).map(([key]) => key);
    setUnsavedSlugs((current) => current.length === unsaved.length && current.every((key) => unsaved.includes(key)) ? current : unsaved);
  }, []);
  const selected = props.projects.find((project) => project.slug === selectedSlug) ?? null;
  const teaching = props.variant === 'teaching';
  return <div className={`project-shell${teaching ? ' teaching' : ''}`}>
    <div className="project-switcher-bar">
      {teaching ? <h3 className="project-space-title">Docencia</h3> : null}
      {!teaching ? <nav className="project-switcher" aria-label="Proyectos">
        {props.projects.map((project) => <button type="button" key={project.slug} title={project.name} aria-pressed={project.slug === selectedSlug} onClick={() => select(project.slug)}>
          {project.shortName ?? project.name}{unsavedSlugs.includes(project.slug) ? <i aria-label="con cambios sin guardar" /> : null}
        </button>)}
      </nav> : <span className="project-switcher-spacer" />}
      <div className="project-toolbar-actions">
        {selected && !teaching ? <button onClick={() => props.onAskCodex(selected.slug)} type="button" title={`Preguntar a Codex sobre ${selected.name}`}>Codex ↗</button> : null}
        {selected ? <button onClick={() => props.onOpenFolder(selected.slug)} type="button" title={teaching ? 'Abrir Docencia en el explorador del sistema' : 'Abrir la carpeta del proyecto en el explorador del sistema'}>el explorador del sistema ↗</button> : null}
        <button className="project-close" onClick={props.onClose} type="button" aria-label={teaching ? 'Cerrar Docencia' : 'Cerrar Proyectos'}>×</button>
      </div>
    </div>
    <div className="project-sessions">{visited.map((slug) => <div className="project-session" key={slug} hidden={slug !== selectedSlug} style={slug !== selectedSlug ? { display: 'none' } : undefined}>
      <ProjectWorkspace {...props} initialProject={slug} active={props.active !== false && slug === selectedSlug} onWorkspaceStatus={reportStatus} />
    </div>)}</div>
  </div>;
}

type WorkspaceProps = ProjectSpaceProps & {
  onWorkspaceStatus: (slug: string, status: PaneStatus) => void;
};

function ProjectWorkspace(props: WorkspaceProps) {
  const { onNotice, onWorkspaceStatus, initialProject } = props;
  const [tabs, setTabs] = useState<DocumentTarget[]>([]);
  const [selectedTab, setSelectedTab] = useState('explorer');
  const [statuses, setStatuses] = useState<Record<string, PaneStatus>>({});
  const [closing, setClosing] = useState<string | null>(null);
  const reportPane = useCallback((id: string, status: PaneStatus) => {
    setStatuses(current => current[id]?.unsaved === status.unsaved && current[id]?.busy === status.busy ? current : { ...current, [id]: status });
  }, []);
  const openDocument = useCallback((target: DocumentTarget) => {
    if (!tabs.some(tab => tab.key === target.key) && tabs.length >= 8) {
      onNotice('Hay ocho archivos abiertos en este proyecto. Cierra una pestaña para abrir otro.'); return;
    }
    setTabs(current => current.some(tab => tab.key === target.key) ? current : [...current, target]);
    setSelectedTab(target.key);
  }, [tabs, onNotice]);
  const request = props.openRequest;
  const requestSeen = useRef<number | null>(null);
  useEffect(() => {
    if (!request || request.project !== props.initialProject || requestSeen.current === request.nonce) return;
    const timer = window.setTimeout(() => {
      requestSeen.current = request.nonce;
      const parts = request.relativePath.split('/');
      const name = parts.pop();
      if (name) openDocument({key: `file:${request.relativePath}`, name, folders: parts});
    }, 0);
    return () => window.clearTimeout(timer);
  }, [request, props.initialProject, openDocument]);
  useLayoutEffect(() => {
    const all = Object.values(statuses);
    if (initialProject) onWorkspaceStatus(initialProject, {unsaved: all.some(s => s.unsaved), busy: all.some(s => s.busy)});
  }, [statuses, initialProject, onWorkspaceStatus]);
  const closeTab = (id: string) => {
    setTabs(current => current.filter(tab => tab.key !== id));
    setSelectedTab(current => current === id ? 'explorer' : current);
    setClosing(null);
  };
  const requestClose = (id: string) => {
    if (statuses[id]?.busy) { props.onNotice('Espera a que termine la operación de esta pestaña.'); return; }
    if (statuses[id]?.unsaved) setClosing(id); else closeTab(id);
  };
  /** A renamed or trashed entry closes its open tabs (never one with unsaved edits). */
  const forgetPath = useCallback((relative: string) => {
    const affected = (key: string) => key === `file:${relative}` || key.startsWith(`file:${relative}/`);
    const kept = tabs.filter((tab) => affected(tab.key) && statuses[tab.key]?.unsaved);
    setTabs((current) => current.filter((tab) => !affected(tab.key) || statuses[tab.key]?.unsaved));
    setSelectedTab((current) => affected(current) && !statuses[current]?.unsaved ? 'explorer' : current);
    return kept.length === 0;
  }, [tabs, statuses]);
  const blocked = Boolean(closing || statuses[selectedTab]?.busy);
  // The active document portals its controls here, so tabs and actions share one bar.
  const [actionSlot, setActionSlot] = useState<HTMLDivElement | null>(null);
  return <div className="project-tab-workspace">
    <div className="project-document-bar">
      <div className="project-document-tabs" role="tablist" aria-label="Archivos abiertos">
        <button type="button" role="tab" aria-selected={selectedTab === 'explorer'} disabled={blocked} onClick={() => setSelectedTab('explorer')}>⌂ Explorador</button>
        {tabs.map(tab => <div className={`project-document-tab${selectedTab === tab.key ? ' selected' : ''}`} key={tab.key}>
          <button type="button" role="tab" title={[...tab.folders, tab.name].join('/')} aria-selected={selectedTab === tab.key} disabled={blocked} onClick={() => setSelectedTab(tab.key)}><i className={`file-type-dot type-${fileVisualType('file', tab.name)}`} aria-hidden="true" />{tab.name}{statuses[tab.key]?.unsaved ? ' ●' : ''}</button>
          <button type="button" aria-label={`Cerrar ${tab.name}`} disabled={blocked || statuses[tab.key]?.busy} onClick={() => requestClose(tab.key)}>×</button>
        </div>)}
        <button type="button" aria-label="Abrir otro archivo" title="Volver al explorador sin cerrar archivos" disabled={blocked} onClick={() => setSelectedTab('explorer')}>＋</button>
      </div>
      <div className="project-document-actions" ref={setActionSlot} />
    </div>
    {[{key:'explorer', name:'Explorador', folders:[]}, ...tabs].map(tab => <div className="project-tab-pane" role="tabpanel" aria-label={tab.name} key={tab.key} hidden={selectedTab !== tab.key}>
      <ProjectPane {...props} paneId={tab.key} initialDocument={tab.key === 'explorer' ? undefined : tab} active={props.active !== false && selectedTab === tab.key} actionSlot={actionSlot} onWorkspaceStatus={reportPane} onOpenDocument={openDocument} onForgetPath={forgetPath} />
    </div>)}
    {closing ? <div className="project-modal-layer"><div className="project-save-review" role="dialog" aria-modal="true" aria-label="Cerrar archivo con cambios"><h3>¿Cerrar {tabs.find(t => t.key === closing)?.name} sin guardar?</h3><p>El borrador de esta pestaña se perderá. Los demás archivos seguirán abiertos.</p><div><button type="button" autoFocus onClick={() => setClosing(null)}>Seguir editando</button><button type="button" className="danger" onClick={() => closeTab(closing)}>Descartar y cerrar</button></div></div></div> : null}
  </div>;
}

function ProjectPane({ latexEnabled = true, projects, initialProject, onSelectProject, onNotice, showHiddenFiles, active = true, onWorkspaceStatus, paneId, initialDocument, onOpenDocument, actionSlot, onForgetPath, variant }: WorkspaceProps & {
  paneId: string;
  initialDocument?: DocumentTarget;
  onOpenDocument: (target: DocumentTarget) => void;
  actionSlot: HTMLElement | null;
  onForgetPath?: (relative: string) => boolean;
}) {
  const selectedSlug = initialProject ?? projects[0]?.slug ?? null;
  const [directory, setDirectory] = useState<ProjectDirectory | null>(null);
  const [file, setFile] = useState<ProjectFile | null>(null);
  const [draft, setDraft] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [editorMode, setEditorMode] = useState<'live' | 'source'>('live');
  const [browserLayout, setBrowserLayout] = useState<'list' | 'grid' | 'compact'>(() => {
    if (typeof window === 'undefined') return 'grid';
    const stored = window.localStorage.getItem('esprit-project-layout');
    return stored === 'list' || stored === 'compact' || stored === 'grid' ? stored : 'grid';
  });
  const [entrySort, setEntrySort] = useState<EntrySort>(() => {
    if (typeof window === 'undefined') return 'name';
    const stored = window.localStorage.getItem('esprit-project-sort');
    return stored === 'type' || stored === 'modified' || stored === 'size' ? stored : 'name';
  });
  const [viewerToolsSlot, setViewerToolsSlot] = useState<HTMLSpanElement | null>(null);
  const [loading, setLoading] = useState(false);
  const fileLoading = false;
  const [saving, setSaving] = useState(false);
  const [saveReview, setSaveReview] = useState(false);
  const [discardAction, setDiscardAction] = useState<(() => void) | null>(null);
  const [pendingCreate, setPendingCreate] = useState<ProjectCreateDraft | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Rename, Trash and add files (2026-09-29): each one confirmed in its own dialog.
  const [entryMenu, setEntryMenu] = useState<{ entry: ProjectEntry; x: number; y: number } | null>(null);
  const [pendingRename, setPendingRename] = useState<{ entry: ProjectEntry; name: string } | null>(null);
  const [pendingTrash, setPendingTrash] = useState<ProjectEntry | null>(null);
  const [pendingImport, setPendingImport] = useState<File[] | null>(null);
  const [fileOpBusy, setFileOpBusy] = useState(false);
  const [fileOpError, setFileOpError] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [markdownAssets, setMarkdownAssets] = useState<Record<string, string>>({});
  const [pendingImage, setPendingImage] = useState<{ plan: ProjectImagePlan; position?: number; sessionId: string; documentId: string } | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [latexPreparation, setLatexPreparation] = useState<LatexPreparation | null>(null);
  const [latexMasterId, setLatexMasterId] = useState<string>('');
  const [latexEngine, setLatexEngine] = useState<'pdflatex' | 'xelatex' | 'lualatex'>('pdflatex');
  const [latexView, setLatexView] = useState<'edit' | 'pdf' | 'log'>('edit');
  const [latexResult, setLatexResult] = useState<LatexCompileResult | null>(null);
  const [latexInvocationError, setLatexInvocationError] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [compileAfterSave, setCompileAfterSave] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diskConflict, setDiskConflict] = useState<ProjectFile | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const directoriesRef = useRef(new Map<string, ProjectDirectory>());
  const [breadcrumbs, setBreadcrumbs] = useState<ProjectDirectory[]>([]);
  const recordDirectory = useCallback((result: ProjectDirectory) => {
    directoriesRef.current.set(result.directory_id, result);
    const chain: ProjectDirectory[] = [];
    const seen = new Set<string>();
    let ancestor: ProjectDirectory | null = result;
    while (ancestor && !seen.has(ancestor.directory_id)) {
      seen.add(ancestor.directory_id); chain.unshift(ancestor);
      ancestor = ancestor.parent_id ? directoriesRef.current.get(ancestor.parent_id) ?? null : null;
    }
    setBreadcrumbs(chain);
    setDirectory(result);
  }, []);
  const rootDirectoryRef = useRef<ProjectDirectory | null>(null);
  const directoryRequest = useRef(0);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickQuery, setQuickQuery] = useState('');
  const [quickFiles, setQuickFiles] = useState<SearchFile[]>([]);
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickCoverage, setQuickCoverage] = useState('');
  const [quickIndex, setQuickIndex] = useState(0);
  const quickRequest = useRef(0);
  const quickTrigger = useRef<HTMLButtonElement | null>(null);
  const [recentFiles, setRecentFiles] = useState<ProjectEntry[]>([]);
  const activeRef = useRef(active);
  useLayoutEffect(() => { activeRef.current = active; }, [active]);

  const browserSplit = useResizableSplit({ collapsible: true, storageKey: 'esprit-project-split', defaultValue: 42, min: 22, max: 58 });
  const sessionRef = useRef<string | null>(null);
  const activeFileIdRef = useRef<string | null>(null);
  const requestRef = useRef(0);
  const latexPrepareSequenceRef = useRef(0);
  const compileSequenceRef = useRef(0);
  const compileInFlightRef = useRef(false);
  const latexEngineTouchedRef = useRef(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const createTriggerRef = useRef<HTMLButtonElement | null>(null);
  const markdownEditorRef = useRef<MarkdownEditorHandle | null>(null);
  // Los enlaces de una nota se abren por el mismo puente validado que usan
  // Mattermost y el correo: solo http/https y sin credenciales.
  const openDocumentLink = useCallback((url: string) => {
    void invoke<string>('document_open_link', { url })
      .then((message) => onNotice(message))
      .catch((reason) => onNotice(String(reason)));
  }, [onNotice]);
  const latexEditorRef = useRef<LatexEditorHandle | null>(null);
  const codeEditorRef = useRef<ScientificEditorHandle | null>(null);
  const selected = projects.find((project) => project.slug === selectedSlug) ?? null;
  const activeLatexId = file && (latexEnabled && isLatex(file.name)) && file.kind === 'text' ? file.id : null;
  const activeLatexName = file && (latexEnabled && isLatex(file.name)) && file.kind === 'text' ? file.name : null;
  const markdownLivePaused = Boolean(file && isMarkdown(file.name) && draft.length > MAX_MARKDOWN_LIVE_CHARACTERS);
  const htmlReadOnly = Boolean(file && isHtmlFile(file.name) && file.size > 2 * 1_048_576);
  const effectiveEditorMode = markdownLivePaused ? 'source' : editorMode;
  const dirty = Boolean(file?.kind === 'text' && draft !== savedContent);
  // Spreadsheets: .xlsx keeps its edits in the editor until its own reviewed save.
  const [sheetDirty, setSheetDirty] = useState(false);
  const [csvView, setCsvView] = useState<'table' | 'text'>('table');
  const isSheet = Boolean(file?.kind === 'office' && /\.xlsx?m?$/i.test(file.name));
  const isCsv = Boolean(file?.kind === 'text' && /\.(csv|tsv)$/i.test(file.name));
  const unsaved = dirty || Boolean(pendingImage) || (isSheet && sheetDirty);
  const operationBusy = loading || fileLoading || saving || imageBusy || compiling || creating || saveReview || Boolean(discardAction) || Boolean(pendingImage) || Boolean(pendingCreate);

  useEffect(() => { activeFileIdRef.current = file?.id ?? null; }, [file?.id]);

  const safely = useCallback((action: () => void) => {
    if (pendingImage) setError('Termina o cancela primero la inserción de imagen pendiente.');
    else if (loading || fileLoading || imageBusy || saving || compiling || creating) setError('Espera a que termine la operación actual.');
    else if (dirty) setDiscardAction(() => action);
    else action();
  }, [compiling, creating, dirty, fileLoading, imageBusy, loading, pendingImage, saving]);

  useLayoutEffect(() => { if (selectedSlug) onWorkspaceStatus(paneId, { unsaved, busy: operationBusy }); }, [onWorkspaceStatus, selectedSlug, paneId, operationBusy, unsaved]);
  useLayoutEffect(() => () => { if (selectedSlug) onWorkspaceStatus(paneId, { unsaved: false, busy: false }); }, [onWorkspaceStatus, selectedSlug, paneId]);

  const stopSession = useCallback(async () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session && '__TAURI_INTERNALS__' in window) {
      try { await invoke('project_browser_stop', { sessionId: session }); } catch { /* Session is already inert. */ }
    }
  }, []);

  const adoptFile = useCallback((result: ProjectFile) => {
        setFile(result);
        setDiskConflict(null);
        const content = result.content ?? '';
        setDraft(content);
        setSavedContent(content);
        setEditorMode(isHtmlFile(result.name) || (isMarkdown(result.name) && content.length <= MAX_MARKDOWN_LIVE_CHARACTERS) ? 'live' : 'source');
        setMarkdownAssets({});
        setLatexPreparation(null);
        setLatexMasterId('');
        setLatexResult(null);
        setLatexInvocationError(null);
        setLatexView('edit');
        latexPrepareSequenceRef.current += 1;
        latexEngineTouchedRef.current = false;
  }, []);

  const startProject = useCallback(async (slug: string) => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    setDirectory(null);
    setFile(null);
    setDraft('');
    setSavedContent('');
    setSaveReview(false);
    setPendingCreate(null);
    setCreateError(null);
    setMarkdownAssets({});
    setLatexPreparation(null);
    setLatexMasterId('');
    setLatexResult(null);
    setLatexInvocationError(null);
    setLatexView('edit');
    latexPrepareSequenceRef.current += 1;
    latexEngineTouchedRef.current = false;
    await stopSession();
    if (!('__TAURI_INTERNALS__' in window)) {
      if (request === requestRef.current) {
        setError('El explorador local funciona dentro de Esprit.app.');
        setLoading(false);
      }
      return;
    }
    try {
      const result = await invoke<ProjectDirectory>('project_browser_start', { project: slug });
      if (request !== requestRef.current) {
        await invoke('project_browser_stop', { sessionId: result.session_id }).catch(() => undefined);
        return;
      }
      sessionRef.current = result.session_id;
      directoriesRef.current = new Map([[result.directory_id, result]]);
      rootDirectoryRef.current = result;
      let current = result;
      const chain = [result.directory_id];
      if (initialDocument) {
        for (const name of initialDocument.folders) {
          const folder = current.entries.find(entry => entry.name === name && entry.kind === 'directory');
          if (!folder) throw new Error(`No se encuentra la carpeta ${name}.`);
          current = await invoke<ProjectDirectory>('project_list', {sessionId: result.session_id, directoryId: folder.id});
          if (request !== requestRef.current) return;
          directoriesRef.current.set(current.directory_id, current);
          chain.push(current.directory_id);
        }
        const entry = current.entries.find(entry => entry.name === initialDocument.name && entry.kind === 'file');
        if (!entry) throw new Error('El archivo ya no está disponible en esta carpeta.');
        const opened = await invoke<ProjectFile>('project_read_file', {sessionId: result.session_id, entryId: entry.id});
        if (request !== requestRef.current) return;
        adoptFile(opened);
      }
      recordDirectory(current);
      setHistory(chain);
      setHistoryIndex(chain.length - 1);
    } catch (reason) {
      if (request === requestRef.current) setError(String(reason));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [stopSession, recordDirectory, initialDocument, adoptFile]);

  useEffect(() => {
    if (!selectedSlug) return;
    const timer = window.setTimeout(() => void startProject(selectedSlug), 0);
    return () => { window.clearTimeout(timer); requestRef.current += 1; void stopSession(); };
  }, [selectedSlug, startProject, stopSession]);

  useEffect(() => { if (active && selectedSlug) onSelectProject(selectedSlug); }, [active, selectedSlug, onSelectProject]);

  const openDirectory = async (directoryId: string, targetIndex?: number, refresh = false) => {
    const sessionId = sessionRef.current;
    if (!sessionId || loading) return;
    const sequence = ++directoryRequest.current;
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<ProjectDirectory>('project_list', { sessionId, directoryId });
      if (sessionRef.current !== sessionId || sequence !== directoryRequest.current) return;
      recordDirectory(result);
      if (!refresh) {
        if (targetIndex !== undefined) setHistoryIndex(targetIndex);
        else if (history[historyIndex] !== result.directory_id) {
          const next = [...history.slice(0, historyIndex + 1), result.directory_id].slice(-100);
          setHistory(next);
          setHistoryIndex(next.length - 1);
        }
      }
    } catch (reason) {
      if (sessionRef.current === sessionId) setError(String(reason));
    } finally {
      if (sequence === directoryRequest.current) setLoading(false);
    }
  };

  const openFile = (entry: ProjectEntry) => {
    if (file?.id === entry.id || entry.kind !== 'file') return;
    const parent = [...directoriesRef.current.values()].find(folder => folder.entries.some(item => item.id === entry.id));
    const root = rootDirectoryRef.current;
    if (!parent || !root) { setError('Actualiza la carpeta para abrir este archivo.'); return; }
    const relative = parent.display_path === root.display_path ? '' : parent.display_path.slice(root.display_path.length + 1);
    setRecentFiles(current => [entry, ...current.filter(item => item.id !== entry.id)].slice(0, 12));
    onOpenDocument({ key: `file:${relative ? `${relative}/${entry.name}` : entry.name}`, name: entry.name, folders: relative ? relative.split('/') : [] });
  };

  const reconnectProject = async () => {
    if (!selectedSlug || loading || fileLoading || saving || compiling || creating || pendingImage) return;
    const previousSession = sessionRef.current;
    const previousRoot = rootDirectoryRef.current;
    const previousDirectory = directory;
    const previousFile = file;
    setLoading(true);
    let nextSession: string | null = null;
    try {
      const root = await invoke<ProjectDirectory>('project_browser_start', { project: selectedSlug });
      nextSession = root.session_id;
      const restoredDirectories = new Map([[root.directory_id, root]]);
      const restoreDirectory = async (displayPath: string) => {
        const rootPath = previousRoot?.display_path ?? root.display_path;
        if (displayPath !== rootPath && !displayPath.startsWith(`${rootPath}/`)) throw new Error('La ubicación anterior ya no pertenece al proyecto. El borrador se conserva.');
        const parts = displayPath.slice(rootPath.length).split('/').filter(Boolean);
        if (parts.length > 32) throw new Error('La ubicación supera el límite de navegación. El borrador se conserva.');
        let current = root;
        for (const part of parts) {
          const entry = current.entries.find((candidate) => candidate.kind === 'directory' && candidate.name === part && !candidate.sensitive);
          if (!entry) throw new Error(`La carpeta ${part} ya no está disponible. El borrador se conserva.`);
          current = restoredDirectories.get(entry.id) ?? await invoke<ProjectDirectory>('project_list', { sessionId: root.session_id, directoryId: entry.id });
          restoredDirectories.set(current.directory_id, current);
        }
        return current;
      };
      const restoredDirectory = previousDirectory ? await restoreDirectory(previousDirectory.display_path) : root;
      let restoredFile: ProjectFile | null = null;
      if (previousFile) {
        const parentPath = previousFile.display_path.slice(0, previousFile.display_path.lastIndexOf('/'));
        const parent = await restoreDirectory(parentPath);
        const entry = parent.entries.find((candidate) => candidate.kind === 'file' && candidate.name === previousFile.name);
        if (!entry) throw new Error('El documento anterior ya no está disponible. Se conserva el borrador sin cambiar su destino.');
        restoredFile = await invoke<ProjectFile>('project_read_file', { sessionId: root.session_id, entryId: entry.id });
      }
      sessionRef.current = root.session_id;
      rootDirectoryRef.current = root;
      directoriesRef.current = restoredDirectories;
      recordDirectory(restoredDirectory);
      setHistory([restoredDirectory.directory_id]); setHistoryIndex(0);
      setQuickFiles([]); setRecentFiles([]);
      if (restoredFile && previousFile) {
        const conflict = previousFile.kind === 'text' && restoredFile.content !== savedContent;
        // Preserve the old revision until the user explicitly discards the local draft.
        setFile(conflict ? { ...previousFile, id: restoredFile.id } : { ...restoredFile, content: previousFile.content });
        setDiskConflict(conflict ? restoredFile : null);
        setError(conflict ? 'El archivo cambió en disco. Se conserva tu borrador y el guardado queda bloqueado hasta revisar la versión nueva.' : null);
      } else setError(null);
      setLatexPreparation(null);
      if (previousSession) void invoke('project_browser_stop', { sessionId: previousSession }).catch(() => undefined);
      onNotice('Sesión del proyecto recuperada. El documento y el borrador se conservan.');
    } catch (reason) {
      if (nextSession && nextSession !== sessionRef.current) void invoke('project_browser_stop', { sessionId: nextSession }).catch(() => undefined);
      setError(String(reason));
    } finally { setLoading(false); }
  };

  const closeQuickOpen = useCallback(() => {
    quickRequest.current += 1;
    setQuickBusy(false);
    setQuickOpen(false);
    requestAnimationFrame(() => quickTrigger.current?.focus());
  }, []);

  const beginQuickOpen = useCallback(() => {
    if (!activeRef.current || !rootDirectoryRef.current || !sessionRef.current) return;
    setQuickOpen(true);
    setQuickQuery('');
    setQuickIndex(0);
    setQuickFiles([]);
    setQuickCoverage('Buscando nombres en carpetas de trabajo…');
    setQuickBusy(true);
    const request = ++quickRequest.current;
    const sessionId = sessionRef.current;
    void searchProjectFiles(rootDirectoryRef.current, async (id) => {
      const result = await invoke<ProjectDirectory>('project_list', { sessionId, directoryId: id });
      if (request === quickRequest.current) directoriesRef.current.set(result.directory_id, result);
      return result;
    }, () => request !== quickRequest.current || !activeRef.current, showHiddenFiles).then((result) => {
      if (request !== quickRequest.current) return;
      setQuickFiles(result.files);
      setQuickCoverage(result.limited ? `Búsqueda parcial: ${result.directories} carpetas, ${result.files.length} archivos. Salta carpetas generadas y enlaces.` : `${result.files.length} archivos · ${result.directories} carpetas. Se excluyen carpetas generadas y enlaces.`);
    }).catch((reason) => {
      if (request === quickRequest.current) setQuickCoverage(`Búsqueda no disponible: ${String(reason)}`);
    }).finally(() => { if (request === quickRequest.current) setQuickBusy(false); });
  }, [showHiddenFiles]);

  useEffect(() => {
    if (!active) { quickRequest.current += 1; const timer = setTimeout(() => { setQuickBusy(false); setQuickOpen(false); }, 0); return () => clearTimeout(timer); }
    const keydown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p' && !event.shiftKey) {
        if (saveReview || pendingImage || pendingCreate || discardAction) return;
        event.preventDefault(); event.stopPropagation(); beginQuickOpen();
      } else if (quickOpen && event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closeQuickOpen();
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => document.removeEventListener('keydown', keydown, true);
  }, [active, beginQuickOpen, closeQuickOpen, discardAction, pendingCreate, pendingImage, quickOpen, saveReview]);

  const quickResults = useMemo(() => {
    const query = quickQuery.trim().toLocaleLowerCase('es');
    if (!query) {
      const recent = recentFiles.map((entry) => ({ ...entry, relativePath: entry.name }));
      return [...recent, ...quickFiles.filter((entry) => !recent.some((item) => item.id === entry.id))].slice(0, 60);
    }
    return quickFiles.filter((entry) => entry.relativePath.toLocaleLowerCase('es').includes(query)).slice(0, 60);
  }, [quickFiles, quickQuery, recentFiles]);
  const chooseQuickFile = (entry: ProjectEntry) => { closeQuickOpen(); openFile(entry); };
  const beginCreate = () => {
    const sessionId = sessionRef.current;
    if (!sessionId || !directory || loading) return;
    setCreateError(null);
    setError(null);
    setPendingCreate({
      sessionId,
      directoryId: directory.directory_id,
      directoryPath: directory.display_path,
      kind: 'file',
      name: '',
    });
  };

  const closeCreate = useCallback(() => {
    setPendingCreate(null);
    setCreateError(null);
    window.requestAnimationFrame(() => createTriggerRef.current?.focus());
  }, []);

  const confirmCreate = async () => {
    const pending = pendingCreate;
    if (!pending || creating) return;
    if (sessionRef.current !== pending.sessionId || directory?.directory_id !== pending.directoryId) {
      setCreateError('La carpeta cambió desde que abriste esta revisión. Ciérrala y vuelve a intentarlo.');
      return;
    }
    setCreating(true);
    setCreateError(null);
    setError(null);
    try {
      const created = await invoke<ProjectEntry>('project_create_entry', {
        request: {
          session_id: pending.sessionId,
          directory_id: pending.directoryId,
          name: pending.name,
          kind: pending.kind,
          confirmed: true,
        },
      });
      if (sessionRef.current !== pending.sessionId) return;
      setDirectory((current) => current?.directory_id === pending.directoryId
        ? { ...current, entries: sortProjectEntries([...current.entries.filter((entry) => entry.id !== created.id), created]) }
        : current);
      setPendingCreate(null);
      onNotice(`${created.name} ${created.kind === 'directory' ? 'creada' : 'creado'} en ${pending.directoryPath}.`);
      const refreshed = await invoke<ProjectDirectory>('project_list', {sessionId: pending.sessionId, directoryId: pending.directoryId});
      recordDirectory(refreshed);
      if (created.kind === 'file') openFile(created);
    } catch (reason) {
      setCreateError(String(reason));
    } finally {
      setCreating(false);
    }
  };

  /** Path of an entry relative to the root, as the tabs name it. */
  const entryRelativePath = (entry: ProjectEntry) => {
    const parent = [...directoriesRef.current.values()].find((folder) => folder.entries.some((item) => item.id === entry.id));
    const root = rootDirectoryRef.current;
    if (!parent || !root) return entry.name;
    const base = parent.display_path === root.display_path ? '' : parent.display_path.slice(root.display_path.length + 1);
    return base ? `${base}/${entry.name}` : entry.name;
  };
  /** The open document blocks the change only when it has unsaved edits. */
  const releaseEntry = (entry: ProjectEntry) => {
    const root = rootDirectoryRef.current;
    const relative = entryRelativePath(entry);
    const openRelative = file && root && file.display_path.startsWith(`${root.display_path}/`) ? file.display_path.slice(root.display_path.length + 1) : null;
    const touchesOpenFile = file && (file.id === entry.id || (entry.kind === 'directory' && openRelative?.startsWith(`${relative}/`)));
    if (touchesOpenFile && dirty) { setFileOpError('Guarda o descarta primero los cambios del archivo abierto.'); return false; }
    if (onForgetPath && !onForgetPath(entryRelativePath(entry))) { setFileOpError('Hay una pestaña con cambios sin guardar dentro de esta entrada. Guárdala o ciérrala primero.'); return false; }
    if (touchesOpenFile) { setFile(null); setDraft(''); setSavedContent(''); }
    return true;
  };
  const refreshCurrent = async () => {
    const sessionId = sessionRef.current;
    if (!sessionId || !directory) return;
    const refreshed = await invoke<ProjectDirectory>('project_list', { sessionId, directoryId: directory.directory_id });
    if (sessionRef.current === sessionId) recordDirectory(refreshed);
  };
  const confirmRename = async () => {
    const pending = pendingRename;
    const sessionId = sessionRef.current;
    if (!pending || !sessionId || fileOpBusy) return;
    const name = pending.name.trim();
    if (!name || name === pending.entry.name) { setPendingRename(null); return; }
    if (!releaseEntry(pending.entry)) return;
    setFileOpBusy(true); setFileOpError(null);
    try {
      await invoke<ProjectEntry>('project_rename_entry', { request: { session_id: sessionId, entry_id: pending.entry.id, name, confirmed: true } });
      setPendingRename(null);
      onNotice(`${pending.entry.name} → ${name}`);
      await refreshCurrent();
    } catch (reason) { setFileOpError(String(reason).replace(/^Error:\s*/, '')); }
    finally { setFileOpBusy(false); }
  };
  const confirmTrash = async () => {
    const entry = pendingTrash;
    const sessionId = sessionRef.current;
    if (!entry || !sessionId || fileOpBusy) return;
    if (!releaseEntry(entry)) return;
    setFileOpBusy(true); setFileOpError(null);
    try {
      await invoke('project_trash_entry', { request: { session_id: sessionId, entry_id: entry.id, confirmed: true } });
      setPendingTrash(null);
      onNotice(`${entry.name} está en la Papelera del sistema.`);
      await refreshCurrent();
    } catch (reason) { setFileOpError(String(reason).replace(/^Error:\s*/, '')); }
    finally { setFileOpBusy(false); }
  };
  const stageImport = (files: File[]) => {
    const chosen = files.filter((item) => item.size > 0 || item.type);
    if (!chosen.length || !directory) return;
    const tooLarge = chosen.find((item) => item.size > MAX_IMPORT_BYTES);
    setFileOpError(tooLarge ? `${tooLarge.name} supera los 80 MB; cópialo desde el explorador del sistema.` : null);
    setPendingImport(chosen.filter((item) => item.size <= MAX_IMPORT_BYTES));
  };
  const confirmImport = async () => {
    const files = pendingImport;
    const sessionId = sessionRef.current;
    if (!files?.length || !sessionId || !directory || fileOpBusy) return;
    setFileOpBusy(true); setFileOpError(null);
    const added: string[] = [];
    try {
      for (const item of files) {
        const created = await invoke<ProjectEntry>('project_import_file', { request: { session_id: sessionId, directory_id: directory.directory_id, name: item.name, data_base64: await fileBase64(item), confirmed: true } });
        added.push(created.name);
      }
      setPendingImport(null);
      onNotice(added.length === 1 ? `${added[0]} añadido a ${directory.display_path}.` : `${added.length} archivos añadidos a ${directory.display_path}.`);
    } catch (reason) {
      setFileOpError(`${added.length ? `Se añadieron ${added.length}; ` : ''}${String(reason).replace(/^Error:\s*/, '')}`);
    } finally {
      setFileOpBusy(false);
      await refreshCurrent().catch(() => undefined);
    }
  };
  useEffect(() => {
    if (!entryMenu) return;
    const close = (event: Event) => { if (!(event.target instanceof Element && event.target.closest('.project-entry-menu'))) setEntryMenu(null); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setEntryMenu(null); };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('mousedown', close, true); window.removeEventListener('keydown', escape, true); };
  }, [entryMenu]);

  // Ctrl/⌘J sees the open folder and document of the visible pane.
  const screenRef = useRef({ directory, file, draft, selected });
  useEffect(() => { screenRef.current = { directory, file, draft, selected }; });
  useEffect(() => {
    if (!active) return;
    return registerScreen(variant === 'teaching' ? 'teaching' : 'projects', async () => {
      const { directory: folder, file: open, draft: text, selected: project } = screenRef.current;
      const listing = folder ? `Carpeta ${folder.display_path}: ${folder.entries.slice(0, 60).map((entry) => `${entry.name}${entry.kind === 'directory' ? '/' : ''}`).join(', ')}` : '';
      let body = '';
      if (open?.kind === 'text') body = `Documento abierto ${open.display_path} (con los cambios sin guardar del editor):\n${text}`;
      else if (open?.kind === 'pdf' && open.data_base64) { try { body = `PDF abierto ${open.display_path}:\n${await extractPdfText(open.data_base64)}`; } catch { body = `PDF abierto ${open.display_path}`; } }
      else if (open) body = `Archivo abierto ${open.display_path} (${open.kind})`;
      return { space: variant === 'teaching' ? 'Docencia' : 'Proyectos', title: open?.name ?? project?.name ?? '', text: [project ? `Proyecto: ${project.name} (${project.slug})` : '', listing, body].filter(Boolean).join('\n\n') };
    });
  }, [active, variant]);

  const openExternal = () => {
    const sessionId = sessionRef.current;
    if (!sessionId || !file) return;
    void invoke<string>('project_open_external', { sessionId, entryId: file.id }).then(onNotice).catch((reason) => setError(String(reason)));
  };

  const fetchLatexPreparation = useCallback(async (target: Pick<ProjectFile, 'id' | 'name' | 'kind'>) => {
    const sessionId = sessionRef.current;
    if (!sessionId || !(latexEnabled && isLatex(target.name)) || target.kind !== 'text') return null;
    const documentId = target.id;
    const sequence = ++latexPrepareSequenceRef.current;
    try {
      const preparation = await invoke<LatexPreparation>('project_latex_prepare', { sessionId, entryId: target.id });
      if (sequence !== latexPrepareSequenceRef.current || sessionRef.current !== sessionId || activeFileIdRef.current !== documentId) return null;
      setLatexPreparation(preparation);
      const recommended = preparation.masters.find((candidate) => candidate.recommended) ?? preparation.masters[0];
      setLatexMasterId((current) => preparation.masters.some((candidate) => candidate.id === current) ? current : recommended?.id ?? '');
      if (!latexEngineTouchedRef.current) setLatexEngine(preparation.engine_hint);
      return preparation;
    } catch (reason) {
      if (sequence === latexPrepareSequenceRef.current && sessionRef.current === sessionId && activeFileIdRef.current === documentId) setError(String(reason));
      return null;
    }
  }, [latexEnabled]);

  useEffect(() => {
    if (!activeLatexId || !activeLatexName) return;
    const timer = window.setTimeout(() => void fetchLatexPreparation({ id: activeLatexId, name: activeLatexName, kind: 'text' }), 0);
    return () => window.clearTimeout(timer);
  }, [activeLatexId, activeLatexName, fetchLatexPreparation]);

  const markdownSourceKey = useMemo(() => {
    if (!file || !isMarkdown(file.name) || file.kind !== 'text' || draft.length > MAX_MARKDOWN_LIVE_CHARACTERS) return '';
    return [...new Set(markdownImageSources(draft))].join('\u0000');
  }, [draft, file]);

  useEffect(() => {
    if (!file || !isMarkdown(file.name) || file.kind !== 'text') return;
    const sessionId = sessionRef.current;
    if (!sessionId) return;
    const sources = markdownSourceKey ? markdownSourceKey.split('\u0000') : [];
    if (sources.length === 0) {
      const clearTimer = window.setTimeout(() => setMarkdownAssets({}), 0);
      return () => window.clearTimeout(clearTimer);
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const assets = await invoke<ProjectMarkdownAsset[]>('project_markdown_assets', {
          request: { session_id: sessionId, document_id: file.id, sources },
        });
        if (cancelled || sessionRef.current !== sessionId) return;
        setMarkdownAssets(Object.fromEntries(assets.map((asset) => [asset.source, `data:${asset.mime};base64,${asset.data_base64}`])));
      } catch {
        // Invalid, remote, missing and oversized images remain ordinary Markdown text.
      }
    }, 240);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [file, markdownSourceKey]);

  const insertProjectImage = (insertion: ProjectImageInsertion, position?: number) => {
    if (!file) return;
    if (isMarkdown(file.name)) {
      setMarkdownAssets((current) => ({ ...current, [insertion.relative_url]: `data:${insertion.mime};base64,${insertion.data_base64}` }));
      const alt = insertion.alt.replace(/\]/g, '\\]');
      markdownEditorRef.current?.insertTrusted(`![${alt}](${insertion.relative_url})`, position);
    } else {
      latexEditorRef.current?.insertTrusted(`\\includegraphics[width=\\linewidth]{${insertion.relative_url}}`, position);
    }
  };

  const stageImage = async (drop: EditorImageDrop) => {
    const sessionId = sessionRef.current;
    if (!sessionId || !file || !(isMarkdown(file.name) || ['tex', 'ltx'].includes(extensionOf(file.name))) || imageBusy || pendingImage) return;
    const documentId = file.id;
    const latexReferenceId = ['tex', 'ltx'].includes(extensionOf(file.name)) ? latexMasterId : null;
    if (['tex', 'ltx'].includes(extensionOf(file.name)) && !latexReferenceId) {
      setError('Selecciona primero el documento principal LaTeX para calcular una ruta de imagen correcta.');
      return;
    }
    setImageBusy(true);
    setError(null);
    try {
      if (drop.projectEntryId) {
        const insertion = await invoke<ProjectImageInsertion>('project_reference_image', {
          sessionId,
          documentId,
          imageEntryId: drop.projectEntryId,
          referenceId: latexReferenceId,
        });
        if (sessionRef.current !== sessionId || activeFileIdRef.current !== documentId) return;
        insertProjectImage(insertion, drop.position);
        onNotice(`Referencia de imagen insertada en ${isMarkdown(file.name) ? 'Markdown' : 'LaTeX'}.`);
        return;
      }
      if (!drop.file) return;
      if (drop.file.size > 25 * 1_048_576) throw new Error('La imagen supera el límite de 25 MB.');
      const plan = await invoke<ProjectImagePlan>('project_prepare_image_import', {
        request: {
          session_id: sessionId,
          document_id: documentId,
          reference_id: latexReferenceId,
          file_name: drop.name || drop.file.name,
          mime: drop.file.type,
          data_base64: await fileToBase64(drop.file),
        },
      });
      if (sessionRef.current !== sessionId || activeFileIdRef.current !== documentId) {
        await invoke('project_cancel_image_import', { planId: plan.plan_id }).catch(() => undefined);
        return;
      }
      setPendingImage({ plan, position: drop.position, sessionId, documentId });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setImageBusy(false);
    }
  };

  const chooseImage = () => imageInputRef.current?.click();

  const applyImage = async () => {
    if (!pendingImage || imageBusy) return;
    if (sessionRef.current !== pendingImage.sessionId || file?.id !== pendingImage.documentId) {
      setError('El documento cambió desde la revisión de imagen; la inserción se canceló.');
      cancelImage();
      return;
    }
    setImageBusy(true);
    setError(null);
    try {
      const insertion = await invoke<ProjectImageInsertion>('project_apply_image_import', {
        request: { plan_id: pendingImage.plan.plan_id, confirmed: true },
      });
      if (sessionRef.current !== pendingImage.sessionId || activeFileIdRef.current !== pendingImage.documentId) {
        setPendingImage(null);
        return;
      }
      insertProjectImage(insertion, pendingImage.position);
      setPendingImage(null);
      onNotice(`${pendingImage.plan.file_name} copiada e insertada.${file && ['tex', 'ltx'].includes(extensionOf(file.name)) ? ' El principal debe cargar \\usepackage{graphicx}.' : ''}`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setImageBusy(false);
    }
  };

  const cancelImage = useCallback(() => {
    if (pendingImage && '__TAURI_INTERNALS__' in window) void invoke('project_cancel_image_import', { planId: pendingImage.plan.plan_id }).catch(() => undefined);
    setPendingImage(null);
  }, [pendingImage]);

  useEffect(() => {
    if (!active || (!saveReview && !pendingImage && !discardAction && !pendingCreate)) return;
    const handleModalEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (imageBusy || saving || creating) return;
      if (discardAction) setDiscardAction(null);
      else if (pendingImage) cancelImage();
      else if (pendingCreate) closeCreate();
      else {
        setSaveReview(false);
        setCompileAfterSave(false);
      }
    };
    document.addEventListener('keydown', handleModalEscape, true);
    return () => document.removeEventListener('keydown', handleModalEscape, true);
  }, [active, cancelImage, closeCreate, creating, discardAction, imageBusy, pendingCreate, pendingImage, saveReview, saving]);

  const compileLatex = async (prepared?: LatexPreparation | null) => {
    const sessionId = sessionRef.current;
    if (!sessionId || !file || compileInFlightRef.current) return;
    const documentId = file.id;
    const sequence = ++compileSequenceRef.current;
    compileInFlightRef.current = true;
    setCompiling(true);
    setError(null);
    setLatexInvocationError(null);
    try {
      const preparation = prepared ?? latexPreparation ?? await fetchLatexPreparation(file);
      if (!preparation?.compiler_available) throw new Error(preparation?.unavailable_reason ?? 'El compilador LaTeX aislado no está disponible.');
      const master = preparation.masters.find((candidate) => candidate.id === latexMasterId)
        ?? preparation.masters.find((candidate) => candidate.recommended)
        ?? preparation.masters[0];
      if (!master) throw new Error('No se encontró un documento principal con \\documentclass.');
      const result = await invoke<LatexCompileResult>('project_latex_compile', {
        request: {
          session_id: sessionId,
          master_id: master.id,
          expected_modified: master.modified,
          engine: latexEngine,
          confirmed: true,
        },
      });
      if (sessionRef.current !== sessionId || activeFileIdRef.current !== documentId) return;
      setLatexResult(result);
      setLatexView(result.success ? 'pdf' : 'log');
      if (result.success) onNotice(`${result.master_name} compilado con ${result.engine}.`);
    } catch (reason) {
      if (sessionRef.current === sessionId && activeFileIdRef.current === documentId) {
        setError(String(reason));
        setLatexResult(null);
        setLatexInvocationError(String(reason));
        setLatexView('log');
      }
    } finally {
      if (compileSequenceRef.current === sequence) {
        compileInFlightRef.current = false;
        setCompiling(false);
      }
    }
  };

  const requestCompile = () => {
    if (diskConflict) { setError('Revisa primero la versión en disco; tu borrador se conserva.'); return; }
    if (dirty) {
      setCompileAfterSave(true);
      setSaveReview(true);
    } else {
      void compileLatex();
    }
  };

  const confirmSave = async () => {
    const sessionId = sessionRef.current;
    if (!sessionId || !file || file.kind !== 'text' || !dirty || saving || diskConflict) return;
    const targetId = file.id;
    const submittedDraft = draft;
    const shouldCompile = compileAfterSave;
    setCompileAfterSave(false);
    setSaving(true);
    setError(null);
    let saved: ProjectFile | null = null;
    try {
      const result = await invoke<ProjectFile>('project_save_file', {
        request: {
          session_id: sessionId,
          entry_id: targetId,
          content: submittedDraft,
          expected_modified: file.modified,
          confirmed: true,
        },
      });
      if (sessionRef.current !== sessionId || activeFileIdRef.current !== targetId) return;
      const persistedContent = result.content ?? submittedDraft;
      setFile(result);
      setDraft((current) => current === submittedDraft ? persistedContent : current);
      setSavedContent(persistedContent);
      setSaveReview(false);
      onNotice(`${result.name} guardado y verificado.`);
      saved = result;
    } catch (reason) {
      setError(String(reason));
      setSaveReview(false);
    } finally {
      setSaving(false);
    }
    if (saved && (latexEnabled && isLatex(saved.name))) {
      const preparation = await fetchLatexPreparation(saved);
      if (preparation && shouldCompile) await compileLatex(preparation);
    }
  };

  const imageSource = file?.kind === 'image' && file.data_base64
    ? `data:${file.mime};base64,${file.data_base64}`
    : null;
  const entries = useMemo(
    () => sortProjectEntries((directory?.entries ?? []).filter((entry) => showHiddenFiles || !entry.name.startsWith('.')), entrySort),
    [directory, showHiddenFiles, entrySort],
  );
  const viewerOpen = Boolean(file || fileLoading);
  const editorActions = file ? (
            <div className="project-editor-actions">
              <span className="project-viewer-tools" ref={setViewerToolsSlot} />
              {file?.kind === 'text' ? <>
                {isMarkdown(file.name) ? <div className="project-view-toggle"><button className={effectiveEditorMode === 'live' ? 'active' : ''} onClick={() => setEditorMode('live')} disabled={markdownLivePaused} title={markdownLivePaused ? 'Vista viva pausada en documentos de más de 500.000 caracteres' : 'Edición visual'} type="button">Escribir</button><button className={effectiveEditorMode === 'source' ? 'active' : ''} onClick={() => setEditorMode('source')} type="button">Fuente</button></div> : null}
                {isHtmlFile(file.name) ? <div className="project-view-toggle"><button className={editorMode === 'live' ? 'active' : ''} onClick={() => setEditorMode('live')} type="button">Vista previa</button><button className={editorMode === 'source' ? 'active' : ''} onClick={() => setEditorMode('source')} type="button">Fuente{htmlReadOnly ? ' · solo lectura' : ''}</button></div> : null}
                {(latexEnabled && isLatex(file.name)) ? <button className="compile" onClick={requestCompile} disabled={compiling || saving || imageBusy || Boolean(pendingImage) || !latexPreparation?.compiler_available || latexPreparation.masters.length === 0} title={latexPreparation?.unavailable_reason ?? 'Compilar PDF · Ctrl/⌘↵'} type="button">{compiling ? 'Compilando…' : dirty ? 'Guardar y compilar' : 'Compilar PDF'}</button> : null}
                <button onClick={() => { if (isMarkdown(file.name)) markdownEditorRef.current?.undo(); else if ((latexEnabled && isLatex(file.name))) latexEditorRef.current?.undo(); else if (codeEditorRef.current) codeEditorRef.current.undo(); else setDiscardAction(() => () => setDraft(savedContent)); setSaveReview(false); }} disabled={!dirty || saving || imageBusy || Boolean(pendingImage)} title="Deshacer el último cambio" type="button">Deshacer</button>
                <button className="primary" onClick={() => setSaveReview(true)} disabled={!dirty || saving || imageBusy || Boolean(pendingImage) || Boolean(diskConflict)} type="button">{saving ? 'Guardando…' : dirty ? 'Guardar' : 'Guardado'}</button>
              </> : null}
            </div>
  ) : null;

  const updateBrowserLayout = (layout: 'list' | 'grid' | 'compact') => {
    setBrowserLayout(layout);
    window.localStorage.setItem('esprit-project-layout', layout);
  };
  const updateEntrySort = (sort: EntrySort) => {
    setEntrySort(sort);
    window.localStorage.setItem('esprit-project-sort', sort);
  };

  return (
    <div className="project-space">
      {active && actionSlot && editorActions ? createPortal(editorActions, actionSlot) : null}
      <div className={`project-browser${viewerOpen ? ' with-viewer' : ' files-only'}`} style={{ '--project-browser-track': browserSplit.track(220) } as CSSProperties}>
        <section className="project-tree">
          <header>
            <div className="project-navigation">
              <button onClick={() => void openDirectory(history[historyIndex - 1], historyIndex - 1)} disabled={loading || historyIndex <= 0} type="button" aria-label="Carpeta anterior" title="Atrás">←</button>
              <button onClick={() => void openDirectory(history[historyIndex + 1], historyIndex + 1)} disabled={loading || historyIndex >= history.length - 1} type="button" aria-label="Carpeta siguiente" title="Adelante">→</button>
              <button onClick={() => directory?.parent_id && void openDirectory(directory.parent_id)} disabled={loading || !directory?.parent_id} title="Subir una carpeta" type="button" aria-label="Subir una carpeta">↑</button>
              <nav className="project-breadcrumbs" aria-label="Ruta del proyecto">{breadcrumbs.map((crumb, index) => <button key={crumb.directory_id} title={crumb.display_path} aria-current={index === breadcrumbs.length - 1 ? 'location' : undefined} disabled={loading} onClick={() => void openDirectory(crumb.directory_id)} type="button">{index ? '› ' : ''}{crumb.display_path.split('/').pop() || selected?.name}</button>)}</nav>
            </div>
            <div className="project-tree-actions">
              <button ref={quickTrigger} onClick={beginQuickOpen} disabled={!directory} title="Buscar archivo · Ctrl/⌘P" aria-label="Buscar archivo" type="button">⌕</button>
              <button ref={createTriggerRef} className="project-create-trigger" onClick={beginCreate} disabled={loading || fileLoading || saving || imageBusy || compiling || creating || Boolean(pendingImage) || saveReview || Boolean(discardAction) || !directory} title="Crear archivo o carpeta" type="button" aria-label={`Crear archivo o carpeta en ${directory?.display_path ?? 'el proyecto'}`} aria-haspopup="dialog" aria-expanded={Boolean(pendingCreate)}>+</button>
              <button className="project-import-trigger" onClick={() => importInputRef.current?.click()} disabled={loading || fileOpBusy || !directory} title="Añadir archivos a esta carpeta · también puedes arrastrarlos desde el explorador del sistema" type="button" aria-label={`Añadir archivos a ${directory?.display_path ?? 'la carpeta'}`}>⤓</button>
              <button onClick={() => directory && void openDirectory(directory.directory_id, undefined, true)} disabled={loading || !directory} type="button" title="Actualizar la carpeta sin cerrar el documento" aria-label="Actualizar carpeta">{loading ? '…' : '↻'}</button>
              <select value={entrySort} onChange={(event) => updateEntrySort(event.target.value as EntrySort)} aria-label="Ordenar archivos" title="Ordenar · las carpetas siempre van primero">
                <option value="name">Nombre</option>
                <option value="type">Tipo</option>
                <option value="modified">Fecha</option>
                <option value="size">Tamaño</option>
              </select>
              <select value={browserLayout} onChange={(event) => updateBrowserLayout(event.target.value as typeof browserLayout)} aria-label="Vista de archivos">
                <option value="grid">Iconos</option>
                <option value="list">Lista</option>
                <option value="compact">Compacta</option>
              </select>
            </div>
          </header>
          <div className="project-status-region" aria-live="polite">
            {error ? <div className="project-state error">{error}{/sesión.*(?:caduc|no existe|no válida)|no pertenece a esta sesión/i.test(error) ? <button onClick={() => void reconnectProject()} disabled={loading || saving || Boolean(pendingImage)} type="button">Reconectar conservando borrador</button> : null}</div> : null}
            {diskConflict ? <div className="project-disk-conflict"><strong>Versión en disco diferente</strong><p>Puedes copiar tu borrador antes de descartarlo. Nada se sobrescribirá.</p><details><summary>Revisar versión en disco</summary><pre>{diskConflict.content}</pre></details><button onClick={() => { const replacement = diskConflict; safely(() => { setFile(replacement); setDraft(replacement.content ?? ''); setSavedContent(replacement.content ?? ''); setDiskConflict(null); setError(null); }); }} type="button">Reabrir versión en disco</button></div> : null}
            {loading ? <div className="project-directory-loading" role="status">{directory ? 'Actualizando carpeta…' : 'Abriendo el proyecto…'}</div> : null}
          </div>
          <div className={`project-entry-list layout-${browserLayout}${dropActive ? ' drop-active' : ''}`}
            onDragOver={(event) => { if ([...event.dataTransfer.types].includes('Files') && directory) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropActive(true); } }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false); }}
            onDrop={(event) => { if (![...event.dataTransfer.types].includes('Files')) return; event.preventDefault(); setDropActive(false); stageImport([...event.dataTransfer.files]); }}>
            {entries.map((entry) => (
              <button
                className={file?.id === entry.id ? 'active' : ''}
                onClick={() => entry.kind === 'directory' ? void openDirectory(entry.id) : openFile(entry)}
                onContextMenu={(event) => { if (entry.kind !== 'file' && entry.kind !== 'directory') return; event.preventDefault(); setEntryMenu({ entry, x: event.clientX, y: event.clientY }); }}
                draggable={Boolean(file && (isMarkdown(file.name) || ['tex', 'ltx'].includes(extensionOf(file.name))) && entry.kind === 'file' && isRasterImage(entry.name))}
                onDragStart={(event) => {
                  if (!file || !(isMarkdown(file.name) || ['tex', 'ltx'].includes(extensionOf(file.name))) || !isRasterImage(entry.name)) return;
                  event.dataTransfer.effectAllowed = 'copy';
                  event.dataTransfer.setData('application/x-esprit-project-image', entry.id);
                  event.dataTransfer.setData('text/plain', entry.name);
                }}
                disabled={entry.kind === 'symlink' || entry.kind === 'other'}
                type="button"
                title={file && (isMarkdown(file.name) || ['tex', 'ltx'].includes(extensionOf(file.name))) && isRasterImage(entry.name) ? `${entry.name} · arrastra al editor para insertar` : entry.name}
                key={entry.id}
              >
                <FileTypeIcon kind={entry.kind} name={entry.name} sensitive={entry.sensitive} />
                <span className="file-entry-copy"><strong>{entry.name}</strong><small>{entry.kind === 'directory' ? 'Carpeta' : entry.kind === 'file' ? formatSize(entry.size) : 'No disponible'}</small></span>
                <b aria-hidden="true">{entry.kind === 'directory' ? '›' : '·'}</b>
              </button>
            ))}
            {!loading && directory && entries.length === 0 ? <p>Esta carpeta está vacía.</p> : null}
          </div>
          {directory?.truncated ? <footer>Listado acotado por seguridad.</footer> : <footer className="project-tree-hint">Clic derecho: renombrar o mover a la Papelera · arrastra archivos aquí para añadirlos</footer>}
        </section>

        {viewerOpen ? <SplitDivider split={browserSplit} className="project-resizer" label="Cambiar ancho del explorador" paneLabel="el explorador" /> : null}

        {viewerOpen ? <section className="project-viewer">
          <div className="project-viewer-body">
            {fileLoading ? <div className="project-empty"><i /><h3>Abriendo archivo</h3></div> : null}
            {!fileLoading && !file ? <div className="project-empty"><span>◇</span><h3>Navega por el proyecto</h3><p>PDF, HTML, Markdown, TeX, código e imágenes se abren aquí sin salir de Esprit.</p></div> : null}
            {!fileLoading && file?.kind === 'pdf' && file.data_base64 ? <PdfViewer dataBase64={file.data_base64} name={file.name} active={active} storageKey={`esprit.project.pdf.${selectedSlug}.${file.display_path}`} /> : null}
            {!fileLoading && file?.kind === 'image' && imageSource ? <div className="project-image"><img src={imageSource} alt={file.name} /></div> : null}
            {!fileLoading && file?.kind === 'text' && isMarkdown(file.name) ? (
              <MarkdownEditor
                key={file.display_path}
                ref={markdownEditorRef}
                value={draft}
                mode={effectiveEditorMode}
                assets={markdownAssets}
                disabled={saving || imageBusy || Boolean(pendingImage)}
                onChange={(content) => { setDraft(content); setSaveReview(false); }}
                onRequestSave={() => dirty && !diskConflict && setSaveReview(true)}
                onImageDrop={(drop) => void stageImage(drop)}
                onChooseImage={chooseImage}
                livePreviewPaused={markdownLivePaused}
                onOpenLink={openDocumentLink}
              />
            ) : null}
            {!fileLoading && file?.kind === 'text' && (latexEnabled && isLatex(file.name)) ? (
              <div className="latex-workbench">
                <div className="latex-build-bar">
                  <div className="latex-view-toggle" role="tablist" aria-label="Vista LaTeX">
                    <button className={latexView === 'edit' ? 'active' : ''} onClick={() => setLatexView('edit')} type="button">Editar</button>
                    <button className={latexView === 'pdf' ? 'active' : ''} onClick={() => setLatexView('pdf')} disabled={!latexResult?.pdf_base64} type="button">PDF</button>
                  <button className={latexView === 'log' ? 'active' : ''} onClick={() => setLatexView('log')} disabled={!latexResult && !latexInvocationError} type="button">Registro{latexResult && !latexResult.success ? ` · ${latexResult.diagnostics.length}` : latexInvocationError ? ' · 1' : ''}</button>
                  </div>
                  <label><span>Principal</span><select value={latexMasterId} onChange={(event) => { setLatexMasterId(event.target.value); setLatexResult(null); setLatexInvocationError(null); setLatexView('edit'); }} disabled={compiling || !latexPreparation?.masters.length}>{latexPreparation?.masters.map((master) => <option value={master.id} title={master.reason} key={master.id}>{master.name}{master.recommended ? ' · recomendado' : ''}</option>)}</select></label>
                  <label><span>Motor</span><select value={latexEngine} onChange={(event) => { latexEngineTouchedRef.current = true; setLatexEngine(event.target.value as typeof latexEngine); setLatexResult(null); setLatexInvocationError(null); setLatexView('edit'); }} disabled={compiling}><option value="pdflatex">pdfLaTeX</option><option value="xelatex">XeLaTeX</option><option value="lualatex">LuaLaTeX</option></select></label>
                  {latexResult ? <button onClick={() => void invoke('project_latex_reveal_output', { buildId: latexResult.build_id }).then((notice) => onNotice(String(notice))).catch((reason) => setError(String(reason)))} type="button">Resultados ↗</button> : null}
                </div>
                {!latexPreparation?.masters.length ? <div className="latex-no-master"><strong>Falta un documento principal</strong><p>Añade <code>\documentclass</code> a un .tex o declara <code>% !TeX root = main.tex</code>.</p></div> : null}
                <div className={`latex-panel editor${latexView === 'edit' ? ' active' : ''}`}>
                  <LatexEditor key={file.display_path} ref={latexEditorRef} value={draft} disabled={saving || compiling || imageBusy || Boolean(pendingImage)} onChange={(content) => { setDraft(content); setSaveReview(false); }} onRequestSave={() => dirty && !diskConflict && setSaveReview(true)} onRequestCompile={requestCompile} onImageDrop={(drop) => void stageImage(drop)} onChooseImage={chooseImage} imageEnabled={['tex', 'ltx'].includes(extensionOf(file.name))} />
                </div>
                <div className={`latex-panel pdf${latexView === 'pdf' ? ' active' : ''}`}>{latexResult?.pdf_base64 ? <PdfViewer dataBase64={latexResult.pdf_base64} name={latexResult.pdf_name ?? 'resultado.pdf'} active={active && latexView === 'pdf'} storageKey={`esprit.project.latex.${selectedSlug}.${latexResult.master_name}`} /> : null}</div>
                <div className={`latex-panel log${latexView === 'log' ? ' active' : ''}`}>
                  {latexResult ? <><header><span className={latexResult.success ? 'success' : 'error'}>{latexResult.success ? 'COMPILACIÓN CORRECTA' : 'REVISAR COMPILACIÓN'}</span><strong>{latexResult.master_name} · {latexResult.engine}</strong></header>{latexResult.diagnostics.length ? <div className="latex-diagnostics">{latexResult.diagnostics.map((diagnostic, index) => { const canJump = Boolean(diagnostic.line && diagnostic.source === file.name && file.id === latexMasterId); return <button onClick={() => { if (!canJump) return; latexEditorRef.current?.goToLine(diagnostic.line!); setLatexView('edit'); }} disabled={!canJump} title={canJump ? 'Ir a la línea' : diagnostic.source ? `Diagnóstico en ${diagnostic.source}` : 'Consulta el registro para localizar este diagnóstico'} type="button" key={`${diagnostic.source}-${diagnostic.line}-${index}`}><span>{diagnostic.line ? `L${diagnostic.line}` : '!'}</span>{diagnostic.source ? `${diagnostic.source}: ${diagnostic.message}` : diagnostic.message}</button>; })}</div> : null}<pre>{latexResult.log || 'El compilador no devolvió detalles.'}</pre></> : latexInvocationError ? <><header><span className="error">COMPILACIÓN INTERRUMPIDA</span><strong>La salida anterior no se reutiliza</strong></header><pre>{latexInvocationError}</pre></> : <div className="project-empty"><span>⌁</span><h3>Sin compilaciones todavía</h3></div>}
                </div>
              </div>
            ) : null}
            {!fileLoading && file?.kind === 'text' && isHtmlFile(file.name) && editorMode === 'live' ? <HtmlViewer key={file.display_path} content={draft} name={file.name} active={active} toolsSlot={active ? viewerToolsSlot : null} /> : null}
            {!fileLoading && file && isSheet && file.data_base64 ? <SpreadsheetEditor key={`${file.display_path}:${file.modified}`} mode="xlsx" name={file.name} dataBase64={file.data_base64} onDirtyChange={setSheetDirty} onOpenExternal={openExternal}
              onSave={async (data) => {
                const sessionId = sessionRef.current;
                if (!sessionId) throw new Error('La sesión del explorador se cerró; vuelve a abrir el libro.');
                const saved = await invoke<ProjectFile>('project_save_binary', { request: { session_id: sessionId, entry_id: file.id, data_base64: data, expected_modified: file.modified, confirmed: true } });
                setFile(saved); setSheetDirty(false); onNotice(`${file.name} guardado.`);
              }} /> : null}
            {!fileLoading && file?.kind === 'office' && !isSheet && file.data_base64 ? <div className="office-preview"><header><strong>{file.name}</strong><small>Vista previa del texto · para editar con formato, ábrelo en su aplicación</small><button type="button" onClick={openExternal}>Abrir en {/\.pptx$/i.test(file.name) ? 'PowerPoint' : 'Word'} ↗</button></header><pre>{(() => { try { return officeText(Uint8Array.from(atob(file.data_base64), (character) => character.charCodeAt(0)), file.name) || 'Sin texto.'; } catch { return 'No se pudo leer el documento.'; } })()}</pre></div> : null}
            {!fileLoading && file && isCsv ? <div className="project-view-toggle csv-toggle"><button className={csvView === 'table' ? 'active' : ''} onClick={() => setCsvView('table')} type="button">Tabla</button><button className={csvView === 'text' ? 'active' : ''} onClick={() => setCsvView('text')} type="button">Texto</button></div> : null}
            {!fileLoading && file && isCsv && csvView === 'table' ? <SpreadsheetEditor key={file.display_path} mode="csv" name={file.name} text={draft} readOnly={saving} onChange={(text) => { setDraft(text); setSaveReview(false); }} onOpenExternal={openExternal} /> : null}
            {!fileLoading && file?.kind === 'text' && !(isCsv && csvView === 'table') && !isMarkdown(file.name) && !(latexEnabled && isLatex(file.name)) && (!isHtmlFile(file.name) || editorMode === 'source') ? <div className="project-code"><ScientificEditor ref={codeEditorRef} key={file.display_path} value={draft} language={editorLanguageForFileName(file.name)} disabled={saving || htmlReadOnly} ariaLabel={`Editar ${file.name}`} onChange={(content) => { setDraft(content); setSaveReview(false); }} onRequestSave={() => dirty && !diskConflict && setSaveReview(true)} /></div> : null}
            {!fileLoading && file?.kind === 'external' ? <div className="project-empty"><span>↗</span><h3>Sin vista previa en Esprit</h3><p>Este formato se abre con su aplicación del sistema (Excel, Numbers, Keynote…). Los cambios que hagas allí se guardan en esta misma carpeta.</p><button type="button" onClick={openExternal}>Abrir con su aplicación ↗</button></div> : null}
          </div>

        </section> : null}
      </div>
      {quickOpen && active ? <div className="project-quick-open" onClick={(event) => { if (event.target === event.currentTarget) closeQuickOpen(); }}>
        <section className="project-quick-dialog" role="dialog" aria-modal="true" aria-label="Buscar archivo en el proyecto" onKeyDown={(event) => {
          if (event.key === 'Tab') {
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input'));
            const index = items.indexOf(document.activeElement as HTMLElement);
            if (event.shiftKey && index === 0) { event.preventDefault(); items.at(-1)?.focus(); }
            else if (!event.shiftKey && index === items.length - 1) { event.preventDefault(); items[0]?.focus(); }
          }
        }}>
          <header><strong>Buscar archivo</strong><button onClick={closeQuickOpen} type="button" aria-label="Cerrar búsqueda">×</button></header>
          <input autoFocus value={quickQuery} onChange={(event) => { setQuickQuery(event.target.value); setQuickIndex(0); }} placeholder="Nombre o carpeta · recientes al dejar vacío" aria-label="Nombre de archivo" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-activedescendant={quickResults[quickIndex] ? `${selectedSlug}-quick-${quickIndex}` : undefined} aria-controls={`${selectedSlug}-quick-results`} onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setQuickIndex((current) => Math.max(0, Math.min(quickResults.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))); }
            else if (event.key === 'Enter' && quickResults[quickIndex]) { event.preventDefault(); chooseQuickFile(quickResults[quickIndex]); }
          }} />
          <small role="status">{quickBusy ? 'Buscando… ' : ''}{quickCoverage}</small>
          <div className="project-quick-results" id={`${selectedSlug}-quick-results`} role="listbox" aria-label="Archivos encontrados">
            {quickResults.map((entry, index) => <button id={`${selectedSlug}-quick-${index}`} role="option" aria-selected={index === quickIndex} key={entry.id} onClick={() => chooseQuickFile(entry)} type="button"><FileTypeIcon kind="file" name={entry.name} /><span><strong>{entry.name}</strong><small>{entry.relativePath}</small></span></button>)}
            {!quickBusy && !quickResults.length ? <p>No hay coincidencias en las carpetas revisadas.</p> : null}
          </div>
        </section>
      </div> : null}

      {pendingCreate ? (
        <div className="project-modal-layer"><form className="project-save-review project-create-review" role="dialog" aria-modal="true" aria-labelledby="project-create-title" aria-describedby="project-create-description" aria-busy={creating} onSubmit={(event) => { event.preventDefault(); void confirmCreate(); }}>
          <span>NUEVA ENTRADA</span>
          <h3 id="project-create-title">Crear en {pendingCreate.directoryPath}</h3>
          <fieldset>
            <legend>Tipo</legend>
            <div className="project-create-kind">
              <button className={pendingCreate.kind === 'file' ? 'active' : ''} onClick={() => { setPendingCreate((current) => current ? { ...current, kind: 'file' } : current); setCreateError(null); }} disabled={creating} aria-pressed={pendingCreate.kind === 'file'} type="button">Archivo</button>
              <button className={pendingCreate.kind === 'directory' ? 'active' : ''} onClick={() => { setPendingCreate((current) => current ? { ...current, kind: 'directory' } : current); setCreateError(null); }} disabled={creating} aria-pressed={pendingCreate.kind === 'directory'} type="button">Carpeta</button>
            </div>
          </fieldset>
          <label>
            <span>Nombre</span>
            <input value={pendingCreate.name} onChange={(event) => { setPendingCreate((current) => current ? { ...current, name: event.target.value } : current); setCreateError(null); }} placeholder={pendingCreate.kind === 'file' ? 'notas.md' : 'Nueva carpeta'} maxLength={180} disabled={creating} aria-invalid={Boolean(createError)} aria-describedby={createError ? 'project-create-description project-create-error' : 'project-create-description'} autoFocus spellCheck={false} />
          </label>
          <p id="project-create-description">Destino: <strong>{pendingCreate.directoryPath}/{pendingCreate.name || '…'}</strong>. {pendingCreate.kind === 'file' ? 'Se creará vacío y se abrirá en el editor. Admite formatos de texto como .md, .tex, .txt, .py, .jl, Makefile o .gitignore.' : 'La carpeta aparecerá en el explorador sin alterar el documento abierto.'} Nunca se reemplazará una entrada existente.</p>

          {createError ? <div id="project-create-error" className="project-create-error" role="alert">{createError}</div> : null}
          <div><button onClick={closeCreate} disabled={creating} type="button">Cancelar</button><button className="primary" disabled={creating || pendingCreate.name.trim().length === 0} type="submit">{creating ? 'Creando…' : pendingCreate.kind === 'file' ? 'Crear y abrir' : 'Crear carpeta'}</button></div>
        </form></div>
      ) : null}
      {entryMenu ? <div className="project-entry-menu" role="menu" aria-label={`Acciones de ${entryMenu.entry.name}`} style={{ left: Math.min(entryMenu.x, window.innerWidth - 220), top: Math.min(entryMenu.y, window.innerHeight - 170) }}>
        <button type="button" role="menuitem" autoFocus onClick={() => { const entry = entryMenu.entry; setEntryMenu(null); if (entry.kind === 'directory') void openDirectory(entry.id); else openFile(entry); }}>Abrir</button>
        <button type="button" role="menuitem" onClick={() => { setFileOpError(null); setPendingRename({ entry: entryMenu.entry, name: entryMenu.entry.name }); setEntryMenu(null); }}>Renombrar…</button>
        <button type="button" role="menuitem" onClick={() => { const entry = entryMenu.entry; setEntryMenu(null); const sessionId = sessionRef.current; if (sessionId) void invoke('project_reveal_entry', { sessionId, entryId: entry.id }).catch((reason) => setError(String(reason))); }}>Mostrar en el explorador del sistema</button>
        <button type="button" role="menuitem" className="danger" onClick={() => { setFileOpError(null); setPendingTrash(entryMenu.entry); setEntryMenu(null); }}>Mover a la Papelera…</button>
      </div> : null}
      {pendingRename ? (
        <div className="project-modal-layer"><form className="project-save-review project-create-review" role="dialog" aria-modal="true" aria-label={`Renombrar ${pendingRename.entry.name}`} onSubmit={(event) => { event.preventDefault(); void confirmRename(); }} onKeyDown={(event) => { if (event.key === 'Escape' && !fileOpBusy) { event.stopPropagation(); setPendingRename(null); } }}>
          <span>RENOMBRAR</span>
          <h3>{pendingRename.entry.name}</h3>
          <label><span>Nombre nuevo</span><input value={pendingRename.name} autoFocus spellCheck={false} maxLength={180} disabled={fileOpBusy} onFocus={(event) => { const dot = pendingRename.entry.kind === 'file' ? pendingRename.name.lastIndexOf('.') : -1; event.target.setSelectionRange(0, dot > 0 ? dot : pendingRename.name.length); }} onChange={(event) => { setPendingRename({ ...pendingRename, name: event.target.value }); setFileOpError(null); }} /></label>
          <p>{pendingRename.entry.kind === 'directory' ? 'La carpeta y todo su contenido conservan su sitio; solo cambia el nombre.' : 'Solo cambia el nombre del archivo, en la misma carpeta.'} Nunca se reemplazará otra entrada con ese nombre.</p>
          {fileOpError ? <div className="project-create-error" role="alert">{fileOpError}</div> : null}
          <div><button onClick={() => setPendingRename(null)} disabled={fileOpBusy} type="button">Cancelar</button><button className="primary" disabled={fileOpBusy || !pendingRename.name.trim() || pendingRename.name.trim() === pendingRename.entry.name} type="submit">{fileOpBusy ? 'Renombrando…' : 'Renombrar'}</button></div>
        </form></div>
      ) : null}
      {pendingTrash ? (
        <div className="project-modal-layer"><div className="project-save-review discard-review" role="alertdialog" aria-modal="true" aria-label={`Mover ${pendingTrash.name} a la Papelera`} onKeyDown={(event) => { if (event.key === 'Escape' && !fileOpBusy) { event.stopPropagation(); setPendingTrash(null); } }}>
          <span>PAPELERA</span><h3>¿Mover {pendingTrash.name} a la Papelera?</h3>
          <p>{pendingTrash.kind === 'directory' ? 'La carpeta irá a la Papelera del sistema con todo su contenido.' : 'El archivo irá a la Papelera del sistema.'} No se borra definitivamente: puedes recuperarlo desde la Papelera mientras no la vacíes.</p>
          {fileOpError ? <div className="project-create-error" role="alert">{fileOpError}</div> : null}
          <div><button onClick={() => setPendingTrash(null)} disabled={fileOpBusy} autoFocus type="button">Cancelar</button><button className="danger" onClick={() => void confirmTrash()} disabled={fileOpBusy} type="button">{fileOpBusy ? 'Moviendo…' : 'Mover a la Papelera'}</button></div>
        </div></div>
      ) : null}
      {pendingImport ? (
        <div className="project-modal-layer"><div className="project-save-review project-import-review" role="dialog" aria-modal="true" aria-label="Añadir archivos" onKeyDown={(event) => { if (event.key === 'Escape' && !fileOpBusy) { event.stopPropagation(); setPendingImport(null); } }}>
          <span>AÑADIR ARCHIVOS</span><h3>{pendingImport.length === 1 ? pendingImport[0].name : `${pendingImport.length} archivos`}</h3>
          <ul>{pendingImport.slice(0, 12).map((item) => <li key={`${item.name}-${item.size}`}><FileTypeIcon kind="file" name={item.name} /><span>{item.name}</span><small>{formatSize(item.size)}</small></li>)}{pendingImport.length > 12 ? <li>… y {pendingImport.length - 12} más</li> : null}</ul>
          <p>Se copiarán en <strong>{directory?.display_path}</strong>. Los originales no se tocan, y si ya existe un archivo con el mismo nombre se guardará como «nombre (2)».</p>
          {fileOpError ? <div className="project-create-error" role="alert">{fileOpError}</div> : null}
          <div><button onClick={() => setPendingImport(null)} disabled={fileOpBusy} type="button">Cancelar</button><button className="primary" onClick={() => void confirmImport()} disabled={fileOpBusy || !pendingImport.length} autoFocus type="button">{fileOpBusy ? 'Copiando…' : 'Añadir'}</button></div>
        </div></div>
      ) : null}
      {saveReview && file ? (
        <div className="project-modal-layer"><div className="project-save-review" role="dialog" aria-modal="true" aria-label="Confirmar guardado">
          <span>REVISIÓN FINAL</span><h3>¿Guardar cambios en {file.name}?</h3><p>Esprit reemplazará únicamente este archivo dentro de <strong>{file.display_path}</strong>. Si cambió en disco desde que lo abriste, el guardado se cancelará.{compileAfterSave ? ' Después compilará el principal seleccionado.' : ''}</p>
          <div><button onClick={() => { setSaveReview(false); setCompileAfterSave(false); }} disabled={saving} autoFocus type="button">Cancelar</button><button className="primary" onClick={() => void confirmSave()} disabled={saving} type="button">{saving ? 'Guardando…' : compileAfterSave ? 'Guardar y compilar' : 'Confirmar y guardar'}</button></div>
        </div></div>
      ) : null}
      {pendingImage ? (
        <div className="project-modal-layer"><div className="project-save-review image-review" role="dialog" aria-modal="true" aria-label="Confirmar inserción de imagen">
          <span>INSERTAR IMAGEN</span><h3>{pendingImage.plan.file_name}</h3><img src={`data:${pendingImage.plan.mime};base64,${pendingImage.plan.data_base64}`} alt={pendingImage.plan.alt} /><p>Se copiará en <strong>{pendingImage.plan.destination}</strong> ({formatSize(pendingImage.plan.size)}) y se insertará una referencia relativa. No se sobrescribirá ningún archivo.</p>
          <div><button onClick={cancelImage} disabled={imageBusy} autoFocus type="button">Cancelar</button><button className="primary" onClick={() => void applyImage()} disabled={imageBusy} type="button">{imageBusy ? 'Copiando…' : 'Copiar e insertar'}</button></div>
        </div></div>
      ) : null}
      {discardAction ? (
        <div className="project-modal-layer"><div className="project-save-review discard-review" role="dialog" aria-modal="true" aria-label="Cambios sin guardar">
          <span>CAMBIOS SIN GUARDAR</span><h3>¿Descartar este borrador?</h3><p>El archivo en disco no se ha modificado. Si continúas, se perderán solamente los cambios aún no guardados del editor.</p>
          <div><button onClick={() => setDiscardAction(null)} autoFocus type="button">Seguir editando</button><button className="danger" onClick={() => { const action = discardAction; setDiscardAction(null); action(); }} type="button">Descartar</button></div>
        </div></div>
      ) : null}
      <input ref={importInputRef} className="project-image-input" type="file" multiple aria-hidden="true" tabIndex={-1} onChange={(event) => { const chosen = [...(event.target.files ?? [])]; event.target.value = ''; stageImport(chosen); }} />
      <input
        ref={imageInputRef}
        className="project-image-input"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          event.target.value = '';
          if (chosen) void stageImage({ file: chosen, name: chosen.name });
        }}
      />
    </div>
  );
}
