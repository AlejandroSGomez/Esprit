import { lazy, memo, Suspense } from 'react';
import type { RichTextProps } from './RichTextRenderer';

// Markdown, GFM and KaTeX are about 700 KB of JavaScript. They load on first
// use instead of at startup, and are warmed shortly after launch so the first
// rendered message rarely waits; until then the plain text is shown.
const Renderer = lazy(() => import('./RichTextRenderer'));
if (typeof window !== 'undefined') window.setTimeout(() => { void import('./RichTextRenderer'); }, 1500);

function RichText(props: RichTextProps) {
  const fallback = <div className={`rich-text${props.className ? ` ${props.className}` : ''}`} style={{ whiteSpace: 'pre-wrap' }}>{props.content}</div>;
  return <Suspense fallback={fallback}><Renderer {...props} /></Suspense>;
}

export type { RichTextProps };
export default memo(RichText);
