'use client';

import { RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import RichText from './RichText';
import EmojiPicker, { EmojiPickerHandle } from './EmojiPicker';
import { EmojiCompletion, EmojiOption, findEmojiCompletion, insertEmoji, normalizeEmojiAliases } from './emojiHelpers';
import type { MattermostPost } from './MattermostSpace';

export type PendingMMFile = { name: string; size: number; data_base64: string };
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
const sessionFiles = new Map<string, PendingMMFile[]>();
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
  ['B', 'Negrita · ⌘B', '**', '**', 'texto'], ['I', 'Cursiva · ⌘I', '*', '*', 'texto'],
  ['S̶', 'Tachado', '~~', '~~', 'texto'], ['H', 'Título', '\n### ', '\n', 'Título'],
  ['↗', 'Enlace · ⌘K', '[', '](https://)', 'texto'], ['‹›', 'Código', '`', '`', 'código'],
  ['❝', 'Cita', '\n> ', '\n', 'cita'], ['≡', 'Lista', '\n- ', '\n', 'elemento'],
  ['1.', 'Lista numerada', '\n1. ', '\n', 'elemento'], ['∑', 'Ecuación en línea', '$', '$', 'E = mc^2'],
  ['∫', 'Ecuación en bloque', '\n$$\n', '\n$$\n', 'E = mc^2'],
];

export default function MattermostComposer(props: Props) {
  const key = `${props.channelId}${props.rootId ? `:thread:${props.rootId}` : ''}${props.editing ? `:edit:${props.editing.id}` : ''}`;
  const [draft, setDraft] = useState(() => readDraft(key) || props.editing?.message || '');
  const [files, setFiles] = useState<PendingMMFile[]>(() => sessionFiles.get(key) ?? []);
  const [review, setReview] = useState<{ message: string; files: PendingMMFile[] } | null>(null);
  const [busy, setBusy] = useState(false), [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(true);
  const [emoji, setEmoji] = useState<{ completion: EmojiCompletion | null; start: number; end: number } | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null), picker = useRef<EmojiPickerHandle>(null);
  const emojiButton = useRef<HTMLButtonElement>(null), container = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  useEffect(() => { if (files.length) sessionFiles.set(key, files); else sessionFiles.delete(key); }, [files, key]);
  const locked = props.disabled || busy || reading;
  const update = (value: string) => { setDraft(value); saveDraft(key, value); setError(null); };
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
  const chooseFiles = async (selected: FileList | null) => {
    if (!selected?.length || locked) return;
    setError(null);
    if (files.length + selected.length > 5 || [...selected].some(f => !f.size || f.size > 8 * 1024 ** 2) || [...selected].reduce((n, f) => n + f.size, [...sessionFiles.values()].flat().reduce((n, f) => n + f.size, 0)) > 20 * 1024 ** 2) {
      setError('Máximo 5 archivos, 8 MB por archivo y 20 MB en total.'); return;
    }
    setReading(true);
    try {
      const next = await Promise.all([...selected].map(file => new Promise<PendingMMFile>((resolve, reject) => {
        const reader = new FileReader(); reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
        reader.onload = () => resolve({ name: file.name, size: file.size, data_base64: String(reader.result).split(',')[1] }); reader.readAsDataURL(file);
      })));
      setFiles(current => [...current, ...next]);
    } catch (reason) { setError(String(reason)); } finally { setReading(false); if (input.current) input.current.value = ''; }
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
  return <div className="mm-compose" ref={container} aria-label={props.rootId ? 'Responder al thread' : 'Mensaje del canal'}>
    {props.editing ? <div className="mm-compose-context">Editando tu mensaje <button disabled={busy} type="button" onClick={props.onCancelEdit}>Cancelar edición</button></div> : null}
    <textarea ref={textarea} value={draft} maxLength={16000} disabled={locked} aria-label={props.rootId ? 'Respuesta para Mattermost' : 'Mensaje para Mattermost'} placeholder={props.rootId ? 'Responder a este thread…' : `Escribe en ${props.label}…`}
      onChange={event => { update(event.target.value); const completion = findEmojiCompletion(event.target.value, event.target.selectionStart, event.target.selectionEnd); setEmoji(completion ? { completion, start: event.target.selectionStart, end: event.target.selectionEnd } : null); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (emoji && !event.metaKey && !event.ctrlKey && !event.altKey && picker.current?.handleKey(event.key)) { event.preventDefault(); event.stopPropagation(); return; }
        if (event.metaKey || event.ctrlKey) {
          const name = event.key.toLowerCase();
          if (name === 'enter') { event.preventDefault(); prepare(); }
          const entry = name === 'b' ? formats[0] : name === 'i' ? formats[1] : name === 'k' ? formats[4] : null;
          if (entry) { event.preventDefault(); event.stopPropagation(); format(entry[2], entry[3], entry[4]); }
        }
      }} />
    <div className="mm-formatbar" role="toolbar" aria-label="Formato del mensaje">
      {formats.map(([glyph, label, before, after, placeholder]) => <button key={label} title={label} aria-label={label} disabled={locked} type="button" onMouseDown={e => e.preventDefault()} onClick={() => format(before, after, placeholder)}>{glyph}</button>)}
      <span className="mm-format-spacer" />
      <button type="button" aria-label="Adjuntar archivos" title="Adjuntar archivos · hasta 8 MB cada uno" disabled={locked || Boolean(props.editing)} onClick={() => input.current?.click()}>⌁</button>
      <button type="button" ref={emojiButton} aria-label="Elegir emoji" aria-expanded={Boolean(emoji)} disabled={locked} onClick={() => setEmoji(emoji ? null : { completion: null, start: textarea.current?.selectionStart ?? draft.length, end: textarea.current?.selectionEnd ?? draft.length })}>☺</button>
      <button type="button" aria-pressed={preview} onClick={() => setPreview(v => !v)} title="Mostrar u ocultar previsualización">Aa</button>
    </div>
    <input type="file" multiple hidden ref={input} onChange={event => void chooseFiles(event.target.files)} />
    {files.length > 0 ? <ul className="mm-pending-files">{files.map((file, index) => <li key={`${file.name}:${index}`}><span>{file.name} · {(file.size / 1024).toFixed(0)} KB</span><button aria-label={`Quitar ${file.name}`} type="button" disabled={locked} onClick={() => setFiles(current => current.filter((_, i) => i !== index))}>×</button></li>)}</ul> : null}
    {preview ? <div className="mm-compose-preview" aria-label="Previsualización">{draft.trim() ? <RichText content={normalizeEmojiAliases(draft)} customEmojis={props.customEmojis} onOpenLink={url => void props.onOpenLink(url).catch(e => setError(String(e)))} /> : <span>Vista previa · Markdown y LaTeX</span>}</div> : null}
    <footer><span role="status">{error || (reading ? 'Preparando archivos…' : files.length ? 'Se subirán al confirmar el envío.' : '⌘↵ para revisar')}</span><button type="button" disabled={locked || (!draft.trim() && !files.length)} onClick={prepare}>Revisar {props.editing ? 'cambio' : props.rootId ? 'respuesta' : 'envío'} →</button></footer>
    {emoji && props.containerRef.current ? createPortal(<EmojiPicker ref={picker} channelId={props.channelId} autocompleteQuery={emoji.completion?.query ?? null} anchorRef={emojiButton} containerRef={props.containerRef} images={props.customEmojis} onRequestImages={props.onRequestImages} onSelect={pickEmoji} onClose={() => setEmoji(null)} />, props.containerRef.current) : null}
    {review ? <div className="mm-review-layer" role="dialog" aria-modal="true" aria-label="Revisar publicación">
      <section><header><span>{props.editing ? 'CONFIRMAR EDICIÓN' : 'CONFIRMAR ENVÍO'}</span><h3>{props.rootId ? `Respuesta en ${props.label}` : props.label}</h3></header>
        {props.editing ? <div className="mm-review-original"><span>Original</span><RichText content={normalizeEmojiAliases(props.editing.message)} customEmojis={props.customEmojis} /></div> : null}
        <div className="mm-review-message"><RichText content={normalizeEmojiAliases(review.message)} customEmojis={props.customEmojis} /></div>
        {review.files.length ? <ul className="mm-review-files">{review.files.map((file, i) => <li key={i}>{file.name} · {(file.size / 1024).toFixed(0)} KB</li>)}</ul> : null}
        {error ? <p className="mm-review-error" role="alert">{error}</p> : null}
        <footer><button type="button" disabled={busy} onClick={() => setReview(null)}>Volver a editar</button><button type="button" className="primary" disabled={busy} onClick={() => void send()}>{busy ? 'Publicando…' : props.editing ? 'Confirmar edición' : 'Confirmar y enviar'}</button></footer>
      </section>
    </div> : null}
  </div>;
}
