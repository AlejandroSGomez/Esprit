'use client';

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { MattermostAttachment } from './MattermostSpace';
import './workspaceRefinements.css';

type Directory = {session_id: string; directory_id: string; parent_id: string | null; display_path: string; entries: {id: string; name: string; kind: string; sensitive: boolean}[]};
type Saved = {name: string; relative_path: string; display_path: string; size: number};

export default function ProjectAttachmentDownload({file, projects, onClose, onOpen}: {
  file: MattermostAttachment;
  projects: {slug: string; name: string}[];
  onClose: () => void;
  onOpen: (project: string, relativePath: string) => void;
}) {
  const [project, setProject] = useState(projects[0]?.slug ?? '');
  const [name, setName] = useState(file.name.split(/[\\/]/).pop() ?? file.name);
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [loading, setLoading] = useState(Boolean(projects.length)), [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null), [saved, setSaved] = useState<Saved | null>(null);
  const request = useRef(0), session = useRef<string | null>(null), inFlight = useRef(false);
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    request.current++;
    void invoke<Directory>('project_browser_start', {project}).then(result => {
      if (cancelled) { void invoke('project_browser_stop', {sessionId: result.session_id}); return; }
      session.current = result.session_id; setDirectory(result);
    }).catch(reason => { if (!cancelled) setError(String(reason)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      const id = session.current; session.current = null;
      if (id) void invoke('project_browser_stop', {sessionId:id}).catch(() => undefined);
    };
  }, [project]);
  const navigate = async (id: string) => {
    if (!directory || loading || saving) return;
    const sequence = ++request.current;
    setLoading(true); setError(null);
    try { const next = await invoke<Directory>('project_list', {sessionId: directory.session_id, directoryId:id}); if (sequence === request.current) setDirectory(next); }
    catch (reason) { if (sequence === request.current) setError(String(reason)); }
    finally { if (sequence === request.current) setLoading(false); }
  };
  const download = async () => {
    if (!directory || loading || inFlight.current) return;
    inFlight.current = true; setSaving(true); setError(null);
    try { setSaved(await invoke<Saved>('mattermost_download_to_project', {request: {file_id: file.id, session_id: directory.session_id, directory_id:directory.directory_id, name, confirmed:true}})); }
    catch (reason) { setError(String(reason)); }
    finally { inFlight.current = false; setSaving(false); }
  };
  return <div className="mm-review-layer" onKeyDown={event => { if (event.key === 'Escape') {event.preventDefault();event.stopPropagation(); if (!saving) onClose();} }}>
    <section className="project-download-dialog" role="dialog" aria-modal="true" aria-label="Guardar adjunto en proyecto" aria-busy={saving}>
      <header><h3>{saved ? 'Adjunto guardado' : 'Guardar en proyecto'}</h3><p>{file.name} · {Math.ceil(file.size / 1024)} KB</p></header>
      {saved ? <p role="status">Guardado en <strong>{saved.display_path}</strong></p> : <>
        <label>Proyecto<select autoFocus value={project} disabled={saving} onChange={event => {setLoading(true); setDirectory(null); setError(null); setProject(event.target.value);}}>{projects.map(item => <option key={item.slug} value={item.slug}>{item.name}</option>)}</select></label>
        <div className="project-download-folder"><strong>{directory?.display_path ?? 'Abriendo proyecto…'}</strong>{directory?.parent_id ? <button type="button" disabled={loading || saving} onClick={() => void navigate(directory.parent_id!)}>↑ Subir</button> : null}</div>
        <div className="project-download-folders" aria-label="Carpetas de destino">{directory?.entries.filter(entry => entry.kind === 'directory' && !entry.sensitive && !entry.name.startsWith('.')).map(entry => <button type="button" disabled={loading || saving} key={entry.id} onClick={() => void navigate(entry.id)}>▸ {entry.name}</button>)}{loading ? <p role="status">Cargando carpetas…</p> : null}</div>
        <label>Nombre del archivo<input value={name} disabled={saving} maxLength={180} onChange={event => setName(event.target.value)} /></label>
        <p>Destino: <strong>{directory?.display_path}/{name}</strong>. Se guardará una copia sin reemplazar archivos existentes. Hasta 25 MB.</p>
      </>}
      {error ? <p role="alert">{error}</p> : null}
      <footer><button type="button" disabled={saving} onClick={onClose}>{saved ? 'Cerrar' : 'Cancelar'}</button>{saved ? <button type="button" className="primary" onClick={() => onOpen(project, saved.relative_path)}>Abrir en Proyectos</button> : <button type="button" className="primary" disabled={loading || saving || !directory || !name.trim() || file.size > 25 * 1024 ** 2} onClick={() => void download()}>{saving ? 'Descargando…' : 'Confirmar y descargar'}</button>}</footer>
    </section>
  </div>;
}
