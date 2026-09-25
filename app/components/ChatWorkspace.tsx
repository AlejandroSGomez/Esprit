'use client';

import { useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { useChatConversations } from '../useChatConversations';
import RichText from './RichText';
import './ChatWorkspace.css';
import { getAppTimeZone } from '../appConfig';

type ChatController = ReturnType<typeof useChatConversations>;

/** Copy a reply, or put the failed turn's question back in the draft. */
function MessageActions({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  useEffect(() => {
    if (copied === 'idle') return;
    const timer = window.setTimeout(() => setCopied('idle'), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = () => { void navigator.clipboard?.writeText(text).then(() => setCopied('done'), () => setCopied('failed')); };
  return <span className="chat-message-actions">
    {onRetry ? <button type="button" onClick={onRetry}>Reintentar ↻</button> : null}
    <button type="button" onClick={copy} aria-live="polite">{copied === 'done' ? 'Copiado ✓' : copied === 'failed' ? 'No se pudo copiar' : 'Copiar'}</button>
  </span>;
}
export default function ChatWorkspace({ chat, contextLabels, profilePicker, inputRef, onSubmit, onKeyDown, onClose, onOpenLink }: {
  chat: ChatController; contextLabels: Record<string, string>; profilePicker: ReactNode; inputRef: RefObject<HTMLTextAreaElement | null>;
  onSubmit: (event?: FormEvent) => void; onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void; onClose: () => void; onOpenLink?: (url: string) => void;
}) {
  const [expanded, setExpanded] = useState(() => typeof window === 'undefined' || window.localStorage.getItem('esprit-chat-expanded') !== '0');
  const [historyOpen, setHistoryOpen] = useState(expanded);
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const sticky = useRef(true);
  const selected = chat.selected;
  const deferredSearch = useDeferredValue(search).toLocaleLowerCase('es');
  const index = useMemo(() => chat.history.conversations.map((item) => ({ item, text: `${item.title} ${contextLabels[item.context]} ${item.messages.map((message) => message.text).join(' ')}`.toLocaleLowerCase('es') })), [chat.history.conversations, contextLabels]);
  const results = useMemo(() => index.filter(({ item, text }) => Boolean(item.archived) === showArchived && text.includes(deferredSearch)).map(({ item }) => item).sort((a, b) => b.updated_at - a.updated_at), [index, showArchived, deferredSearch]);
  useEffect(() => { inputRef.current?.focus(); }, [inputRef]);
  useEffect(() => { sticky.current = true; transcript.current?.scrollTo({ top: transcript.current.scrollHeight }); }, [selected?.id]);
  useEffect(() => {
    if (!sticky.current) return;
    const frame = requestAnimationFrame(() => transcript.current?.scrollTo({ top: transcript.current.scrollHeight }));
    return () => cancelAnimationFrame(frame);
  }, [selected?.messages, chat.run?.text, chat.run?.activities]);
  const toggleExpanded = () => { window.localStorage.setItem('esprit-chat-expanded', expanded ? '0' : '1'); setHistoryOpen(!expanded); setExpanded(!expanded); };
  return <section className={`chat-workspace${expanded ? ' expanded' : ''}${historyOpen ? ' history-open' : ''}`} aria-label="Conversaciones" data-engine={selected?.engine ?? 'codex'}>
    <header className="chat-workspace-header">
      <button type="button" onClick={() => setHistoryOpen((value) => !value)} aria-expanded={historyOpen} aria-label="Mostrar historial">☰</button>
      <div><span>{selected ? contextLabels[selected.context] : 'NUEVA CONVERSACIÓN'}</span>{selected ? <input key={selected.id} aria-label="Título de la conversación" defaultValue={selected.title} maxLength={120} onBlur={(event) => chat.rename(selected.id, event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /> : <h2>Nuevo chat</h2>}</div>
      <button type="button" onClick={chat.fresh} disabled={chat.isAsking}>＋ Nuevo</button>
      <button type="button" onClick={toggleExpanded} aria-label={expanded ? 'Reducir chat a panel lateral' : 'Ampliar chat'} title={expanded ? 'Panel lateral' : 'Espacio completo'}>{expanded ? '↙' : '↗'}</button>
      <button type="button" onClick={onClose} aria-label="Cerrar chat">×</button>
    </header>
    {historyOpen ? <aside className="chat-history" aria-label="Historial de conversaciones">
      <label><span>Buscar conversación</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Título, proyecto o mensaje…" /></label>
      <div className="chat-history-tabs"><button type="button" onClick={() => setShowArchived(false)} aria-pressed={!showArchived}>Recientes</button><button type="button" onClick={() => setShowArchived(true)} aria-pressed={showArchived}>Archivadas</button></div>
      <div className="chat-history-list">{results.map((item) => <button key={item.id} type="button" onClick={() => { chat.select(item.id); if (!expanded) setHistoryOpen(false); }} disabled={chat.isAsking} aria-current={item.id === selected?.id ? 'true' : undefined}><strong>{item.title}</strong><span>{contextLabels[item.context] ?? item.context}</span><small>{item.updated_at || item.created_at ? new Date(item.updated_at || item.created_at).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: getAppTimeZone() }) : 'Sin fecha'} · {item.engine === 'codex' ? 'Codex' : 'Claude'}{item.status === 'expired' ? ' · sesión caducada' : ''}</small></button>)}{!results.length ? <p>{search ? 'No hay coincidencias.' : showArchived ? 'No hay conversaciones archivadas.' : 'Tus conversaciones aparecerán aquí.'}</p> : null}</div>
      <footer>{selected ? <button type="button" disabled={chat.isAsking} onClick={() => chat.archive(selected.id)}>{selected.archived ? 'Desarchivar' : 'Archivar conversación'}</button> : null}<button type="button" onClick={chat.exportHistory}>Exportar historial</button><small>Local en este equipo · hasta 400 mensajes por conversación. El historial anterior no se mezcla entre proyectos o motores.</small></footer>
    </aside> : null}
    <div className="chat-conversation-body">
      {chat.warning ? <p className="chat-warning" role="status">{chat.warning}</p> : null}
      {selected?.status === 'expired' ? <p className="chat-warning">El historial se conserva, pero esta sesión ya no se puede reanudar. Inicia un nuevo chat para continuar.</p> : null}
      <div className="chat-messages" ref={transcript} onScroll={() => { const element = transcript.current; if (element) sticky.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
        {!!selected?.older_messages && <p className="chat-retention">Se conservan los últimos 400 mensajes; {selected.older_messages} anteriores quedaron fuera de la retención visible.</p>}
        {!selected?.messages.length && !chat.isAsking ? <div className="chat-welcome"><span>ESPRIT / CHAT</span><h3>Un espacio para seguir pensando.</h3><p>Elige un proyecto y un modelo. Cada conversación conserva sus mensajes, borrador y actividad.</p><p>Puedes cambiar modelo y razonamiento sin perder el hilo dentro del mismo motor y proyecto.</p></div> : null}
        {selected?.messages.map((message) => <article className={`chat-message ${message.role}${message.error ? ' has-error' : ''}`} key={message.id}><header><strong>{message.role === 'user' ? 'Tú' : message.engine === 'codex' ? 'Codex' : 'Claude'}</strong><small>{message.model.replace('gpt-', '')} · {message.effort}</small>{message.role === 'assistant' ? <MessageActions text={message.text} onRetry={message.error && message.error !== 'SESSION_EXPIRED' && !chat.isAsking ? () => { const messages = selected?.messages ?? []; const index = messages.findIndex((item) => item.id === message.id); const question = messages.slice(0, index).reverse().find((item) => item.role === 'user'); if (question) { chat.setDraft(question.text); window.requestAnimationFrame(() => inputRef.current?.focus()); } } : undefined} /> : null}</header>{message.role === 'assistant' ? <RichText content={message.text} onOpenLink={onOpenLink} /> : <p>{message.text}</p>}{message.activities?.length ? <details className="chat-activity"><summary>Actividad · {message.activities.length}</summary><ul>{message.activities.map((activity) => <li key={activity.id} data-state={activity.state}><span>{activity.state === 'completed' ? '✓' : activity.state === 'cancelled' ? '○' : activity.state === 'failed' ? '!' : '·'}</span>{activity.label}</li>)}</ul></details> : null}</article>)}
        {chat.run && <article className="chat-message assistant live"><header><strong>{selected?.engine === 'claude' ? 'Claude' : 'Codex'}</strong><small role="status">{chat.run.label}</small></header>{chat.run.text ? <RichText content={chat.run.text} /> : <div className="chat-working-indicator" aria-label="Trabajando" />}{chat.run.activities.length > 0 && <details className="chat-activity" open><summary>Actividad en curso</summary><ul>{chat.run.activities.map((activity) => <li key={activity.id} data-state={activity.state}><span>{activity.state === 'completed' ? '✓' : '·'}</span>{activity.label}</li>)}</ul></details>}</article>}
      </div>
      <form className="chat-workspace-composer" onSubmit={onSubmit}>
        <textarea ref={inputRef} value={chat.draft} onChange={(event) => chat.setDraft(event.target.value)} onKeyDown={onKeyDown} placeholder="Escribe un mensaje…" rows={2} maxLength={6000} aria-label="Mensaje de la conversación" disabled={chat.isAsking} />
        <div className="chat-workspace-controls">{profilePicker}<div className="chat-send-controls">{chat.catalog?.skills?.length ? <select value="" aria-label="Usar una skill" disabled={chat.isAsking} onChange={(event) => { if (event.target.value) chat.setDraft((draft) => `${draft}${draft ? '\n' : ''}$${event.target.value} `); inputRef.current?.focus(); }}><option value="">＋ Skill</option>{chat.catalog.skills.map((skill) => <option key={skill.name} value={skill.name}>{skill.label}</option>)}</select> : null}<small>Ctrl/⌘↵ · solo lectura</small>{chat.isAsking ? <button type="button" onClick={() => void chat.cancel()} disabled={!chat.run}>Detener ■</button> : <button type="submit" disabled={!chat.draft.trim() || !chat.ready || selected?.status === 'expired'}>Enviar ↑</button>}</div></div>
      </form>
    </div>
  </section>;
}
