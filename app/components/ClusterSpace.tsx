'use client';

/* Remote previews use data URLs, so Next's network image optimizer is not applicable. */
/* eslint-disable @next/next/no-img-element */

import { invoke } from '@tauri-apps/api/core';
import { CSSProperties, FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { startVisiblePolling } from '../visiblePolling';
import MarkdownEditor from './MarkdownEditor';
import ScientificEditor, { editorLanguageForFileName } from './ScientificEditor';
import SplitDivider from './SplitDivider';
import { useResizableSplit } from './useResizableSplit';

/**
 * Raíz semántica de la cuenta remota completa (`remote_home` en la
 * configuración). No puede coincidir con un slug de proyecto, que nunca
 * empieza por guion bajo. El resto de raíces son slugs de proyecto con
 * `cluster_dir`; el lado nativo resuelve cada una y valida la ruta.
 */
export const CLUSTER_HOME_ROOT = '_home';
type ClusterProject = string;
type TerminalStart = { session_id: string; root: string; cwd: string };
type TerminalResult = { output: string; cwd: string; exit_code: number };
type ClusterJob = { id: string; name: string; state: string; elapsed: string; remaining: string; cpus: string; memory: string; gres: string; reason: string; project: string | null; working_directory: string };
type ClusterNode = { name: string; partition: string; state: string; cpu_allocated: number; cpu_total: number; cpu_load: string; memory_allocated_mb: number; memory_free_mb: number; memory_total_mb: number; gpu_allocated: number; gpu_total: number; gres: string };
type ClusterSummary = { nodes_used: number; nodes_available: number; nodes_total: number; cpu_allocated: number; cpu_total: number; memory_allocated_mb: number; memory_total_mb: number; gpu_allocated: number; gpu_total: number };
type ClusterStatus = { checked_at: number; jobs: ClusterJob[]; nodes: ClusterNode[]; summary: ClusterSummary; outside_scope: number };
type ClusterEntry = { name: string; path: string; kind: 'directory' | 'file' | 'symlink' | 'other'; size: number; modified: number };
type ClusterDirectory = { root: string; path: string; entries: ClusterEntry[] };
type ClusterFile = { path: string; name: string; kind: 'text' | 'image' | 'pdf'; mime: string; content: string | null; data_base64: string | null; mtime: number; size: number };
type ClusterWriteResult = { mtime: number };
/**
 * Una sola superficie de trabajo a la vez. Archivos y editor siguen juntos
 * porque son un mismo flujo: navegar y abrir. «Recursos» solo existe con SLURM.
 */
type ClusterStage = 'files' | 'terminal' | 'resources';

const CLUSTER_STAGE_KEY = 'esprit.cluster.stage';
const isClusterStage = (value: string | null): value is ClusterStage => (
  value === 'files' || value === 'terminal' || value === 'resources'
);

const EMPTY_MARKDOWN_ASSETS: Record<string, string> = {};
const MAX_MARKDOWN_LIVE_CHARACTERS = 500_000;
const isMarkdownFile = (name: string) => /\.(?:md|markdown)$/i.test(name);

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
};

const formatMemory = (megabytes: number) => megabytes > 0 ? `${Math.round(megabytes / 1024)} GB` : '—';

const nodeStateLabel = (state: string) => {
  const value = state.toLowerCase();
  if (value.includes('idle')) return 'Libre';
  if (value.includes('mix')) return 'Uso parcial';
  if (value.includes('alloc')) return 'Asignado';
  if (value.includes('down')) return 'No disponible';
  if (value.includes('drain')) return 'Drenando';
  return state || 'Desconocido';
};

const jobStateLabel = (state: string) => {
  const labels: Record<string, string> = { RUNNING: 'Ejecutando', PENDING: 'En espera', COMPLETING: 'Terminando', CONFIGURING: 'Preparando' };
  return labels[state] ?? state;
};

const fileBadge = (name: string, kind: ClusterEntry['kind']) => {
  if (kind === 'directory') return 'DIR';
  const extension = name.split('.').pop()?.toLowerCase();
  if (extension === 'pdf') return 'PDF';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff'].includes(extension ?? '')) return 'IMG';
  return 'TXT';
};

type ClusterSpaceProps = {
  /** Nombre visible del clúster en la configuración. */
  label: string;
  scheduler: 'slurm' | 'none';
  hasJupyter: boolean;
  /** Proyectos con `cluster_dir`, en el orden de la configuración. */
  projects: Array<{ slug: string; label: string }>;
  onOpenJupyter: () => void;
  active?: boolean;
};

export default function ClusterSpace({ label, scheduler, hasJupyter, projects, onOpenJupyter, active = true }: ClusterSpaceProps) {
  const slurm = scheduler === 'slurm';
  const homeLabel = `Todo ${label}`;
  const projectOptions: Array<{ slug: ClusterProject; label: string }> = [
    { slug: CLUSTER_HOME_ROOT, label: homeLabel },
    ...projects,
  ];
  const clusterStages: Array<{ id: ClusterStage; label: string }> = [
    { id: 'files', label: 'Archivos y editor' },
    { id: 'terminal', label: 'Terminal' },
    ...(slurm ? [{ id: 'resources' as const, label: 'Recursos' }] : []),
  ];
  const [project, setProject] = useState<ClusterProject | ''>('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [terminalOutput, setTerminalOutput] = useState('Esprit no se conecta hasta que selecciones una carpeta o atajo.\nEl destino siempre es el alias SSH de la configuración.\n');
  const [terminalCommand, setTerminalCommand] = useState('');
  const [terminalCwd, setTerminalCwd] = useState('');
  const [terminalRunning, setTerminalRunning] = useState(false);
  const [storedStage, setActiveStage] = useState<ClusterStage>(() => {
    if (typeof window === 'undefined') return 'files';
    const stored = window.localStorage.getItem(CLUSTER_STAGE_KEY);
    return isClusterStage(stored) ? stored : 'files';
  });
  const activeStage: ClusterStage = storedStage === 'resources' && !slurm ? 'files' : storedStage;
  const filesSplit = useResizableSplit({
    collapsible: true,
    storageKey: 'esprit.cluster.files-split',
    defaultValue: 38,
    min: 22,
    max: 68,
  });
  const [clusterStatus, setClusterStatus] = useState<ClusterStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusPaused, setStatusPaused] = useState(false);
  const [directory, setDirectory] = useState<ClusterDirectory | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [remoteFile, setRemoteFile] = useState<ClusterFile | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [markdownMode, setMarkdownMode] = useState<'live' | 'source'>('live');
  const [fileLoading, setFileLoading] = useState(false);
  const [fileSaving, setFileSaving] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [homeRoot, setHomeRoot] = useState<string | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);

  const sessionRef = useRef<string | null>(null);
  const projectRef = useRef<ClusterProject | ''>('');
  const directoryRef = useRef<ClusterDirectory | null>(null);
  const directoryLoadingRef = useRef(false);

  const dirty = remoteFile?.kind === 'text' && editorContent !== savedContent;
  const remoteMarkdown = Boolean(remoteFile?.kind === 'text' && isMarkdownFile(remoteFile.name));
  const markdownLivePaused = remoteMarkdown && editorContent.length > MAX_MARKDOWN_LIVE_CHARACTERS;
  const effectiveMarkdownMode = markdownLivePaused ? 'source' : markdownMode;
  const previewSource = remoteFile?.data_base64 ? `data:${remoteFile.mime};base64,${remoteFile.data_base64}` : '';

  useEffect(() => { projectRef.current = project; }, [project]);
  useEffect(() => { sessionRef.current = sessionId; }, [sessionId]);
  useEffect(() => { directoryRef.current = directory; }, [directory]);

  useEffect(() => {
    return () => {
      const activeSession = sessionRef.current;
      if (activeSession) void invoke('cluster_terminal_stop', { sessionId: activeSession });
    };
  }, []);
  useEffect(() => { outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight }); }, [terminalOutput]);

  const refreshStatus = useCallback(async (selectedProject?: ClusterProject) => {
    const activeProject = selectedProject ?? projectRef.current;
    if (!slurm || !activeProject || statusLoading) return false;
    setStatusLoading(true);
    try {
      const status = await invoke<ClusterStatus>('cluster_status', { project: activeProject });
      setClusterStatus(status);
      setStatusPaused(false);
      setConnectionError(null);
      return true;
    } catch (error) {
      setStatusPaused(true);
      setConnectionError(String(error));
      return false;
    } finally {
      setStatusLoading(false);
    }
  }, [slurm, statusLoading]);

  const loadDirectory = useCallback(async (selectedProject: ClusterProject, path?: string, quiet = false) => {
    if (directoryLoadingRef.current) return false;
    directoryLoadingRef.current = true;
    if (!quiet) setDirectoryLoading(true);
    setWorkspaceError(null);
    try {
      const result = await invoke<ClusterDirectory>('cluster_list', { project: selectedProject, path: path ?? null });
      setDirectory(result);
      directoryRef.current = result;
      setStatusPaused(false);
      setConnectionError(null);
      return true;
    } catch (error) {
      setStatusPaused(true);
      setWorkspaceError(String(error));
      return false;
    } finally {
      directoryLoadingRef.current = false;
      if (!quiet) setDirectoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!slurm || !active || !connected || statusPaused) return undefined;
    return startVisiblePolling(() => void refreshStatus(), 60_000, { runImmediately: false });
  }, [slurm, active, connected, refreshStatus, statusPaused]);

  useEffect(() => {
    if (!active || !connected || statusPaused || !project) return undefined;
    return startVisiblePolling(() => {
      const currentDirectory = directoryRef.current;
      if (currentDirectory) void loadDirectory(project, currentDirectory.path, true);
    }, 30_000, { runImmediately: false });
  }, [active, connected, loadDirectory, project, statusPaused]);

  const connect = async () => {
    if (!project || connecting) return;
    if (!('__TAURI_INTERNALS__' in window)) {
      setConnectionError(`${label} funciona dentro de Esprit.app.`);
      return;
    }
    setConnecting(true);
    setConnectionError(null);
    setWorkspaceError(null);
    setTerminalOutput((current) => `${current}\nValidando alias y raíz seleccionada…\n`);
    try {
      const started = await invoke<TerminalStart>('cluster_terminal_start', { project });
      setSessionId(started.session_id);
      sessionRef.current = started.session_id;
      setTerminalCwd(started.cwd);
      if (project === CLUSTER_HOME_ROOT) setHomeRoot(started.root);
      setConnected(true);
      setStatusPaused(false);
      setTerminalOutput((current) => `${current}Sesión preparada en ${started.root}.\n`);
      const statusReady = slurm ? await refreshStatus(project) : true;
      if (statusReady) await loadDirectory(project, started.root);
    } catch (error) {
      setConnected(false);
      setSessionId(null);
      sessionRef.current = null;
      setStatusPaused(true);
      setConnectionError(String(error));
      setTerminalOutput((current) => `${current}Conexión detenida: ${String(error)}\n`);
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    const activeSession = sessionRef.current;
    if (activeSession) {
      try { await invoke('cluster_terminal_stop', { sessionId: activeSession }); } catch { /* Local context may already be gone. */ }
    }
    setConnected(false);
    setSessionId(null);
    sessionRef.current = null;
    setTerminalCwd('');
    setStatusPaused(true);
    setTerminalOutput((current) => `${current}\nSesión cerrada.\n`);
  };

  const selectedProject = projectOptions.find((option) => option.slug === project);
  // La carpeta personal remota solo se conoce después de conectar con la raíz
  // completa; hasta entonces se muestra la ruta tal cual.
  const shortenRemotePath = (path: string) => (homeRoot && (path === homeRoot || path.startsWith(`${homeRoot}/`)) ? `~${path.slice(homeRoot.length)}` : path);
  const terminalPrompt = terminalCwd && selectedProject ? `${shortenRemotePath(terminalCwd)} $` : `${label.toLocaleLowerCase('es')} $`;

  const submitTerminal = async (event: FormEvent) => {
    event.preventDefault();
    const command = terminalCommand.trim();
    if (!command || !sessionId || terminalRunning) return;
    setTerminalCommand('');
    setTerminalRunning(true);
    setTerminalOutput((current) => `${current}\n${terminalPrompt} ${command}\n`);
    try {
      const result = await invoke<TerminalResult>('cluster_terminal_write', { sessionId, input: command });
      setTerminalCwd(result.cwd);
      const response = result.output ? `${result.output}\n` : '';
      const status = result.exit_code === 0 ? '' : `[salida ${result.exit_code}]\n`;
      setTerminalOutput((current) => `${current}${response}${status}`.slice(-160_000));
    } catch (error) {
      setConnectionError(String(error));
      setStatusPaused(true);
      setTerminalOutput((current) => `${current}Sesión detenida: ${String(error)}\n`);
      await disconnect();
    } finally {
      setTerminalRunning(false);
    }
  };

  // Igual que en Proyectos: los enlaces de una nota remota salen por el
  // puente validado, no por el WebView.
  const openDocumentLink = useCallback((url: string) => {
    void invoke<string>('document_open_link', { url })
      .then(() => setWorkspaceError(null))
      .catch((reason) => setWorkspaceError(String(reason)));
  }, []);

  const selectStage = (stage: ClusterStage) => {
    setActiveStage(stage);
    window.localStorage.setItem(CLUSTER_STAGE_KEY, stage);
  };

  // Titular de la cola: lo que se lee de un vistazo sin abrir nada.
  const queueHeadline = (() => {
    if (!connected) return 'Sin verificar';
    if (connectionError) return 'Sin lectura';
    if (!clusterStatus) return 'Consultando…';
    const jobs = clusterStatus.jobs;
    if (jobs.length === 0) return 'Nada en cola';
    const running = jobs.filter((job) => job.state.toUpperCase().startsWith('R')).length;
    const waiting = jobs.length - running;
    const parts = [];
    if (running) parts.push(`${running} en ejecución`);
    if (waiting) parts.push(`${waiting} esperando`);
    return parts.join(' · ');
  })();

  const openEntry = async (entry: ClusterEntry) => {
    if (!project || dirty) {
      if (dirty) setWorkspaceError('Hay cambios sin guardar. Guarda o descarta antes de abrir otro archivo.');
      return;
    }
    if (entry.kind === 'directory') {
      await loadDirectory(project, entry.path);
      return;
    }
    if (entry.kind !== 'file') return;
    setFileLoading(true);
    setWorkspaceError(null);
    try {
      const file = await invoke<ClusterFile>('cluster_read_file', { project, path: entry.path });
      setRemoteFile(file);
      setEditorContent(file.content ?? '');
      setSavedContent(file.content ?? '');
    } catch (error) {
      setWorkspaceError(String(error));
    } finally {
      setFileLoading(false);
    }
  };

  const goUp = async () => {
    if (!project || !directory || directory.path === directory.root || dirty) {
      if (dirty) setWorkspaceError('Hay cambios sin guardar. Guarda o descarta antes de cambiar de carpeta.');
      return;
    }
    const parent = directory.path.slice(0, directory.path.lastIndexOf('/')) || directory.root;
    await loadDirectory(project, parent.startsWith(directory.root) ? parent : directory.root);
  };

  const saveFile = useCallback(async () => {
    if (!projectRef.current || !remoteFile || remoteFile.kind !== 'text' || !dirty || fileSaving) return;
    setFileSaving(true);
    setWorkspaceError(null);
    try {
      const result = await invoke<ClusterWriteResult>('cluster_write_file', { request: { project: projectRef.current, path: remoteFile.path, content: editorContent, expected_mtime: remoteFile.mtime } });
      setRemoteFile((current) => current ? { ...current, mtime: result.mtime, size: new TextEncoder().encode(editorContent).length } : current);
      setSavedContent(editorContent);
    } catch (error) {
      setWorkspaceError(String(error));
    } finally {
      setFileSaving(false);
    }
  }, [dirty, editorContent, fileSaving, remoteFile]);


  const summary = clusterStatus?.summary;

  return (
    <div className={`cluster-space${slurm ? '' : ' no-queue'}`}>
      <div className="cluster-toolbar">
        <div className="cluster-project-picker"><span>CARPETA</span><select value={project} onChange={(event) => setProject(event.target.value)} disabled={connected || connecting}><option value="">Selecciona antes de conectar</option><optgroup label="Cuenta completa"><option value={CLUSTER_HOME_ROOT}>{homeLabel} · ~</option></optgroup>{projects.length ? <optgroup label="Atajos de proyecto">{projects.map((option) => <option key={option.slug} value={option.slug}>{option.label}</option>)}</optgroup> : null}</select></div>
        <div className="cluster-connection-state"><i className={connected ? 'online' : connectionError ? 'error' : ''} /><div><strong>{connected ? 'Conectado' : connecting ? 'Verificando…' : 'Desconectado'}</strong><span>SSH · alias de la configuración</span></div></div>
        <button className="cluster-connect" onClick={() => void (connected ? disconnect() : connect())} disabled={connecting || (!connected && !project)} type="button">{connected ? 'Desconectar' : connecting ? 'Conectando…' : 'Conectar'}</button>
        {hasJupyter ? <button className="cluster-jupyter" onClick={onOpenJupyter} type="button">JupyterLab <span>↗</span></button> : null}
      </div>

      {/* La cola no vive en una pestaña: es lo que se consulta de un vistazo,
          así que permanece visible con cualquier superficie activa. */}
      {slurm ? <section className="cluster-queue" aria-label="Cola de trabajos">
        <header>
          <div><span>{project === CLUSTER_HOME_ROOT ? 'MIS TRABAJOS · TODOS' : 'TRABAJOS DEL PROYECTO'}</span><strong>{queueHeadline}</strong></div>
          <div>
            <small>{clusterStatus ? `Actualizado ${new Date(clusterStatus.checked_at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}` : 'Sin lectura todavía'}</small>
            <button onClick={() => void refreshStatus()} disabled={!connected || statusLoading} type="button" aria-label="Actualizar estado SLURM">{statusLoading ? '…' : '↻'}</button>
          </div>
        </header>
        <div className="cluster-queue-strip">
          {!connected ? <p className="cluster-queue-note">La cola se consulta después de verificar la raíz elegida.</p> : null}
          {connected && connectionError ? <p className="cluster-queue-note error">{connectionError}</p> : null}
          {connected && !connectionError && !clusterStatus ? <p className="cluster-queue-note">Consultando SLURM…</p> : null}
          {connected && !connectionError && clusterStatus?.jobs.length === 0 ? <p className="cluster-queue-note ok">No hay trabajos en cola en este ámbito.</p> : null}
          {connected && !connectionError ? clusterStatus?.jobs.map((job) => (
            <article className="cluster-queue-job" key={job.id}>
              <div><span className={job.state.toLowerCase()}>{jobStateLabel(job.state)}</span><b>{job.id}</b></div>
              <h4>{job.name}</h4><small>{projectOptions.find(option => option.slug === job.project)?.label ?? 'Proyecto sin asociar'}</small>
              <p>{job.elapsed} · límite restante {job.remaining}</p>
              <p>{job.cpus} CPU · {job.memory || 'RAM —'}{job.gres && job.gres !== '(null)' ? ` · ${job.gres}` : ''}</p>
              <small title={job.reason}>{job.reason}</small>
            </article>
          )) : null}
        </div>
        {clusterStatus && clusterStatus.outside_scope > 0 ? <p className="cluster-queue-note">{clusterStatus.outside_scope} trabajos fuera de esta carpeta; se ven en «{homeLabel}».</p> : null}
      </section> : null}

      <div className="cluster-tabs" role="tablist" aria-label="Superficie del clúster">
        {clusterStages.map((stage) => (
          <button
            className={activeStage === stage.id ? 'active' : ''}
            onClick={() => selectStage(stage.id)}
            type="button"
            role="tab"
            aria-selected={activeStage === stage.id}
            key={stage.id}
          >
            {stage.label}
          </button>
        ))}
      </div>

      <div className="cluster-stage">
        {activeStage === 'files' ? (
          <div className="cluster-files-stage" style={{ '--cluster-files-track': filesSplit.track(220) } as CSSProperties}>
          <section className="cluster-files-panel">
            <header><div><span>ARCHIVOS REMOTOS</span><h3>{directory ? shortenRemotePath(directory.path) : selectedProject?.label ?? 'Sin carpeta'}</h3></div><div><button onClick={() => void goUp()} disabled={!directory || directory.path === directory.root || directoryLoading} type="button">↑ Subir</button><button onClick={() => project && void loadDirectory(project, directory?.path)} disabled={!connected || directoryLoading} type="button">{directoryLoading ? '…' : '↻'}</button></div></header>
            <div className="cluster-file-list">{!connected ? <div className="cluster-panel-empty"><i />Elige «{homeLabel}» para navegar por cualquier carpeta de tu carpeta personal remota.</div> : null}{connected && directoryLoading && !directory ? <div className="cluster-panel-empty">Leyendo carpeta…</div> : null}{connected && !directoryLoading && directory?.entries.length === 0 ? <div className="cluster-panel-empty">Esta carpeta está vacía.</div> : null}{connected && directory?.entries.map((entry) => <button className={remoteFile?.path === entry.path ? 'active' : ''} onClick={() => void openEntry(entry)} disabled={entry.kind === 'symlink' || entry.kind === 'other'} key={entry.path} type="button" aria-current={remoteFile?.path === entry.path ? 'true' : undefined}><i className={entry.kind}>{fileBadge(entry.name, entry.kind)}</i><div><strong>{entry.name}</strong><span>{entry.kind === 'directory' ? 'Carpeta' : entry.kind === 'symlink' ? 'Enlace no navegable' : formatSize(entry.size)}</span></div><time>{entry.modified ? new Date(entry.modified * 1000).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' }) : ''}</time></button>)}</div>
          </section>

            <SplitDivider split={filesSplit} className="cluster-top-resizer" label="Cambiar ancho entre archivos y editor" paneLabel="el explorador" />

          <section className="cluster-editor-panel">
            <header><div><span>EDITOR / VISOR REMOTO</span><h3>{remoteFile?.name ?? 'Abre texto, PDF o imagen'}</h3></div><div className="editor-actions">{remoteMarkdown ? <div className="project-view-toggle"><button className={effectiveMarkdownMode === 'live' ? 'active' : ''} onClick={() => setMarkdownMode('live')} disabled={markdownLivePaused} title={markdownLivePaused ? 'Vista viva pausada en documentos de más de 500.000 caracteres' : 'Edición visual'} type="button">Escribir</button><button className={effectiveMarkdownMode === 'source' ? 'active' : ''} onClick={() => setMarkdownMode('source')} type="button">Fuente</button></div> : null}{dirty ? <button onClick={() => { setEditorContent(savedContent); setWorkspaceError(null); }} type="button">Descartar</button> : null}{remoteFile?.kind === 'text' ? <button className="save" onClick={() => void saveFile()} disabled={!dirty || fileSaving} type="button">{fileSaving ? 'Guardando…' : 'Guardar ⌘S'}</button> : null}</div></header>
            {fileLoading ? <div className="cluster-panel-empty">Abriendo archivo…</div> : null}
            {!fileLoading && !remoteFile ? <div className="cluster-editor-empty"><span>VIEW</span><h3>Editor y visualizador.</h3><p>Selecciona un archivo. El texto se puede editar; PDF, PNG, JPG y otros formatos de imagen se muestran aquí sin modificar el original.</p></div> : null}
            {!fileLoading && remoteFile?.kind === 'text' && remoteMarkdown ? <MarkdownEditor key={remoteFile.path} value={editorContent} mode={effectiveMarkdownMode} assets={EMPTY_MARKDOWN_ASSETS} disabled={fileSaving} onOpenLink={openDocumentLink} onChange={setEditorContent} onRequestSave={() => { if (dirty) void saveFile(); }} imageEnabled={false} livePreviewPaused={markdownLivePaused} /> : null}
            {!fileLoading && remoteFile?.kind === 'text' && !remoteMarkdown ? <div className="cluster-code"><ScientificEditor key={remoteFile.path} value={editorContent} language={editorLanguageForFileName(remoteFile.name)} disabled={fileSaving} ariaLabel={`Editando ${remoteFile.name}`} onChange={setEditorContent} onRequestSave={() => { if (dirty) void saveFile(); }} /></div> : null}
            {!fileLoading && remoteFile?.kind === 'image' && previewSource ? <div className="cluster-preview image"><img src={previewSource} alt={`Vista previa de ${remoteFile.name}`} /></div> : null}
            {!fileLoading && remoteFile?.kind === 'pdf' && previewSource ? <div className="cluster-preview pdf"><iframe src={previewSource} title={`Vista previa de ${remoteFile.name}`} /></div> : null}
            <footer><span>{remoteFile ? `${remoteFile.path} · ${formatSize(remoteFile.size)}` : 'TEXTO 1 MB · PDF/IMAGEN 20 MB'}</span><b className={dirty ? 'dirty' : ''}>{dirty ? 'CAMBIOS SIN GUARDAR' : remoteFile?.kind === 'text' ? 'GUARDADO' : remoteFile ? 'SOLO LECTURA' : ''}</b></footer>
          </section>
          </div>
        ) : null}

        {activeStage === 'terminal' ? (
          <section className="cluster-terminal-panel">
            <header><div><span>TERMINAL REMOTA</span><h3>{selectedProject?.label ?? label}</h3></div><div className="terminal-actions"><button onClick={() => setTerminalOutput('')} type="button">Limpiar</button>{connected ? <button onClick={() => void disconnect()} type="button">Cerrar sesión</button> : null}</div></header>
            <pre ref={outputRef}>{terminalOutput}</pre>
            <form onSubmit={(event) => void submitTerminal(event)}><span>{terminalPrompt}</span><input value={terminalCommand} onChange={(event) => setTerminalCommand(event.target.value)} disabled={!connected || terminalRunning} placeholder={terminalRunning ? 'Ejecutando…' : connected ? 'Escribe un comando…' : 'Selecciona carpeta y conecta'} autoComplete="off" spellCheck={false} /><button disabled={!connected || terminalRunning || !terminalCommand.trim()} type="submit">{terminalRunning ? '…' : 'Ejecutar ↵'}</button></form>
          </section>
        ) : null}

        {slurm && activeStage === 'resources' ? (
          <aside className="cluster-status-panel">
            <header><div><strong>Recursos del clúster</strong></div></header>
            <div className="cluster-status-scroll">
              {!connected ? <div className="cluster-panel-empty"><i />El estado se consulta después de verificar la raíz elegida.</div> : null}
              {connected && connectionError ? <div className="cluster-panel-empty error">{connectionError}<button onClick={() => { setStatusPaused(false); void refreshStatus(); }} type="button">Reintentar manualmente</button></div> : null}
              {connected && !connectionError && summary ? <div className="cluster-resource-summary"><article><span>NODOS EN USO</span><strong>{summary.nodes_used}<small> / {summary.nodes_total}</small></strong><p>{summary.nodes_available} disponibles</p></article><article><span>CPU ASIGNADAS</span><strong>{summary.cpu_allocated}<small> / {summary.cpu_total}</small></strong><p>{Math.max(0, summary.cpu_total - summary.cpu_allocated)} libres</p></article><article><span>GPU ASIGNADAS</span><strong>{summary.gpu_allocated}<small> / {summary.gpu_total}</small></strong><p>{Math.max(0, summary.gpu_total - summary.gpu_allocated)} libres</p></article><article><span>RAM ASIGNADA</span><strong>{formatMemory(summary.memory_allocated_mb)}<small> / {formatMemory(summary.memory_total_mb)}</small></strong></article></div> : null}
              {connected && !connectionError ? clusterStatus?.nodes.map((node) => <article className="cluster-node" key={node.name}><div><h4>{node.name}</h4><span className={node.state.toLowerCase()}>{nodeStateLabel(node.state)}</span></div><p>{node.partition}</p><dl><div><dt>CPU</dt><dd>{node.cpu_allocated} usadas · {Math.max(0, node.cpu_total - node.cpu_allocated)} libres / {node.cpu_total}</dd></div><div><dt>Carga CPU</dt><dd>{node.cpu_load}</dd></div><div><dt>RAM</dt><dd>{formatMemory(node.memory_allocated_mb)} asignada · {formatMemory(node.memory_free_mb)} libre / {formatMemory(node.memory_total_mb)}</dd></div><div><dt>GPU</dt><dd>{node.gpu_allocated} usadas · {Math.max(0, node.gpu_total - node.gpu_allocated)} libres / {node.gpu_total}</dd></div>{node.gres && node.gres !== '(null)' ? <div><dt>Tipo GPU</dt><dd>{node.gres}</dd></div> : null}</dl></article>) : null}
            </div>
            <footer>{clusterStatus ? `Actualizado ${new Date(clusterStatus.checked_at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}` : 'Lectura SLURM explicada'}</footer>
          </aside>
        ) : null}
      </div>

      {(connectionError || workspaceError) ? <div className="cluster-error" role="status">{workspaceError || connectionError}</div> : null}
    </div>
  );
}
