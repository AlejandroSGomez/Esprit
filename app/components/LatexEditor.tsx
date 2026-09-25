'use client';

import { forwardRef, useRef } from 'react';
import ScientificEditor, { EditorImageDrop, ScientificEditorHandle } from './ScientificEditor';

export type LatexEditorHandle = ScientificEditorHandle;

const LatexEditor = forwardRef<LatexEditorHandle, {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onRequestSave: () => void;
  onRequestCompile: () => void;
  onImageDrop: (drop: EditorImageDrop) => void;
  onChooseImage: () => void;
  imageEnabled: boolean;
}>(function LatexEditor({ value, disabled, onChange, onRequestSave, onRequestCompile, onImageDrop, onChooseImage, imageEnabled }, forwardedRef) {
  const localRef = useRef<ScientificEditorHandle | null>(null);
  const setRef = (node: ScientificEditorHandle | null) => {
    localRef.current = node;
    if (typeof forwardedRef === 'function') forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  };
  const wrap = (before: string, after: string, placeholder: string) => localRef.current?.wrap(before, after, placeholder);

  return (
    <div className="latex-editor-shell">
      <div className="latex-editor-toolbar" role="toolbar" aria-label="Ayudas LaTeX">
        <button onClick={() => wrap('\\section{', '}', 'Título')} disabled={disabled} type="button">Sección</button>
        <button onClick={() => wrap('\\textbf{', '}', 'texto')} disabled={disabled} type="button"><b>B</b></button>
        <button onClick={() => wrap('\\emph{', '}', 'texto')} disabled={disabled} type="button"><em>I</em></button>
        <button onClick={() => wrap('\\begin{equation}\n', '\n\\end{equation}', 'E = mc^2')} disabled={disabled} type="button">Ecuación</button>
        <button onClick={() => wrap('\\cite{', '}', 'clave')} disabled={disabled} type="button">Cita</button>
        <button onClick={() => wrap('\\ref{', '}', 'etiqueta')} disabled={disabled} type="button">Referencia</button>
        {imageEnabled ? <button className="image" onClick={onChooseImage} title="Copiar e insertar imagen" disabled={disabled} type="button">Imagen</button> : null}
        <span>Ctrl/⌘↵ compila · {imageEnabled ? 'arrastra imágenes · ' : ''}completado local</span>
      </div>
      <ScientificEditor ref={setRef} value={value} language="latex" disabled={disabled} ariaLabel="Editor LaTeX" onChange={onChange} onRequestSave={onRequestSave} onRequestCompile={onRequestCompile} onImageDrop={imageEnabled ? onImageDrop : undefined} />
    </div>
  );
});

export default LatexEditor;
