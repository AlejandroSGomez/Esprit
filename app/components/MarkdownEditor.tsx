'use client';

import { forwardRef, useRef } from 'react';
import ScientificEditor, { EditorImageDrop, ScientificEditorHandle } from './ScientificEditor';

export type MarkdownEditorHandle = ScientificEditorHandle;

const MarkdownEditor = forwardRef<MarkdownEditorHandle, {
  value: string;
  mode: 'live' | 'source';
  assets: Record<string, string>;
  disabled: boolean;
  onChange: (value: string) => void;
  onRequestSave: () => void;
  onImageDrop?: (drop: EditorImageDrop) => void;
  onChooseImage?: () => void;
  imageEnabled?: boolean;
  livePreviewPaused: boolean;
  onOpenLink?: (url: string) => void;
}>(function MarkdownEditor({ value, mode, assets, disabled, onChange, onRequestSave, onImageDrop, onChooseImage, imageEnabled = true, livePreviewPaused, onOpenLink }, forwardedRef) {
  const localRef = useRef<ScientificEditorHandle | null>(null);
  const setRef = (node: ScientificEditorHandle | null) => {
    localRef.current = node;
    if (typeof forwardedRef === 'function') forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  };
  const wrap = (before: string, after: string, placeholder: string) => localRef.current?.wrap(before, after, placeholder);
  const prefix = (marker: string, placeholder: string) => localRef.current?.toggleLinePrefix(marker, placeholder);

  return (
    <div className="markdown-editor-shell">
      <div className="markdown-editor-toolbar" role="toolbar" aria-label="Formato Markdown">
        <button onClick={() => prefix('# ', 'Título')} title="Título principal" disabled={disabled} type="button">H1</button>
        <button onClick={() => prefix('## ', 'Título')} title="Subtítulo" disabled={disabled} type="button">H2</button>
        <i aria-hidden="true" />
        <button onClick={() => wrap('**', '**', 'negrita')} title="Negrita · Ctrl/⌘B" disabled={disabled} type="button"><b>B</b></button>
        <button onClick={() => wrap('_', '_', 'cursiva')} title="Cursiva · Ctrl/⌘I" disabled={disabled} type="button"><em>I</em></button>
        <button onClick={() => wrap('~~', '~~', 'tachado')} title="Tachado" disabled={disabled} type="button"><s>S</s></button>
        <button onClick={() => prefix('- ', 'elemento')} title="Lista" disabled={disabled} type="button">≡</button>
        <button onClick={() => wrap('[', '](https://)', 'enlace')} title="Enlace" disabled={disabled} type="button">↗</button>
        <i aria-hidden="true" />
        <button onClick={() => wrap('$', '$', 'x^2')} title="Ecuación en línea" disabled={disabled} type="button">∑</button>
        <button onClick={() => wrap('$$\n', '\n$$', 'E = mc^2')} title="Ecuación en bloque" disabled={disabled} type="button">∫</button>
        {imageEnabled && onChooseImage && onImageDrop ? <button className="image" onClick={onChooseImage} title="Insertar imagen o arrastrarla aquí" disabled={disabled} type="button">Imagen +</button> : null}
        <span>{livePreviewPaused ? 'Vista viva pausada por tamaño · Fuente sigue editable' : 'Autocorrección local · clic en un enlace para abrirlo'}</span>
      </div>
      <ScientificEditor ref={setRef} value={value} language="markdown" mode={mode} assets={assets} disabled={disabled} ariaLabel="Editor Markdown visual" onOpenLink={onOpenLink} onChange={onChange} onRequestSave={onRequestSave} onImageDrop={imageEnabled ? onImageDrop : undefined} />
    </div>
  );
});

export default MarkdownEditor;
