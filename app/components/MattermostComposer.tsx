'use client';

import { RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import RichText from './RichText';
import EmojiPicker, { EmojiPickerHandle } from './EmojiPicker';
import { EmojiCompletion, EmojiOption, findEmojiCompletion, insertEmoji, normalizeEmojiAliases } from './emojiHelpers';
import type { MattermostPost } from './MattermostSpace';
import { AttachmentTray, useComposerFiles } from './ComposerAttachments';
import type { ComposerFile } from '../composerFiles';

const LIMITS = { files: 5, perFile: 8 * 1024 ** 2, total: 20 * 1024 ** 2 };
type Props = {
  containerRef: RefObject<HTMLDivElement | null>;
  channelId: string; label: string; rootId?: string; disabled?: boolean;
  editing: MattermostPost | null; onCancelEdit: () => void;
  customEmojis: Record<string, string>; onRequestImages: (names: string[]) => void;
  onOpenLink: (url: string) => Promise<void>;
  onCreatePost: (channel: string, message: string, root?: string | null) => Promise<void>;
  onUpdatePost: (post: string, message: string, revision: number) => Promise<void>;
  onSent: () => void;
};
const DRAFT_KEY = 'esprit-mattermost-drafts';
const sessionFiles = new Map<string, ComposerFile[]>();
function readDraft(key: string) {
  try { const value = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}')[key]; return typeof value === 'string' ? value : ''; } catch { return ''; }
}
function saveDraft(key: string, value: string) {
  try { const drafts = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); if (value) drafts[key] = value; else delete drafts[key]; localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts)); } catch { /* Keep draft in this session. */ }
}
export function formatMattermostSelection(text: string, start: number, end: number, before: string, after: string, placeholder: string) {
  const selected = text.slice(start, end) || placeholder;
  return { text: text.slice(0, start) + before + selected + after + text.slice(end), start: start + before.length, end: start + before.length + selected.length };
}
const formats = [
  ['B', 'Negrita · Ctrl/⌘B', '**', '**', 'texto'], ['I', 'Cursiva · Ctrl/⌘I', '*', '*', 'texto'],
  ['S̶', 'Tachado', '~~', '~~', 'texto'], ['H', 'Título', '\n### ', '\n', 'Título'],
  ['↗', 'Enlace · Ctrl/⌘K', '[', '](https://)', 'texto'], ['‹›', 'Código', '`', '`', 'código'],
  ['❝', 'Cita', '\n> ', '\n', 'cita'], ['≡', 'Lista', '\n- ', '\n', 'elemento'],
  ['1.', 'Lista numerada', '\n1. ', '\n', 'elemento'], ['∑', 'Ecuación en línea', '$', '$', 'E = mc^2'],
  ['∫', 'Ecuación en bloque', '\n$$\n', '\n$$\n', 'E = mc^2'],
];

export default function MattermostComposer(props: Props) {
  const key = `${props.channelId}${props.rootId ? `:thread:${props.rootId}` : ''}${props.editing ? `:edit:${props.editing.id}` : ''}`;
  const [draft, setDraft] = useState(() => readDraft(key) || props.editing?.message || '');
  const [files, setFiles] = useState<ComposerFile[]>(() => sessionFiles.get(key) ?? []);
  const [review, setReview] = useState<{ message: string; files: ComposerFile[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Rendered Markdown/LaTeX preview, on by default and remembered on this Mac.
  const [preview, setPreviewState] = useState(() => { try { return localStorage.getItem('esprit-mm-preview') !== '0'; } catch { return true; } });
  const setPreview = (update: (value: boolean) => boolean) => setPreviewState(current => { const next = update(current); try { localStorage.setItem('esprit-mm-preview', next ? '1' : '0'); } catch { /* preference only */ } return next; });
  const [emoji, setEmoji] = useState<{ completion: EmojiCompletion | null; start: number; end: number } | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null), picker = useRef<EmojiPickerHandle>(null);
  const emojiButton = useRef<HTMLButtonElement>(null), container = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  useEffect(() => { if (files.length) sessionFiles.set(key, files); else sessionFiles.delete(key); }, [files, key]);
  const update = (value: string) => { setDraft(value); saveDraft(key, value); setError(null); };
  // Pasted screenshots, copied Finder files and drops join the pending files.
  const attach = useComposerFiles({
    pending: files, limits: LIMITS, disabled: props.disabled || busy || Boolean(props.editing),
    accept: next => setFiles(current => [...current, ...next]), problem: setError,
    text: { value: draft, set: (value, cursor) => { update(value.slice(0, 16000)); requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(cursor, cursor); }); } },
  });
  const reading = attach.reading;
  const locked = props.disabled || busy || reading;
  // A draft proposed by the Ctrl/⌘J agent lands in the open thread's composer, or in
  // the channel's when no thread is open. Sending keeps the usual review.
  const updateRef = useRef(update);
  const occupied = useRef(false);
  useLayoutEffect(() => { occupied.current = Boolean(draft.trim() || files.length || locked || review); });
  useEffect(() => { updateRef.current = update; });
  useEffect(() => {
    if (props.editing) return;
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{ channelId: string; rootId: string | null; message: string; handled: boolean; problem: string }>).detail;
      if (!detail || detail.channelId !== props.channelId || (detail.rootId ?? null) !== (props.rootId ?? null)) return;
      if (occupied.current) { detail.problem = 'Hay un borrador, adjuntos o una revisión en este compositor. Consérvalos o ciérralos antes de aplicar otro mensaje.'; return; }
      detail.handled = true;
      occupied.current = true;
      updateRef.current(detail.message);
      window.requestAnimationFrame(() => textarea.current?.focus());
    };
    window.addEventListener('esprit:mattermost-draft', receive);
    return () => window.removeEventListener('esprit:mattermost-draft', receive);
  }, [props.channelId, props.rootId, props.editing]);
  useEffect(() => { if (props.editing) textarea.current?.focus(); }, [props.editing]);
  const format = (before: string, after: string, placeholder: string) => {
    const field = textarea.current; if (!field || locked) return;
    const next = formatMattermostSelection(draft, field.selectionStart, field.selectionEnd, before, after, placeholder);
    if (next.text.length > 16000) { setError('Máximo 16.000 caracteres.'); return; }
    update(next.text); setEmoji(null);
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(next.start, next.end); });
  };
  const pickEmoji = (option: EmojiOption) => {
    if (!emoji || locked) return;
    const result = insertEmoji(draft, emoji.completion?.start ?? emoji.start, emoji.completion?.end ?? emoji.end, option.value);
    if (!result) return;
    update(result.text); setEmoji(null);
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(result.cursor, result.cursor); });
  };
  const prepare = () => { if (!locked && (draft.trim() || files.length)) { setReview({ message: draft.trim() ? draft : '', files: [...files] }); setEmoji(null); } };
  const send = async () => {
    if (!review || sending.current) return;
    sending.current = true; setBusy(true); setError(null);
    try {
      if (props.editing) await props.onUpdatePost(props.editing.id, review.message, props.editing.revision);
      else if (review.files.length) await invoke('mattermost_send_files', { request: { channel_id: props.channelId, root_id: props.rootId ?? null, message: review.message, files: review.files.map(({ name, data_base64 }) => ({ name, data_base64 })), confirmed: true } });
      else await props.onCreatePost(props.channelId, review.message, props.rootId);
      update(''); setFiles([]); setReview(null); props.onSent(); if (props.editing) props.onCancelEdit();
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); sending.current = false; }
  };
  return <div className={`mm-compose${attach.dragging ? ' composer-drop' : ''}`} ref={container} {...attach.dropProps} aria-label={props.rootId ? 'Responder al thread' : 'Mensaje del canal'}>
    {props.editing ? <div className="mm-compose-context">Editando tu mensaje <button disabled={busy} type="button" onClick={props.onCancelEdit}>Cancelar edición</button></div> : null}
    <div className={`mm-compose-body${preview && draft.trim() ? ' with-preview' : ''}`}>
    <textarea ref={textarea} value={draft} maxLength={16000} disabled={locked} aria-label={props.rootId ? 'Respuesta para Mattermost' : 'Mensaje para Mattermost'} placeholder={props.rootId ? 'Responder a este thread…' : `Escribe en ${props.label}…`}
      onPaste={attach.onPaste}
      onChange={event => { update(event.target.value); const completion = findEmojiCompletion(event.target.value, event.target.selectionStart, event.target.selectionEnd); setEmoji(completion ? { completion, start: event.target.selectionStart, end: event.target.selectionEnd } : null); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || attach.onKeyDown(event)) return;
        if (emoji && !event.metaKey && !event.ctrlKey && !event.altKey && picker.current?.handleKey(event.key)) { event.preventDefault(); event.stopPropagation(); return; }
        if (event.metaKey || event.ctrlKey) {
          const name = event.key.toLowerCase();
          if (name === 'enter') { event.preventDefault(); prepare(); }
          const entry = name === 'b' ? formats[0] : name === 'i' ? formats[1] : name === 'k' ? formats[4] : null;
          if (entry) { event.preventDefault(); event.stopPropagation(); format(entry[2], entry[3], entry[4]); }
        }
      }} />
    {preview && draft.trim() ? <div className="mm-compose-preview" aria-label="Previsualización" title="Vista previa · Aa para ocultarla"><RichText content={normalizeEmojiAliases(draft)} customEmojis={props.customEmojis} onOpenLink={url => void props.onOpenLink(url).catch(e => setError(String(e)))} /></div> : null}
    </div>
    <AttachmentTray files={files} disabled={locked} inline onRemove={id => setFiles(current => current.filter(file => file.id !== id))} />
    <div className="mm-formatbar" role="toolbar" aria-label="Formato del mensaje">
      {formats.map(([glyph, label, before, after, placeholder]) => <button key={label} title={label} aria-label={label} disabled={locked} type="button" onMouseDown={e => e.preventDefault()} onClick={() => format(before, after, placeholder)}>{glyph}</button>)}
      <span className="mm-format-spacer" />
      <button type="button" aria-label="Adjuntar archivos" title="Adjuntar archivos · también puedes pegarlos (Ctrl/⌘V) o arrastrarlos · hasta 8 MB cada uno" disabled={locked || Boolean(props.editing)} onClick={() => input.current?.click()}>⌁</button>
      <button type="button" ref={emojiButton} aria-label="Elegir emoji" aria-expanded={Boolean(emoji)} disabled={locked} onClick={() => setEmoji(emoji ? null : { completion: null, start: textarea.current?.selectionStart ?? draft.length, end: textarea.current?.selectionEnd ?? draft.length })}>☺</button>
      <button type="button" aria-pressed={preview} onClick={() => setPreview(v => !v)} title={preview ? 'Ocultar vista previa de Markdown y LaTeX' : 'Mostrar vista previa de Markdown y LaTeX'}>Aa</button>
      <button className="mm-send" type="button" disabled={locked || (!draft.trim() && !files.length)} onClick={prepare} title={files.length ? `Revisar antes de publicar · ${files.length === 1 ? 'el adjunto se sube' : 'los adjuntos se suben'} al confirmar · Ctrl/⌘↵` : 'Revisar antes de publicar · Ctrl/⌘↵'}>Revisar {props.editing ? 'cambio' : props.rootId ? 'respuesta' : 'envío'} →</button>
    </div>
    <input type="file" multiple hidden ref={input} onChange={event => { attach.choose(event.target.files); event.target.value = ''; }} />
    {error || reading ? <footer><span role="status">{error || 'Preparando archivos…'}</span></footer> : null}
    {emoji && props.containerRef.current ? createPortal(<EmojiPicker ref={picker} channelId={props.channelId} autocompleteQuery={emoji.completion?.query ?? null} anchorRef={emojiButton} containerRef={props.containerRef} images={props.customEmojis} onRequestImages={props.onRequestImages} onSelect={pickEmoji} onClose={() => setEmoji(null)} />, props.containerRef.current) : null}
    {review ? <div className="mm-review-layer" role="dialog" aria-modal="true" aria-label="Revisar publicación">
      <section><header><span>{props.editing ? 'CONFIRMAR EDICIÓN' : 'CONFIRMAR ENVÍO'}</span><h3>{props.rootId ? `Respuesta en ${props.label}` : props.label}</h3></header>
        {props.editing ? <div className="mm-review-original"><span>Original</span><RichText content={normalizeEmojiAliases(props.editing.message)} customEmojis={props.customEmojis} /></div> : null}
        <div className="mm-review-message"><RichText content={normalizeEmojiAliases(review.message)} customEmojis={props.customEmojis} /></div>
        {review.files.length ? <div className="mm-review-files"><AttachmentTray files={review.files} compact /></div> : null}
        {error ? <p className="mm-review-error" role="alert">{error}</p> : null}
        <footer><button type="button" disabled={busy} onClick={() => setReview(null)}>Volver a editar</button><button type="button" className="primary" disabled={busy} onClick={() => void send()}>{busy ? 'Publicando…' : props.editing ? 'Confirmar edición' : 'Confirmar y enviar'}</button></footer>
      </section>
    </div> : null}
  </div>;
}
