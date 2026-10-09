'use client';
import { getAppTimeZone } from '../appConfig';
/* eslint-disable @next/next/no-img-element -- authenticated native data URLs */
import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import RichText from './RichText';
import MattermostResources from './MattermostResources';
import ProjectAttachmentDownload from './ProjectAttachmentDownload';
import MattermostInlineImage from './MattermostInlineImage';
import MattermostComposer from './MattermostComposer';
import SplitDivider from './SplitDivider';
import { useResizableSplit } from './useResizableSplit';
import EmojiPicker from './EmojiPicker';
import { registerScreen } from '../screenContext';
import { customShortcodes, EmojiOption, normalizeEmojiAliases } from './emojiHelpers';
import { startVisiblePolling } from '../visiblePolling';
import { mattermostPresentation } from '../mattermostPresentation';
import './MattermostSpace.css';
export type MMReaction = { name: string; count: number; own: boolean };
export type MattermostChannel = {
  id: string;
  name: string;
  label: string;
  type: 'O' | 'P' | 'D';
  registry_slug?: string | null;
  last_post_at: number;
  unread_messages: number;
  mentions: number;
  badge: number;
  restricted: boolean;
  counterpart_user_id?: string | null;
};

export type MattermostOverview = {
  connected: boolean;
  server: string;
  team: string;
  identity: string;
  checked_at: number;
  notification_count: number;
  channels: MattermostChannel[];
  categories?: Array<{ id: string; label: string; collapsed: boolean; channel_ids: string[] }>;
  statuses?: Record<string, string>;
};

export type MattermostAttachment = {
  id: string;
  name: string;
  extension: string;
  mime_type: string;
  size: number;
};

export type MattermostPost = {
  id: string;
  channel_id: string;
  root_id?: string;
  user_id: string;
  username: string;
  created_local?: string;
  create_at: number;
  update_at: number;
  edit_at: number;
  delete_at: number;
  revision: number;
  edited: boolean;
  is_own: boolean;
  message: string;
  attachments: MattermostAttachment[];
  reply_count?: number;
  unread_replies?: number;
  reactions?: MMReaction[];
};

const madridDayKey = (timestamp: number) => new Date(timestamp).toLocaleDateString('en-CA', { timeZone: getAppTimeZone() });
const madridClock = (timestamp: number) => new Date(timestamp).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: getAppTimeZone() });
const dayLabel = (timestamp: number) => {
  const key = madridDayKey(timestamp);
  const today = madridDayKey(Date.now());
  if (key === today) return 'Hoy';
  if (key === madridDayKey(Date.now() - 86_400_000)) return 'Ayer';
  const label = new Date(timestamp).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: getAppTimeZone() });
  return label.charAt(0).toLocaleUpperCase('es') + label.slice(1);
};
/** Mattermost folds a post into the previous one by the same author within five minutes. */
const continuesPrevious = (post: MattermostPost, previous?: MattermostPost) => Boolean(previous
  && previous.user_id === post.user_id
  && previous.channel_id === post.channel_id
  && madridDayKey(previous.create_at) === madridDayKey(post.create_at)
  && Math.abs(post.create_at - previous.create_at) < 5 * 60_000);

export type MattermostChannelData = {
  channel: { id: string; label: string; type: string; restricted: boolean };
  posts: MattermostPost[];
  statuses?: Record<string, string>;
  history?: { complete: boolean; truncated: boolean; returned_count: number; oldest_included_at?: string | null; mode?: 'recent' | 'full' };
};

export type MattermostAvatar = {
  user_id: string;
  mime_type: string;
  data_base64: string;
};

export type MattermostFilePreview = {
  id: string;
  name: string;
  extension: string;
  mime_type: string;
  size: number;
  kind: 'pdf' | 'image' | 'text' | 'other';
  content?: string | null;
  data_base64?: string | null;
};
type MattermostEmoji = { name: string; mime_type: string; data_base64: string };

type MattermostSpaceProps = {
  projects?: {slug: string; name: string}[];
  onOpenProjectFile?: (project: string, relativePath: string) => void;
  overview: MattermostOverview | null;
  error: string | null;
  loading: boolean;
  selectedChannelId: string | null;
  channelData: MattermostChannelData | null;
  channelLoading: boolean;
  avatars: Record<string, MattermostAvatar>;
  channelBadge: (channel: MattermostChannel) => number;
  channelUnread?: (channel: MattermostChannel) => boolean;
  onRefresh: () => void;
  onSelectChannel: (channel: MattermostChannel) => void;
  onLoadHistory: (channelId: string) => Promise<void>;
  onOpenLink: (url: string) => Promise<void>;
  onReadFile: (fileId: string) => Promise<MattermostFilePreview>;
  onLoadAvatars: (requests: Array<{ channelId: string; userId: string }>) => void;
  onCreatePost: (channelId: string, message: string, rootId?: string | null) => Promise<void>;
  onUpdatePost: (postId: string, message: string, expectedUpdateAt: number) => Promise<void>;
};


type ThreadData = { posts: MattermostPost[]; root_id: string; next_cursor?: string | null; statuses?: Record<string, string> };
const MAX_INLINE_IMAGE_BYTES = 12 * 1024 ** 2;
const statusNames: Record<string, string> = { online: 'Activo', away: 'Ausente', dnd: 'No molestar', offline: 'Desconectado', unknown: 'Estado no disponible' };
export function groupMattermostChannels(overview: MattermostOverview | null) {
  const channels = overview?.channels ?? [], used = new Set<string>();
  const groups = (overview?.categories ?? []).map(category => ({ ...category, channels: category.channel_ids.flatMap(id => {
    const channel = channels.find(item => item.id === id); if (!channel || used.has(id)) return []; used.add(id); return [channel];
  }) })).filter(group => group.channels.length);
  for (const [id, label, match] of [
    ['projects', 'Proyectos', (c: MattermostChannel) => c.type !== 'D' && Boolean(c.registry_slug)],
    ['channels', 'Canales', (c: MattermostChannel) => c.type !== 'D'],
    ['direct', 'Mensajes directos', (c: MattermostChannel) => c.type === 'D'],
  ] as const) {
    const remaining = channels.filter(c => !used.has(c.id) && match(c)); remaining.forEach(c => used.add(c.id));
    if (remaining.length) groups.push({ id: `local-${id}`, label, collapsed: false, channel_ids: remaining.map(c => c.id), channels: remaining });
  }
  return groups;
}
const readCollapsed = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem('esprit-mm-folders') || '{}'); } catch { return {}; } };

export default function MattermostSpace(props: MattermostSpaceProps) {
  const { overview, selectedChannelId, channelData, channelLoading, avatars, onLoadAvatars, onReadFile, onOpenLink } = props;
  const [channelFilter, setChannelFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed);
  const [mode, setMode] = useState<'channel' | 'threads' | 'resources'>('channel');
  const [threadScope, setThreadScope] = useState<'followed' | 'channel'>('followed');
  const [inbox, setInbox] = useState<{ posts: MattermostPost[]; next_page?: number | null } | null>(null);
  const [inboxLoading, setInboxLoading] = useState(false), [inboxError, setInboxError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<{ channelId: string; posts: MattermostPost[]; limited?: boolean } | null>(null);
  const [searching, setSearching] = useState(false), [searchError, setSearchError] = useState<string | null>(null);
  const [thread, setThread] = useState<{ channelId: string; root: MattermostPost; data: ThreadData | null; loading: boolean; error: string | null } | null>(null);
  const [threadExpanded, setThreadExpanded] = useState(false);
  const [editing, setEditing] = useState<MattermostPost | null>(null);
  const [reactionTarget, setReactionTarget] = useState<MattermostPost | null>(null);
  const [reactionReview, setReactionReview] = useState<{ post: MattermostPost; name: string; remove: boolean } | null>(null);
  const [reactionBusy, setReactionBusy] = useState(false);
  const [reactionValues, setReactionValues] = useState<Record<string, MMReaction[]>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [customEmojis, setCustomEmojis] = useState<Record<string, string>>({});
  const [inlineImages, setInlineImages] = useState<Record<string, string>>({});
  const [inlineFailed, setInlineFailed] = useState<Record<string, true>>({});
  const [downloadTarget, setDownloadTarget] = useState<MattermostAttachment | null>(null);
  const [viewerAttachment, setViewerAttachment] = useState<MattermostAttachment | null>(null);
  const [fileViewer, setFileViewer] = useState<{ file: MattermostFilePreview | null; loading: boolean; error: string | null } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const railSplit = useResizableSplit({ storageKey: 'esprit-mm-rail-split', defaultValue: 22, min: 15, max: 35 });
  const threadSplit = useResizableSplit({ storageKey: 'esprit-mm-thread-split', defaultValue: 56, min: 35, max: 70 });
  const spaceRef = useRef<HTMLDivElement>(null), reactionButton = useRef<HTMLButtonElement>(null);
  const transcript = useRef<HTMLDivElement>(null), threadTranscript = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true), requestId = useRef(0), searchId = useRef(0), fileId = useRef(0);
  const reacting = useRef(false);
  const requestedEmojis = useRef(new Set<string>()), requestedImages = useRef(new Set<string>());
  const channels = useMemo(() => (overview?.channels ?? []).map(channel => {
    const identity = mattermostPresentation(channel, props.projects);
    return { ...channel, label: identity.label, presentationIcon: identity.icon, registry_slug: identity.project ?? channel.registry_slug };
  }), [overview, props.projects]);
  const selected = channels.find(c => c.id === selectedChannelId);
  const activeThread = thread?.channelId === selectedChannelId ? thread : null;
  const activeSearch = search?.channelId === selectedChannelId ? search : null;
  const activeEditing = editing?.channel_id === selectedChannelId ? editing : null;
  const posts = useMemo(() => (channelData?.channel.id === selectedChannelId ? channelData.posts : []).filter(p => !p.delete_at), [channelData, selectedChannelId]);
  const allPosts = useMemo(() => [...posts, ...(activeThread?.data?.posts ?? []), ...(activeSearch?.posts ?? []), ...(mode === 'threads' ? inbox?.posts ?? [] : [])], [posts, activeThread?.data, activeSearch, inbox, mode]);
  const roots = useMemo(() => {
    const ids = new Set(posts.filter(p => !p.root_id).map(p => p.id));
    return posts.filter(p => !p.root_id || !ids.has(p.root_id));
  }, [posts]);
  const repliesByRoot = useMemo(() => {
    const counts = new Map<string, number>();
    for (const post of posts) if (post.root_id) counts.set(post.root_id, (counts.get(post.root_id) ?? 0) + 1);
    return counts;
  }, [posts]);
  const replyCount = (post: MattermostPost) => Math.max(post.reply_count ?? 0, repliesByRoot.get(post.root_id || post.id) ?? 0);
  const openMessageLink = useCallback((url: string) => {
    void onOpenLink(url).catch(reason => setActionError(String(reason)));
  }, [onOpenLink]);
  const statuses = { ...overview?.statuses, ...channelData?.statuses, ...activeThread?.data?.statuses };
  // Ctrl/⌘J sees the open channel (and thread); protected channels only by name.
  const screenRef = useRef({ selected, posts, activeThread });
  useEffect(() => { screenRef.current = { selected, posts, activeThread }; });
  useEffect(() => registerScreen('mattermost', () => {
    const { selected: channel, posts: visible, activeThread: open } = screenRef.current;
    if (!channel) return { space: 'Mattermost', title: 'sin canal abierto', text: '' };
    if (channel.restricted) return { space: 'Mattermost', title: channel.label, text: 'Canal administrativo protegido: su contenido no se comparte.' };
    const line = (post: MattermostPost) => `[${new Date(post.create_at).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: getAppTimeZone() })}] ${post.username}: ${post.message}`;
    const recent = visible.filter((post) => !post.root_id).slice(-30).map(line).join('\n');
    const thread = open?.data?.posts?.length ? `\n\nHilo abierto (responder aquí):\n${open.data.posts.slice(-25).map(line).join('\n')}` : '';
    return { space: 'Mattermost', title: channel.label, text: `Canal ${channel.label}. Últimos mensajes:\n${recent}${thread}`, mattermost: { channelId: channel.id, rootId: open?.root.id ?? null } };
  }), []);
  const presence = (userId?: string | null) => {
    const status = userId ? statuses[userId] ?? 'unknown' : 'unknown';
    return <i className={`mm-presence ${status}`} role="img" aria-label={statusNames[status]} title={statusNames[status]} />;
  };
  const avatarSource = (id?: string | null) => id && avatars[id] ? `data:${avatars[id].mime_type};base64,${avatars[id].data_base64}` : undefined;
  const requestEmojiImages = useCallback((names: string[]) => {
    if (!selectedChannelId) return;
    const missing = [...new Set(names)].filter(name => !requestedEmojis.current.has(name)).slice(0, 240);
    if (!missing.length) return;
    missing.forEach(name => requestedEmojis.current.add(name));
    // The bridge accepts 24 names per call; every batch is requested, not only the first.
    for (let index = 0; index < missing.length; index += 24) {
      const batch = missing.slice(index, index + 24);
      void invoke<MattermostEmoji[]>('mattermost_emojis', { request: { channel_id: selectedChannelId, names: batch } })
        .then(values => setCustomEmojis(current => ({ ...current, ...Object.fromEntries(values.map(e => [e.name, `data:${e.mime_type};base64,${e.data_base64}`])) })))
        .catch(() => batch.forEach(name => requestedEmojis.current.delete(name)));
    }
  }, [selectedChannelId]);
  useEffect(() => { requestEmojiImages(customShortcodes(allPosts.flatMap(p => [p.message, ...(p.reactions ?? []).map(r => `:${r.name}:`)]))); }, [allPosts, requestEmojiImages]);
  useEffect(() => {
    const seen = new Set<string>();
    const requests = [...allPosts.map(post => ({ userId: post.user_id, channelId: post.channel_id })), ...channels.filter(c => c.counterpart_user_id).map(c => ({ userId: c.counterpart_user_id!, channelId: c.id }))]
      .filter(item => { if (!item.userId || avatars[item.userId] || seen.has(item.userId)) return false; seen.add(item.userId); return true; });
    if (requests.length) onLoadAvatars(requests);
  }, [allPosts, channels, avatars, onLoadAvatars]);
  const requestInlineImage = useCallback((file: MattermostAttachment) => {
    if (file.size > MAX_INLINE_IMAGE_BYTES || requestedImages.current.has(file.id) || requestedImages.current.size >= 60) return;
    requestedImages.current.add(file.id);
    void onReadFile(file.id).then(preview => {
      if (preview.kind !== 'image' || !preview.data_base64) throw new Error('Sin vista previa');
      setInlineImages(current => ({ ...current, [file.id]: `data:${preview.mime_type};base64,${preview.data_base64}` }));
    }).catch(() => setInlineFailed(current => ({ ...current, [file.id]: true })));
  }, [onReadFile]);
  useEffect(() => { stickBottom.current = true; transcript.current?.scrollTo({ top: transcript.current.scrollHeight }); }, [selectedChannelId]);
  useEffect(() => { if (stickBottom.current && mode === 'channel' && !activeSearch) transcript.current?.scrollTo({ top: transcript.current.scrollHeight }); }, [posts, activeSearch, mode]);

  const loadThread = useCallback(async (root: MattermostPost, cursor?: string) => {
    const id = ++requestId.current, channelId = root.channel_id;
    setThread(current => ({ channelId, root, data: current?.root.id === root.id ? current.data : null, loading: true, error: null }));
    try {
      const data = await invoke<ThreadData>('mattermost_workspace_read', { request: { operation: 'thread', channel_id: channelId, post_id: root.root_id || root.id, cursor: cursor ?? null } });
      if (id !== requestId.current) return;
      setThread(current => ({ channelId, root: data.posts.find(p => p.id === data.root_id) ?? root, loading: false, error: null,
        data: cursor && current?.data ? { ...data, posts: [...new Map([...current.data.posts, ...data.posts].map(p => [p.id, p])).values()].sort((a, b) => a.create_at - b.create_at) } : data }));
    } catch (reason) { if (id === requestId.current) setThread(current => current ? { ...current, loading: false, error: String(reason) } : null); }
  }, []);
  const threadRoot = activeThread?.root;
  useEffect(() => {
    if (!threadRoot || (activeThread?.data?.posts.length ?? 0) > 100) return;
    return startVisiblePolling(() => {
      if (!spaceRef.current?.closest('[hidden]')) return loadThread(threadRoot);
    }, 30_000, { runImmediately: false });
  }, [threadRoot, activeThread?.data?.posts.length, loadThread]);
  const loadInbox = async (page = 0) => {
    if (inboxLoading) return; setInboxLoading(true); setInboxError(null);
    try {
      const result = await invoke<{ posts: MattermostPost[]; next_page?: number | null }>('mattermost_workspace_read', { request: { operation: 'inbox', page } });
      setInbox(current => page && current ? { ...result, posts: [...new Map([...current.posts, ...result.posts].map(p => [p.id, p])).values()] } : result);
    } catch (reason) { setInboxError(String(reason)); } finally { setInboxLoading(false); }
  };
  const openThread = (post: MattermostPost) => {
    if (post.channel_id !== selectedChannelId) { const channel = channels.find(c => c.id === post.channel_id); if (!channel) return; props.onSelectChannel(channel); }
    setThreadExpanded(false); setActionError(null); void loadThread(post); };
  const closeThread = () => { requestId.current++; setThread(null); setThreadExpanded(false); };
  const selectChannel = (channel: MattermostChannel) => {
    if (reactionBusy) return;
    requestId.current++; searchId.current++; setThread(null); setSearch(null); setSearching(false); setSearchError(null); setQuery(''); setReactionTarget(null); setReactionReview(null); setEditing(null); setMode('channel'); props.onSelectChannel(channel);
  };
  const runSearch = async () => {
    if (!selectedChannelId || !query.trim()) return;
    const id = ++searchId.current, channelId = selectedChannelId; setSearching(true); setSearchError(null);
    try {
      const value = await invoke<{ posts: MattermostPost[]; limited?: boolean }>('mattermost_workspace_read', { request: { operation: 'search', channel_id: channelId, query } });
      if (id === searchId.current) { setSearch({ ...value, channelId }); setMode('channel'); transcript.current?.scrollTo({ top: 0 }); }
    } catch (reason) { if (id === searchId.current) setSearchError(String(reason)); } finally { if (id === searchId.current) setSearching(false); }
  };
  const openFile = async (file: MattermostAttachment) => {
    setViewerAttachment(file);
    const id = ++fileId.current; setFileViewer({ file: null, loading: true, error: null });
    try { const preview = await onReadFile(file.id); if (id === fileId.current) setFileViewer({ file: preview, loading: false, error: null }); }
    catch (reason) { if (id === fileId.current) setFileViewer({ file: null, loading: false, error: String(reason) }); }
  };
  const requestReaction = (post: MattermostPost, name: string, remove: boolean) => { setReactionTarget(null); setReactionReview({ post, name, remove }); setActionError(null); };
  const confirmReaction = async () => {
    if (!reactionReview || reacting.current) return; reacting.current = true; setReactionBusy(true); setActionError(null);
    try {
      const value = await invoke<{ post_id: string; reactions: MMReaction[] }>('mattermost_reaction', { request: { channel_id: reactionReview.post.channel_id, post_id: reactionReview.post.id, emoji_name: reactionReview.name, remove: reactionReview.remove, confirmed: true } });
      setReactionValues(current => ({ ...current, [value.post_id]: value.reactions })); setReactionReview(null);
    } catch (reason) { setActionError(String(reason)); } finally { setReactionBusy(false); reacting.current = false; }
  };
  // Authoritative channel refresh supersedes the local mutation response.
  useEffect(() => { setReactionValues({}); }, [channelData]);
  const afterSent = () => { props.onRefresh(); if (activeThread) void loadThread(activeThread.root); if (selectedChannelId) void props.onLoadHistory(selectedChannelId).catch(reason => setActionError(String(reason))); };
  const composer = (rootId?: string) => selected && !selected.restricted ? <MattermostComposer
    key={`${selected.id}:${rootId || 'channel'}:${activeEditing && (activeEditing.root_id || undefined) === rootId ? activeEditing.id : 'new'}`}
    containerRef={spaceRef} channelId={selected.id} label={selected.label} rootId={rootId}
    editing={activeEditing && (activeEditing.root_id || undefined) === rootId ? activeEditing : null}
    onCancelEdit={() => setEditing(null)} customEmojis={customEmojis} onRequestImages={requestEmojiImages}
    onOpenLink={onOpenLink} onCreatePost={props.onCreatePost} onUpdatePost={props.onUpdatePost} onSent={afterSent} /> : null;
  const renderPost = (post: MattermostPost, inThread = false, previous?: MattermostPost) => {
    const continued = continuesPrevious(post, previous);
    const stamp = post.create_at ? new Date(post.create_at).toLocaleString('es-ES', { dateStyle: 'full', timeStyle: 'short', timeZone: getAppTimeZone() }) : post.created_local;
    return <article key={post.id} data-post-id={post.id} className={continued ? 'continued' : undefined}>
    {continued ? <time className="mm-gutter-time" title={stamp}>{post.create_at ? madridClock(post.create_at) : ''}</time> : <div className="mm-avatar">{avatarSource(post.user_id) ? <img src={avatarSource(post.user_id)} alt="" /> : post.username.slice(0, 2).toUpperCase()}{presence(post.user_id)}</div>}
    <div><header>{continued ? null : <><strong>{post.username || 'Usuario'}</strong><time title={stamp}>{post.create_at ? madridClock(post.create_at) : post.created_local}</time></>}{post.edited ? <span>editado</span> : null}
      <div className="mm-message-actions"><button type="button" onClick={() => openThread(post)} aria-label={`Abrir thread de ${post.username}`}>↩ <span>Responder</span></button>
        <button type="button" ref={reactionTarget?.id === post.id ? reactionButton : undefined} onClick={event => { reactionButton.current = event.currentTarget; setReactionTarget(post); }} aria-label={`Reaccionar al mensaje de ${post.username}`}>☺+</button>
        {post.is_own && post.revision > 0 ? <button type="button" onClick={() => { setEditing(post); if (post.root_id && !inThread) openThread(post); }}>Editar</button> : null}</div>
    </header>
    <div className="mm-rich-message"><RichText content={normalizeEmojiAliases(post.message || '')} customEmojis={customEmojis} onOpenLink={openMessageLink} /></div>
    <div className="mm-inline-images">{post.attachments.filter(f => f.mime_type.startsWith('image/') && f.size <= MAX_INLINE_IMAGE_BYTES && !inlineFailed[f.id]).map(file => <MattermostInlineImage key={file.id} file={file} source={inlineImages[file.id] ?? null} failed={false} onRequest={requestInlineImage} onOpen={target => void openFile(target)} />)}</div>
    <div className="mm-attachments">{post.attachments.filter(f => !f.mime_type.startsWith('image/') || f.size > MAX_INLINE_IMAGE_BYTES || inlineFailed[f.id]).map(file => <span className="mm-attachment-actions" key={file.id}><button className="mm-attachment-open" key={file.id} type="button" onClick={() => void openFile(file)}><i>{file.extension.toUpperCase().slice(0, 4) || 'FILE'}</i><span><strong>{file.name}</strong><small>{(file.size / 1024).toFixed(0)} KB</small></span><b>↗</b></button><button type="button" aria-label={`Guardar ${file.name} en proyecto`} onClick={() => setDownloadTarget(file)}>↓</button></span>)}</div>
    <div className="mm-reactions">{(reactionValues[post.id] ?? post.reactions ?? []).map(reaction => <button key={reaction.name} type="button" className={reaction.own ? 'own' : ''} aria-pressed={reaction.own} aria-label={`${reaction.own ? 'Quitar' : 'Añadir'} reacción ${reaction.name}, ${reaction.count}`} onClick={() => requestReaction(post, reaction.name, reaction.own)}><RichText content={`:${reaction.name}:`} customEmojis={customEmojis} /><span>{reaction.count}</span></button>)}</div>
    {!inThread && (replyCount(post) > 0 || post.root_id) ? <button className="mm-open-thread" type="button" onClick={() => openThread(post)}><span>↩</span>{replyCount(post) === 1 ? '1 respuesta' : `${replyCount(post)} respuestas`} <span>Ver thread →</span></button> : null}
    </div></article>;
  };
  /** Posts with a day divider whenever the configured local date changes, as in Mattermost. */
  const renderTimeline = (posts: MattermostPost[], inThread = false) => posts.map((post, index) => {
    const previous = posts[index - 1];
    const newDay = post.create_at && (!previous || madridDayKey(previous.create_at) !== madridDayKey(post.create_at));
    return <div key={post.id}>{newDay ? <div className="mm-day-divider"><span>{dayLabel(post.create_at)}</span></div> : null}{renderPost(post, inThread, newDay ? undefined : previous)}</div>;
  });
  const groups = groupMattermostChannels(overview ? { ...overview, channels } : null);
  const displayPosts = activeSearch ? activeSearch.posts : mode === 'threads' ? threadScope === 'followed' ? inbox?.posts ?? [] : roots.filter(p => replyCount(p) > 0 || p.root_id) : roots;
  const file = fileViewer?.file, fileSource = file?.data_base64 ? `data:${file.mime_type};base64,${file.data_base64}` : null;
  return <div className={`mattermost-space mm-desktop${railSplit.collapsed ? ' rail-collapsed' : ''}`} ref={spaceRef} style={{ '--mm-rail-track': railSplit.track(195) } as CSSProperties}>
    {!railSplit.collapsed ? <aside className="mm-rail"><div className="mm-team"><div><strong>{overview?.team || 'Mattermost'}</strong><span>@{overview?.identity || '…'}</span></div><div><button type="button" onClick={props.onRefresh} disabled={props.loading} aria-label="Actualizar Mattermost">↻</button><button type="button" onClick={railSplit.toggleCollapse} aria-label="Ocultar canales">‹</button></div></div>
      <label className="mm-find-channel"><span>⌕</span><input aria-label="Buscar canal" placeholder="Buscar canal" value={channelFilter} onChange={event => setChannelFilter(event.target.value)} /></label>
      <button className={`mm-threads-nav${mode === 'threads' ? ' active' : ''}`} type="button" onClick={() => { setMode('threads'); setSearch(null); setThreadScope('followed'); void loadInbox(); }}>☷ Threads <span>{roots.filter(p => replyCount(p) > 0).length}</span></button>
      <div className="mm-channel-list">{groups.map(group => {
        const filtered = group.channels.filter(c => `${c.label} ${c.name}`.toLowerCase().includes(channelFilter.toLowerCase()));
        const folded = !channelFilter && (collapsed[group.id] ?? group.collapsed);
        if (!filtered.length) return null;
        return <section key={group.id}><button className="mm-folder" type="button" aria-expanded={!folded} onClick={() => setCollapsed(current => { const next = { ...current, [group.id]: !folded }; try { localStorage.setItem('esprit-mm-folders', JSON.stringify(next)); } catch {} return next; })}><span>{folded ? '›' : '⌄'}</span><b className={folded && group.channels.some(c => props.channelUnread?.(c)) ? 'unread' : undefined}>{group.label}</b>{(() => { const total = group.channels.reduce((sum, c) => sum + props.channelBadge(c), 0); return folded && total > 0 ? <i title={`${total} ${total === 1 ? 'aviso' : 'avisos'} en ${group.label}`}>{total}</i> : null; })()}</button>
          {!folded ? filtered.map(channel => <button className={[channel.registry_slug ? 'mm-project-channel' : '', selectedChannelId === channel.id ? 'active' : '', selectedChannelId !== channel.id && (props.channelUnread?.(channel) || props.channelBadge(channel) > 0) ? 'unread' : ''].filter(Boolean).join(' ') || undefined} type="button" key={channel.id} title={`${channel.label} · ${channel.type === 'P' ? 'Canal privado · ' : ''}${channel.name}`} onClick={() => selectChannel(channel)} aria-current={selectedChannelId === channel.id ? 'page' : undefined}>
            <span className={channel.type === 'D' ? 'mm-channel-avatar' : ''}>{channel.type === 'D' ? <>{avatarSource(channel.counterpart_user_id) ? <img src={avatarSource(channel.counterpart_user_id)} alt="" /> : channel.label.slice(0, 1)}{presence(channel.counterpart_user_id)}</> : mattermostPresentation(channel, props.projects).icon}</span><b>{channel.label}</b>{props.channelBadge(channel) > 0 ? <i>{props.channelBadge(channel)}</i> : null}</button>) : null}</section>;
      })}</div><footer><i className={props.error ? 'error' : ''} /><span>{props.error ? 'Sin conexión' : overview ? 'Sincronización activa' : 'Conectando…'}</span></footer></aside> : null}
    {!railSplit.collapsed ? <SplitDivider split={railSplit} className="mm-resizer vertical" label="Cambiar ancho de canales" /> : null}
    <div className="mm-main">
      {searchError ? <p className="mm-banner" role="alert">{searchError}</p> : null}
      <div className={`mm-panes${activeThread ? ' has-thread' : ''}${threadExpanded ? ' thread-expanded' : ''}`} style={{ '--mm-channel-width': `${threadSplit.value}%` } as CSSProperties}>
        <section className="mm-channel-pane" hidden={Boolean(activeThread && threadExpanded)}>
          <header className="mm-pane-header mm-channel-header">
            {railSplit.collapsed ? <button className="mm-show-rail" type="button" onClick={railSplit.toggleCollapse} aria-label="Mostrar canales" title="Mostrar canales">☰</button> : null}
            <div className="mm-channel-title"><h3 title={selected ? `${selected.name}${selected.type === 'P' ? ' · Canal privado' : ''}` : undefined}>{mode === 'threads' ? 'Threads' : selected ? `${selected.presentationIcon} ${selected.label}` : 'Mattermost'}</h3><span>{mode === 'threads' ? threadScope === 'followed' ? 'Threads que sigues' : `Del canal ${selected?.label || ''}` : selected?.type === 'D' ? statusNames[statuses[selected.counterpart_user_id || ''] || 'unknown'] : overview?.team}</span></div>
            {mode !== 'threads' && selected && !selected.restricted ? <div className="mm-view-tabs" role="tablist" aria-label="Contenido del canal"><button type="button" role="tab" aria-selected={mode === 'channel'} onClick={() => setMode('channel')}>Conversación</button><button type="button" role="tab" aria-selected={mode === 'resources'} onClick={() => { setMode('resources'); setSearch(null); setThreadExpanded(false); }}>Adjuntos y enlaces</button></div> : null}
            {mode === 'threads' ? <div className="mm-view-tabs"><button type="button" aria-pressed={threadScope === 'followed'} onClick={() => { setThreadScope('followed'); if (!inbox) void loadInbox(); }}>Seguidos</button><button type="button" aria-pressed={threadScope === 'channel'} onClick={() => setThreadScope('channel')}>En este canal</button><button type="button" disabled={inboxLoading} aria-label="Actualizar threads" onClick={() => void loadInbox()}>↻</button><button type="button" onClick={() => setMode('channel')}>Volver al canal</button></div> : null}
            <form className="mm-header-search" onSubmit={event => { event.preventDefault(); void runSearch(); }}><span aria-hidden="true">⌕</span><input aria-label="Buscar mensajes en el canal" placeholder={selected ? `Buscar en ${selected.label}` : 'Buscar'} value={query} onChange={event => setQuery(event.target.value)} disabled={!selected || selected.restricted} title="Intro para buscar · mínimo 2 caracteres" />{searching ? <small>…</small> : null}</form>
          </header>
          {mode === 'resources' && selected && !selected.restricted ? <MattermostResources key={selected.id} channelId={selected.id} onOpenFile={file => void openFile(file)} onOpenLink={openMessageLink} onOpenPost={openThread} onDownloadFile={setDownloadTarget} /> : null}
          {mode === 'threads' ? <div className="mm-thread-tabs"><button type="button" aria-pressed={threadScope === 'followed'} onClick={() => { setThreadScope('followed'); if (!inbox) void loadInbox(); }}>Seguidos</button><button type="button" aria-pressed={threadScope === 'channel'} onClick={() => setThreadScope('channel')}>En este canal</button><button type="button" disabled={inboxLoading} aria-label="Actualizar threads" onClick={() => void loadInbox()}>↻</button></div> : null}
          {activeSearch ? <div className="mm-search-summary"><span>{activeSearch.posts.length} resultados{activeSearch.limited ? ' · primeros 100' : ''}</span><button type="button" onClick={() => { setSearch(null); setQuery(''); }}>Cerrar búsqueda</button></div> : null}
          <div className="mm-messages" hidden={mode === 'resources'} ref={transcript} onScroll={() => { const el = transcript.current; if (el) stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72; }}>
            {!activeSearch && (mode === 'channel' || threadScope === 'channel') && channelData?.history?.mode === 'recent' && channelData.history.truncated ? <button className="mm-load-history" type="button" disabled={historyLoading} onClick={() => { if (!selectedChannelId) return; setHistoryLoading(true); void props.onLoadHistory(selectedChannelId).catch(e => setActionError(String(e))).finally(() => setHistoryLoading(false)); }}>{historyLoading ? 'Cargando historial…' : 'Cargar mensajes anteriores'}</button> : null}
            {(channelLoading && mode !== 'threads') || (mode === 'threads' && threadScope === 'followed' && inboxLoading && !inbox) || (mode !== 'threads' && selected && !selected.restricted && !channelData && !props.error) ? <div className="desk-skeleton" role="status" aria-label="Cargando conversación"><i /><i /><i /><i /><i /><i /></div> : selected?.restricted ? <div className="mm-protected"><h3>Canal administrativo protegido</h3><p>Este contenido no se abre en la vista rutinaria.</p></div> : displayPosts.length ? (mode === 'channel' && !activeSearch ? renderTimeline(displayPosts) : displayPosts.map(post => <div key={post.id}>{mode === 'threads' && threadScope === 'followed' ? <div className="mm-inbox-origin">{channels.find(c => c.id === post.channel_id)?.label}{post.unread_replies ? ` · ${post.unread_replies} sin leer` : ''}</div> : null}{renderPost(post)}</div>)) : <p className="mm-state">{props.error || (mode === 'threads' ? inboxError || (threadScope === 'followed' ? 'No hay threads seguidos en esta página.' : 'No hay threads en los mensajes cargados.') : activeSearch ? 'No se encontraron mensajes.' : 'No hay mensajes recientes.')}</p>}
            {mode === 'threads' && threadScope === 'followed' && inbox?.next_page != null ? <button type="button" className="mm-load-history" disabled={inboxLoading} onClick={() => void loadInbox(inbox.next_page!)}>Cargar más threads</button> : null}
          </div>{mode === 'channel' ? composer() : null}
        </section>
        {activeThread ? <>{!threadExpanded ? <SplitDivider split={threadSplit} className="mm-resizer vertical" label="Cambiar ancho del thread" /> : null}<section className="mm-thread-pane" aria-label="Conversación del thread"><header className="mm-pane-header"><div><h3>Thread</h3><span>{selected?.label}</span></div><div className="mm-thread-controls"><button type="button" aria-label={threadExpanded ? 'Reducir thread' : 'Expandir thread'} onClick={() => setThreadExpanded(v => !v)}>{threadExpanded ? '↙' : '↗'}</button><button type="button" aria-label="Cerrar thread" onClick={closeThread}>×</button></div></header>
          <div className="mm-messages" ref={threadTranscript}>
            {activeThread.loading && !activeThread.data ? <p role="status">Cargando thread…</p> : null}
            {activeThread.error ? <p className="mm-banner" role="alert">{activeThread.error}<button type="button" onClick={() => void loadThread(activeThread.root)}>Reintentar</button></p> : null}
            {renderTimeline(activeThread.data?.posts ?? [activeThread.root], true)}
            {activeThread.data?.next_cursor ? <button type="button" disabled={activeThread.loading} className="mm-load-history" onClick={() => void loadThread(activeThread.root, activeThread.data?.next_cursor ?? undefined)}>Cargar más respuestas</button> : null}
          </div>{composer(activeThread.data?.root_id || activeThread.root.root_id || activeThread.root.id)}
        </section></> : null}
      </div>
    </div>
    {actionError && !reactionReview ? <div className="mm-action-notice" role="alert">{actionError}<button type="button" onClick={() => setActionError(null)}>×</button></div> : null}
    {reactionTarget ? <EmojiPicker autocompleteQuery={null} channelId={reactionTarget.channel_id} anchorRef={reactionButton} containerRef={spaceRef} images={customEmojis} onRequestImages={requestEmojiImages} onSelect={(option: EmojiOption) => requestReaction(reactionTarget, option.name, false)} onClose={() => setReactionTarget(null)} /> : null}
    {reactionReview ? <div className="mm-review-layer" role="dialog" aria-modal="true" aria-label="Confirmar reacción"><section><header><h3>{reactionReview.remove ? 'Quitar' : 'Añadir'} reacción</h3><span>{channels.find(c => c.id === reactionReview.post.channel_id)?.label} · @{reactionReview.post.username}</span></header><div className="mm-review-message"><RichText content={`:${reactionReview.name}:`} customEmojis={customEmojis} /><p>{reactionReview.post.message.slice(0, 180)}</p></div>{actionError ? <p role="alert">{actionError}</p> : null}<footer><button type="button" disabled={reactionBusy} onClick={() => setReactionReview(null)}>Cancelar</button><button type="button" className="primary" disabled={reactionBusy} onClick={() => void confirmReaction()}>{reactionBusy ? 'Guardando…' : 'Confirmar reacción'}</button></footer></section></div> : null}
    {downloadTarget ? <ProjectAttachmentDownload file={downloadTarget} projects={props.projects ?? []} onClose={() => setDownloadTarget(null)} onOpen={(project, relativePath) => { setDownloadTarget(null); props.onOpenProjectFile?.(project, relativePath); }} /> : null}
    {fileViewer ? <section className="mm-file-viewer" aria-label="Visor de adjuntos"><header><h3>{file?.name || viewerAttachment?.name || 'Adjunto'}</h3>{viewerAttachment ? <button type="button" className="mm-file-download" onClick={() => setDownloadTarget(viewerAttachment)}>Guardar en proyecto ↓</button> : null}<button type="button" aria-label="Cerrar visor" onClick={() => { fileId.current++; setFileViewer(null); }}>×</button></header>{fileViewer.loading ? <p>Leyendo adjunto…</p> : fileViewer.error ? <p role="alert">{fileViewer.error}</p> : file?.kind === 'text' ? <pre>{file.content}</pre> : file?.kind === 'image' && fileSource ? <div className="mm-file-preview image"><img src={fileSource} alt={file.name} /></div> : file?.kind === 'pdf' && fileSource ? <div className="mm-file-preview pdf"><iframe src={fileSource} title={file.name} /></div> : <p>Este formato no tiene vista previa.</p>}</section> : null}
  </div>;
}
