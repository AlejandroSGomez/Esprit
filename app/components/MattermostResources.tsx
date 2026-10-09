'use client';

import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { MattermostAttachment, MattermostPost } from './MattermostSpace';

type ResourcePost = MattermostPost & { links: string[] };
type Page = { posts: ResourcePost[]; next_cursor: string | null; scanned_count: number };
type Item = { key: string; post: ResourcePost; file?: MattermostAttachment; url?: string; label: string };

export default function MattermostResources({ channelId, onOpenFile, onOpenLink, onOpenPost, onDownloadFile }: {
  channelId: string;
  onOpenFile: (file: MattermostAttachment) => void;
  onOpenLink: (url: string) => void;
  onOpenPost: (post: MattermostPost) => void;
  onDownloadFile?: (file: MattermostAttachment) => void;
}) {
  const [posts, setPosts] = useState<ResourcePost[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false), [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loading = !paused && !done;
  const [attempt, setAttempt] = useState(0), [scanned, setScanned] = useState(0);
  const [filter, setFilter] = useState<'all' | 'files' | 'links'>('all');
  const [query, setQuery] = useState(''), [visible, setVisible] = useState(100);

  useEffect(() => {
    if (paused || done) return;
    let cancelled = false;
    void invoke<Page>('mattermost_workspace_read', { request: { operation: 'resources', channel_id: channelId, cursor } }).then(page => {
      if (cancelled) return;
      if (page.next_cursor && page.next_cursor === cursor) throw new Error('El historial no avanzó. Actualiza para volver a intentarlo.');
      setPosts(current => [...new Map([...current, ...page.posts].map(post => [post.id, post])).values()]);
      setScanned(current => current + page.scanned_count);
      setCursor(page.next_cursor); setDone(!page.next_cursor);
    }).catch(reason => {
      if (!cancelled) { setError(String(reason)); setPaused(true); }
    });
    return () => { cancelled = true; };
  }, [channelId, cursor, paused, done, attempt]);

  const items = useMemo(() => posts.flatMap(post => [
    ...post.attachments.map(file => ({ key: `${post.id}:file:${file.id}`, post, file, label: file.name })),
    ...post.links.map(url => ({ key: `${post.id}:link:${url}`, post, url, label: url })),
  ] as Item[]), [posts]);
  const files = items.filter(item => item.file).length;
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return items.filter(item => (filter === 'all' || (filter === 'files' ? item.file : item.url))
      && (!term || `${item.label} ${item.post.username} ${item.post.message}`.toLocaleLowerCase().includes(term)));
  }, [items, filter, query]);

  const refresh = () => {
    setPosts([]); setCursor(null); setDone(false); setPaused(false); setError(null);
    setScanned(0); setVisible(100); setAttempt(value => value + 1);
  };
  return <section className="mm-resources" aria-label="Adjuntos y enlaces del canal">
    <div className="mm-resources-tools">
      <div className="mm-resource-filters" role="group" aria-label="Tipo de recurso">
        {([['all', 'Todos', items.length], ['files', 'Adjuntos', files], ['links', 'Enlaces', items.length - files]] as const).map(([value, label, count]) =>
          <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); setVisible(100); }}>{label} <span>{count}</span></button>)}
      </div>
      <input aria-label="Buscar adjuntos y enlaces" placeholder="Buscar por nombre, enlace o autor…" value={query} onChange={event => { setQuery(event.target.value); setVisible(100); }} />
      <div className="mm-resource-progress"><span role="status">{done ? 'Historial completo revisado' : paused ? 'Revisión pausada · lista parcial' : 'Revisando el historial…'} · {scanned} mensajes</span>
        {!done ? <button type="button" onClick={() => { setPaused(value => !value); setError(null); }}>{paused ? 'Continuar' : 'Pausar'}</button> : null}
        <button type="button" onClick={refresh}>Actualizar recursos</button>
      </div>
      {error ? <p role="alert" className="mm-banner">{error}</p> : null}
      {query && !done ? <small>La búsqueda incluye los recursos encontrados hasta ahora.</small> : null}
    </div>
    <div className="mm-resource-list">
      {!filtered.length ? <p className="mm-state">{loading && !paused ? 'Buscando adjuntos y enlaces…' : done ? 'No hay recursos que coincidan.' : 'Todavía no se han encontrado recursos que coincidan.'}</p> : null}
      {filtered.slice(0, visible).map(item => <article key={item.key} className="mm-resource-row">
        <span className="mm-resource-kind" aria-hidden="true">{item.file ? item.file.extension.toUpperCase().slice(0, 5) || 'FILE' : '↗'}</span>
        <div><button className="mm-resource-open" type="button" onClick={() => item.file ? onOpenFile(item.file) : onOpenLink(item.url!)}>{item.label}</button>{item.file && onDownloadFile ? <button className="mm-resource-download" type="button" onClick={() => onDownloadFile(item.file!)}>Guardar en proyecto ↓</button> : null}
          <p>@{item.post.username} · {item.post.created_local}{item.file?.size ? ` · ${Math.ceil(item.file.size / 1024)} KB` : ''}{item.post.root_id ? ' · respuesta de thread' : ''}</p>
        </div><button className="mm-resource-origin" type="button" onClick={() => onOpenPost(item.post)}>Ver mensaje</button>
      </article>)}
      {filtered.length > visible ? <button className="mm-load-history" type="button" onClick={() => setVisible(value => value + 100)}>Mostrar más recursos ({filtered.length - visible})</button> : null}
    </div>
  </section>;
}
