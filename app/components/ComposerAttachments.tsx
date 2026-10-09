'use client';

import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import FileTypeIcon from './FileTypeIcon';
import PdfViewer from './PdfViewer';
import {
  formatBytes, insertText, isImageFile, isPdfFile, isTextFile, limitProblem, mimeFor, pasteMayCarryFiles,
  pastedName, readBrowserFile, textOnlyNamesFiles, type ComposerFile, type ComposerLimits,
} from '../composerFiles';

const dataUrl = (file: ComposerFile) => `data:${file.mime};base64,${file.data_base64}`;
const decodeText = (base64: string) => { try { return new TextDecoder().decode(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))); } catch { return ''; } };

/**
 * Paste, drop and choose files for one composer. `accept` receives files that
 * already passed the limits; `problem` explains the ones that did not.
 */
export function useComposerFiles({ pending, limits, disabled, accept, problem, text }: {
  pending: ComposerFile[]; limits: ComposerLimits; disabled?: boolean;
  accept: (files: ComposerFile[]) => void; problem: (message: string | null) => void;
  /** The composer's text and setter, so a rich paste that turns out to be text still lands. */
  text: { value: string; set: (value: string, cursor: number) => void };
}) {
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const latest = useRef({ pending, text, accept, problem });
  useEffect(() => { latest.current = { pending, text, accept, problem }; });

  const addBrowserFiles = async (files: File[], pasted: boolean) => {
    const now = new Date();
    const named = files.map((file, index) => ({ file, name: pasted ? pastedName(file.name, mimeFor(file.name, file.type), index, now) : file.name }));
    const blocked = limitProblem(latest.current.pending, named.map(({ file, name }) => ({ size: file.size, name })), limits);
    if (blocked) { latest.current.problem(blocked); return; }
    setReading(true);
    try { latest.current.accept(await Promise.all(named.map(({ file, name }) => readBrowserFile(file, name)))); latest.current.problem(null); }
    catch (reason) { latest.current.problem(String(reason instanceof Error ? reason.message : reason)); }
    finally { setReading(false); }
  };

  /** Text keeps the field's own undo history; the setter is only a fallback. */
  const typeText = (field: HTMLTextAreaElement, start: number, end: number, pasted: string) => {
    field.focus();
    field.setSelectionRange(start, end);
    if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, pasted)) return;
    const { value, set } = latest.current.text;
    const next = insertText(value, start, end, pasted);
    set(next.value, next.cursor);
  };

  const onKeyDown = (_event: ReactKeyboardEvent<HTMLTextAreaElement>) => { void _event; return false; };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return;
    const data = event.clipboardData;
    const files = [...data.files];
    if (!pasteMayCarryFiles([...data.types], files.length, data.getData('text/uri-list'))) return;
    // A rich text copy (Word, Excel) also carries a picture of itself: then the text wins.
    event.preventDefault();
    const pastedText = data.getData('text/plain');
    const field = event.currentTarget;
    const start = field.selectionStart, end = field.selectionEnd;
    if (files.length && textOnlyNamesFiles(pastedText, files.map((file) => file.name))) void addBrowserFiles(files, true);
    else if (pastedText) typeText(field, start, end, pastedText);
  };

  const dropProps = {
    onDragOver: (event: DragEvent<HTMLElement>) => { if (disabled || ![...event.dataTransfer.types].includes('Files')) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true); },
    onDragLeave: (event: DragEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); },
    onDrop: (event: DragEvent<HTMLElement>) => { if (![...event.dataTransfer.types].includes('Files')) return; event.preventDefault(); setDragging(false); if (!disabled) void addBrowserFiles([...event.dataTransfer.files], false); },
  };

  return { onPaste, onKeyDown, dropProps, dragging, reading, choose: (files: FileList | null) => { if (files?.length && !disabled) void addBrowserFiles([...files], false); } };
}

const pdfThumbnails = new Map<string, string>();
async function pdfThumbnail(file: ComposerFile): Promise<string> {
  const cached = pdfThumbnails.get(file.id);
  if (cached) return cached;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  const task = pdfjs.getDocument({ data: Uint8Array.from(atob(file.data_base64), (character) => character.charCodeAt(0)) });
  try {
    const page = await (await task.promise).getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 180 / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) return '';
    await page.render({ canvas: null, canvasContext: context, viewport, background: '#ffffff' }).promise;
    const url = canvas.toDataURL('image/png');
    pdfThumbnails.set(file.id, url);
    return url;
  } finally { void task.destroy(); }
}

function Thumbnail({ file }: { file: ComposerFile }) {
  const [pdf, setPdf] = useState<{ id: string; url: string } | null>(() => pdfThumbnails.has(file.id) ? { id: file.id, url: pdfThumbnails.get(file.id)! } : null);
  useEffect(() => {
    if (!isPdfFile(file) || pdfThumbnails.has(file.id)) return;
    let cancelled = false;
    void pdfThumbnail(file).then((url) => { if (!cancelled && url) setPdf({ id: file.id, url }); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [file]);
  const source = isImageFile(file) ? dataUrl(file) : pdf?.id === file.id ? pdf.url : null;
  // Local data URIs: nothing for next/image to optimise.
  // eslint-disable-next-line @next/next/no-img-element
  return source ? <img src={source} alt="" draggable={false} /> : <FileTypeIcon kind="file" name={file.name} />;
}

/** The pending files as cards with a thumbnail; a click opens the full preview. */
export function AttachmentTray({ files, onRemove, disabled, compact, inline }: { files: ComposerFile[]; onRemove?: (id: string) => void; disabled?: boolean; compact?: boolean; inline?: boolean }) {
  const [open, setOpen] = useState<ComposerFile | null>(null);
  if (!files.length) return null;
  return <>
    <ul className={`composer-files${compact ? ' compact' : ''}${inline ? ' inline' : ''}`} aria-label="Adjuntos">
      {files.map((file) => <li key={file.id} className={isImageFile(file) || isPdfFile(file) ? 'visual' : ''}>
        <button type="button" className="composer-file-open" onClick={() => setOpen(file)} title={`Ver ${file.name}`}>
          <span className="composer-file-thumb"><Thumbnail file={file} /></span>
          <span className="composer-file-label"><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></span>
        </button>
        {onRemove ? <button type="button" className="composer-file-remove" aria-label={`Quitar ${file.name}`} disabled={disabled} onClick={() => onRemove(file.id)}>×</button> : null}
      </li>)}
    </ul>
    {open ? <AttachmentPreview file={open} onClose={() => setOpen(null)} /> : null}
  </>;
}

function AttachmentPreview({ file, onClose }: { file: ComposerFile; onClose: () => void }) {
  // Capture Escape before the app's shortcuts close the whole composer.
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onClose(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  return createPortal(<div className="mail-preview-layer composer-preview-layer" role="dialog" aria-modal="true" aria-label={`Vista previa de ${file.name}`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section>
      <header><strong>{file.name}</strong><small>{formatBytes(file.size)} · se enviará al confirmar</small><button type="button" autoFocus onClick={onClose} aria-label="Cerrar">×</button></header>
      <div className="mail-preview-body">
        {isPdfFile(file) ? <PdfViewer dataBase64={file.data_base64} name={file.name} documentKey={`composer:${file.id}`} />
          // eslint-disable-next-line @next/next/no-img-element
          : isImageFile(file) ? <img src={dataUrl(file)} alt={file.name} />
          : isTextFile(file) ? <pre>{decodeText(file.data_base64).slice(0, 200_000)}</pre>
          : <div className="composer-preview-none"><FileTypeIcon kind="file" name={file.name} /><p>Sin vista previa para este tipo de archivo.</p></div>}
      </div>
    </section>
  </div>, document.body);
}
