'use client';

import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

export const isHtmlFile = (name: string) => /\.html?$/i.test(name);

// An opaque origin is essential: never add allow-same-origin to the sandbox.
// The policy precedes the document, including any user-supplied CSP or base.
export function htmlPreviewDocument(content: string, webResources = false): string {
  const web = webResources ? ' https:' : '';
  const policy = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:${web}; style-src 'unsafe-inline'${web}; img-src data: blob:${web}; font-src data:${web}; media-src data: blob:; connect-src 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri https://html-preview.invalid; form-action 'none'`;
  return `<!doctype html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><base href="https://html-preview.invalid/"></head>${content}`;
}

const HTML_HINT = 'Los gráficos y scripts incorporados funcionan aquí. Los archivos locales enlazados y las consultas a servidores requieren un HTML autocontenido.';

/** With `toolsSlot`, the controls join the document bar instead of adding their own rows. */
export default function HtmlViewer({ content, name, active, toolsSlot = null }: { content: string; name: string; active: boolean; toolsSlot?: HTMLElement | null }) {
  const [webResources, setWebResources] = useState(false);
  const [revision, setRevision] = useState(0);
  const [opened, setOpened] = useState(active);
  if (active && !opened) setOpened(true);
  const document = useMemo(() => htmlPreviewDocument(content, webResources), [content, webResources]);
  const controls = <>
    <label title="Permite cargar bibliotecas, estilos e imágenes HTTPS del documento"><input type="checkbox" checked={webResources} onChange={(event) => setWebResources(event.target.checked)} />Recursos web</label>
    <button type="button" title={HTML_HINT} onClick={() => setRevision((value) => value + 1)}>Recargar</button>
  </>;
  return <div className="project-html-viewer">
    {toolsSlot ? createPortal(controls, toolsSlot) : <div className="project-html-toolbar">
      <span>HTML interactivo</span>
      {controls}
    </div>}
    {opened ? <iframe hidden={!active} key={revision} title={`Vista previa de ${name}`} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={document} /> : <div className="project-empty"><p>La vista HTML se reanudará al volver al proyecto.</p></div>}
    {toolsSlot ? null : <small className="project-html-hint">{HTML_HINT}</small>}
  </div>;
}
