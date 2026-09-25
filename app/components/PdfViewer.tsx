'use client';

import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask, TextLayer } from 'pdfjs-dist';
import { CSSProperties, useCallback, useEffect, useMemo, useLayoutEffect, useRef, useState } from 'react';
import { findPdfTextMatches, joinPdfText, readPdfReadingState, savePdfReadingState, type PdfReadingState, type TextMatch } from './pdfReadingState';
import { pdfSearchSummary, pdfTextFailureMessage, readPdfTextContent } from './pdfTextContent';
import './pdfReading.css';

type FitMode = 'width' | 'page' | null;
type PageSize = { width: number; height: number };
type SearchMatch = TextMatch & { page: number };
const MAX_RENDERED_PAGES = 5;
const MAX_CANVAS_PIXELS = 6_000_000;
const MAX_CANVAS_DIMENSION = 4_096;
const clampScale = (value: number) => Math.min(3, Math.max(.45, value));
const clampFitScale = (value: number) => Math.min(3, Math.max(.005, value));
const decodePdf = (value: string) => {
  const binary = window.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

function paintMatches(layer: TextLayer, query: string, selected: TextMatch | undefined) {
  const strings = layer.textContentItemsStr;
  const { text, offsets } = joinPdfText(strings);
  const matches = findPdfTextMatches(text, query);
  layer.textDivs.forEach((div, index) => {
    const content = strings[index];
    const from = offsets[index];
    div.replaceChildren();
    let cursor = 0;
    for (const match of matches) {
      const start = Math.max(0, match.start - from);
      const end = Math.min(content.length, match.end - from);
      if (end <= start || start >= content.length) continue;
      div.appendChild(document.createTextNode(content.slice(cursor, start)));
      const highlight = document.createElement('span');
      highlight.className = `pdf-text-match${selected?.start === match.start && selected.end === match.end ? ' selected' : ''}`;
      highlight.textContent = content.slice(start, end);
      div.appendChild(highlight);
      cursor = end;
    }
    div.appendChild(document.createTextNode(content.slice(cursor)));
  });
}

function PdfPageCanvas({ document: pdf, name, pageNumber, scale, size, active, query, selected }: {
  document: PDFDocumentProxy; name: string; pageNumber: number; scale: number; size: PageSize; active: boolean; query: string; selected?: TextMatch;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<TextLayer | null>(null);
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [textVersion, setTextVersion] = useState(0);
  const [textError, setTextError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const textAbort = new AbortController();
    let task: RenderTask | null = null;
    let layer: TextLayer | null = null;
    void pdf.getPage(pageNumber).then(async (page) => {
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      setRendering(true);
      setError(null);
      setTextError(null);
      const width = Math.max(1, size.width * scale);
      const height = Math.max(1, size.height * scale);
      const rasterRatio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_CANVAS_PIXELS / (width * height)), MAX_CANVAS_DIMENSION / width, MAX_CANVAS_DIMENSION / height);
      const viewport = page.getViewport({ scale: scale * rasterRatio });
      // Render offscreen: resizing never erases the previous completed bitmap.
      const buffer = window.document.createElement('canvas');
      buffer.width = Math.max(1, Math.floor(viewport.width));
      buffer.height = Math.max(1, Math.floor(viewport.height));
      const context = buffer.getContext('2d', { alpha: false });
      if (!context) throw new Error('Canvas no disponible');
      task = page.render({ canvas: null, canvasContext: context, viewport, background: '#ffffff' });
      await task.promise;
      if (cancelled) return;
      canvas.width = buffer.width;
      canvas.height = buffer.height;
      canvas.getContext('2d', { alpha: false })?.drawImage(buffer, 0, 0);
      try {
        const host = textRef.current;
        if (host) {
          const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
          const content = await readPdfTextContent(page, textAbort.signal);
          if (cancelled) return;
          const container = window.document.createElement('div');
          container.className = 'esprit-pdf-text';
          container.style.setProperty('--total-scale-factor', String(scale));
          container.style.setProperty('--scale-round-x', '1px');
          container.style.setProperty('--scale-round-y', '1px');
          layer = new pdfjs.TextLayer({ textContentSource: content, container, viewport: page.getViewport({ scale }) });
          await layer.render();
          if (cancelled) return;
          host.replaceChildren(container);
          textLayerRef.current = layer;
          setTextVersion((current) => current + 1);
        }
      } catch (reason) { if (!cancelled) setTextError(pdfTextFailureMessage(reason)); }
      page.cleanup();
    }).then(() => { if (!cancelled) setRendering(false); }).catch((reason) => {
      if (cancelled || String(reason).includes('RenderingCancelledException')) return;
      setError(`No se pudo completar la página ${pageNumber}: ${String(reason)}`);
      setRendering(false);
    });
    return () => { cancelled = true; textAbort.abort(); task?.cancel(); layer?.cancel(); };
  }, [pdf, pageNumber, scale, size.height, size.width, active]);
  useEffect(() => {
    if (active) return;
    // Fast switches keep the bitmap. Longer inactive workspaces release raster memory.
    const timer = setTimeout(() => {
      const canvas = canvasRef.current;
      if (canvas) { canvas.width = 1; canvas.height = 1; }
      textRef.current?.replaceChildren();
      textLayerRef.current = null;
    }, 500);
    return () => clearTimeout(timer);
  }, [active]);
  useEffect(() => {
    if (textLayerRef.current) paintMatches(textLayerRef.current, query, selected);
  }, [query, selected, textVersion]);
  return <>
    <canvas ref={canvasRef} aria-label={`Página ${pageNumber} de ${name}`} />
    <div className="esprit-pdf-text-host" ref={textRef} />
    {rendering && active ? <i className="pdf-rendering" /> : null}
    {textError && active ? <span className="pdf-text-unavailable">{textError}</span> : null}
    {error ? <div className="pdf-page-error"><span>!</span><p>{error}</p></div> : null}
  </>;
}

export default function PdfViewer({ dataBase64, name, active: requestedActive = true, storageKey, documentKey }: {
  dataBase64: string; name: string; active?: boolean; storageKey?: string; documentKey?: string;
}) {
  const [windowVisible, setWindowVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  const active = requestedActive && windowVisible;
  useEffect(() => {
    const changed = () => setWindowVisible(!document.hidden);
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  const fingerprint = useMemo(() => { let hash = 2166136261; const step = Math.max(1, Math.floor(dataBase64.length / 256)); for (let index = 0; index < dataBase64.length; index += step) hash = Math.imul(hash ^ dataBase64.charCodeAt(index), 16777619); return `${dataBase64.length}.${hash >>> 0}`; }, [dataBase64]);
  const key = storageKey ?? documentKey ?? `pdf:${name}:${fingerprint}`;
  const initial = useMemo(() => readPdfReadingState(key), [key]);
  const [hasActivated, setHasActivated] = useState(active);
  if (active && !hasActivated) setHasActivated(true);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageSizes, setPageSizes] = useState<PageSize[]>([]);
  const [pageNumber, setPageNumber] = useState(initial?.page ?? 1);
  const [scale, setScale] = useState(initial?.scale ?? 1.1);
  const [fitMode, setFitMode] = useState<FitMode>(initial ? initial.fit : 'width');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [rasterViewport, setRasterViewport] = useState(viewportSize);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [matchIndex, setMatchIndex] = useState(0);
  const [searchStatus, setSearchStatus] = useState('');
  const [searchBusy, setSearchBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const scrollFrame = useRef<number | null>(null);
  const restored = useRef(false);
  const activeRef = useRef(active);
  useLayoutEffect(() => { activeRef.current = active; }, [active]);
  const readingRef = useRef<PdfReadingState>({ page: pageNumber, scale, fit: fitMode, offset: initial?.offset ?? 0 });
  useLayoutEffect(() => { readingRef.current = { ...readingRef.current, page: pageNumber, scale, fit: fitMode }; }, [pageNumber, scale, fitMode]);
  const textCache = useRef(new Map<number, string>());
  const inspectedPages = useRef(new Set<number>());
  const completedSearch = useRef<{ document: PDFDocumentProxy; query: string } | null>(null);
  const readingKeyRef = useRef(key);

  useEffect(() => {
    if (!hasActivated) return;
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    const saved = readPdfReadingState(key);
    restored.current = false;
    textCache.current.clear();
    inspectedPages.current.clear();
    completedSearch.current = null;
    void import('pdfjs-dist/legacy/build/pdf.mjs').then(async (pdfjs) => {
      if (cancelled) return;
      setPdf(null); setPageSizes([]); setLoading(true); setError(null);
      setPageNumber(saved?.page ?? 1); setScale(saved?.scale ?? 1.1); setFitMode(saved ? saved.fit : 'width');
      readingKeyRef.current = key;
      readingRef.current = saved ?? { page: 1, scale: 1.1, fit: 'width', offset: 0 };
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
      task = pdfjs.getDocument({ data: decodePdf(dataBase64) });
      const loaded = await task.promise;
      const page = await loaded.getPage(1);
      const size = page.getViewport({ scale: 1 });
      if (cancelled) return;
      if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0 || size.width > 20_000 || size.height > 20_000) throw new Error('Dimensiones PDF no admitidas.');
      setPdf(loaded);
      setPageNumber(Math.min(saved?.page ?? 1, loaded.numPages));
      setPageSizes(Array.from({ length: loaded.numPages }, () => ({ width: size.width, height: size.height })));
      setLoading(false);
      inspectedPages.current.add(1);
      page.cleanup();
    }).catch((reason) => { if (!cancelled) { setError(`No se pudo abrir el PDF: ${String(reason)}`); setLoading(false); } });
    return () => { cancelled = true; savePdfReadingState(readingKeyRef.current, readingRef.current); void task?.destroy(); };
  }, [dataBase64, key, hasActivated]);

  useEffect(() => {
    if (!pdf || !active) return;
    let cancelled = false;
    void (async () => {
      for (let start = 1; start <= pdf.numPages; start += 6) {
        if (cancelled) return;
        const indexes = Array.from({ length: Math.min(6, pdf.numPages - start + 1) }, (_, offset) => start + offset).filter((number) => !inspectedPages.current.has(number));
        if (!indexes.length) continue;
        const batch = await Promise.all(indexes.map(async (number) => {
          const page = await pdf.getPage(number);
          const viewport = page.getViewport({ scale: 1 });
          page.cleanup();
          if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0 || viewport.width > 20_000 || viewport.height > 20_000) throw new Error(`Dimensiones no admitidas en página ${number}.`);
          return { number, size: { width: viewport.width, height: viewport.height } };
        }));
        if (cancelled) return;
        batch.forEach(({ number }) => inspectedPages.current.add(number));
        setPageSizes((current) => { const next = [...current]; batch.forEach(({ number, size }) => { next[number - 1] = size; }); return next; });
      }
    })().catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [pdf, active]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !active) return;
    let frame: number | null = null;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const next = { width: viewport.clientWidth, height: viewport.clientHeight };
        if (!next.width || !next.height) return;
        setViewportSize((current) => current.width === next.width && current.height === next.height ? current : next);
        if (settle) clearTimeout(settle);
        if (!document.body.dataset.splitDragging) settle = setTimeout(() => setRasterViewport(next), 120);
      });
    };
    const split = () => { if (!document.body.dataset.splitDragging) measure(); };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport); measure();
    window.addEventListener('esprit:split-resize', split);
    return () => { observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame); if (settle) clearTimeout(settle); window.removeEventListener('esprit:split-resize', split); };
  }, [active]);

  const scaleFor = useCallback((size: PageSize, viewport = viewportSize) => {
    const width = Math.max(1, viewport.width - 44);
    const height = Math.max(1, viewport.height - 44);
    return fitMode === 'width' ? clampFitScale(width / size.width) : fitMode === 'page' ? clampFitScale(Math.min(width / size.width, height / size.height)) : clampScale(scale);
  }, [fitMode, scale, viewportSize]);
  const effectiveScale = pageSizes[pageNumber - 1] ? scaleFor(pageSizes[pageNumber - 1]) : scale;

  const goToPage = useCallback((target: number, smooth = true) => {
    const next = Math.max(1, Math.min(pdf?.numPages ?? target, target));
    setPageNumber(next);
    const viewport = viewportRef.current;
    const page = pageRefs.current.get(next);
    if (!viewport || !page) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    viewport.scrollTo({ top: Math.max(0, page.offsetTop - 18), behavior: smooth && !reduced ? 'smooth' : 'auto' });
  }, [pdf]);
  useEffect(() => {
    if (!active || !pdf || !viewportSize.width || restored.current || (pageNumber > 1 && !inspectedPages.current.has(pageNumber - 1))) return;
    const frame = requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      const page = pageRefs.current.get(pageNumber);
      if (!viewport || !page) return;
      viewport.scrollTop = Math.max(0, page.offsetTop + page.offsetHeight * (readingRef.current.offset ?? 0) - 18);
      restored.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [active, pageNumber, pdf, viewportSize.width, pageSizes]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !active || !pdf) return;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (!restored.current || scrollFrame.current !== null) return;
      scrollFrame.current = requestAnimationFrame(() => {
        scrollFrame.current = null;
        const middle = viewport.scrollTop + Math.min(viewport.clientHeight / 2, 100);
        let low = 1; let high = pageRefs.current.size;
        while (low < high) {
          const pivot = Math.ceil((low + high) / 2);
          const node = pageRefs.current.get(pivot);
          if (node && node.offsetTop <= middle) low = pivot; else high = pivot - 1;
        }
        const node = pageRefs.current.get(low);
        setPageNumber(low);
        readingRef.current = { ...readingRef.current, page: low, offset: node ? Math.max(0, (viewport.scrollTop + 18 - node.offsetTop) / node.offsetHeight) : 0 };
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => savePdfReadingState(key, readingRef.current), 400);
      });
    };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => { viewport.removeEventListener('scroll', onScroll); if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current); scrollFrame.current = null; if (saveTimer) clearTimeout(saveTimer); if (restored.current && readingKeyRef.current === key) savePdfReadingState(key, readingRef.current); };
  }, [active, pdf, key]);
  useEffect(() => {
    if (!restored.current) return;
    const timer = setTimeout(() => savePdfReadingState(key, readingRef.current), 400);
    return () => clearTimeout(timer);
  }, [key, fitMode, scale, pageNumber]);

  useEffect(() => {
    const save = () => { if (restored.current) savePdfReadingState(readingKeyRef.current, readingRef.current); };
    window.addEventListener('pagehide', save);
    window.addEventListener('beforeunload', save);
    return () => { save(); window.removeEventListener('pagehide', save); window.removeEventListener('beforeunload', save); };
  }, []);
  useEffect(() => {
    if (active || !pdf) return;
    const timer = setTimeout(() => { textCache.current.clear(); void pdf.cleanup().catch(() => undefined); }, 600);
    return () => clearTimeout(timer);
  }, [active, pdf]);

  useEffect(() => {
    if (!active || !pdf || !query.trim()) return;
    if (completedSearch.current?.document === pdf && completedSearch.current.query === query) return;
    let cancelled = false;
    const textAbort = new AbortController();
    const timer = setTimeout(async () => {
      setSearchBusy(true); setSearchMatches([]); setMatchIndex(0); setSearchStatus('Buscando en el documento…');
      const found: SearchMatch[] = [];
      let characters = 0;
      let pages = 0;
      let failures = 0;
      try {
        for (let pageNumber = 1; pageNumber <= Math.min(pdf.numPages, 500); pageNumber += 1) {
          if (cancelled || !activeRef.current) return;
          let text = textCache.current.get(pageNumber);
          if (text === undefined) {
            try {
              const page = await pdf.getPage(pageNumber);
              const content = await readPdfTextContent(page, textAbort.signal);
              page.cleanup();
              text = joinPdfText(content.items.flatMap((item) => 'str' in item ? [item.str] : [])).text.slice(0, 200_000);
              if (cancelled) return;
              if (textCache.current.size < 100) textCache.current.set(pageNumber, text);
            } catch { failures += 1; continue; }
          }
          characters += text.length;
          pages += 1;
          found.push(...findPdfTextMatches(text, query, 500 - found.length).map((match) => ({ ...match, page: pageNumber })));
          if (found.length >= 500 || characters >= 3_000_000) break;
          if (pageNumber % 8 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        if (cancelled) return;
        if (!failures) completedSearch.current = { document: pdf, query };
        setSearchMatches(found);
        setSearchStatus(pdfSearchSummary(found.length, pages, failures, pdf.numPages, characters));
        if (found[0]) goToPage(found[0].page, false);
      } finally { if (!cancelled) setSearchBusy(false); }
    }, 220);
    return () => { cancelled = true; textAbort.abort(); clearTimeout(timer); };
  }, [active, pdf, query, goToPage]);
  const selectedMatch = query.trim() ? searchMatches[matchIndex] : undefined;
  const advanceMatch = (delta: number) => {
    if (!searchMatches.length) return;
    const next = (matchIndex + delta + searchMatches.length) % searchMatches.length;
    setMatchIndex(next); goToPage(searchMatches[next].page);
  };
  const zoom = (delta: number) => { setFitMode(null); setScale(clampScale(effectiveScale + delta)); };
  const radius = Math.floor(MAX_RENDERED_PAGES / 2);
  return <div tabIndex={0} className={`pdf-viewer${searchOpen ? ' with-search' : ''}`} aria-label={`Visor PDF de ${name}`} ref={rootRef} onKeyDown={(event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); setSearchOpen(true); requestAnimationFrame(() => rootRef.current?.querySelector<HTMLInputElement>('.pdf-search-input')?.focus()); }
    else if (event.key === 'Escape' && searchOpen) { event.preventDefault(); event.stopPropagation(); setSearchOpen(false); setQuery(''); }
  }}>
    <div className="pdf-toolbar">
      <div className="pdf-page-controls">
        <button onClick={() => goToPage(pageNumber - 1)} disabled={!pdf || pageNumber <= 1} type="button" aria-label="Página anterior">←</button>
        <label><input className="pdf-page-input" type="number" min={1} max={pdf?.numPages ?? 1} value={pageNumber} onChange={(event) => { const next = Number(event.target.value); if (Number.isInteger(next) && next > 0) goToPage(next, false); }} aria-label="Ir a página" /> / {pdf?.numPages ?? '—'}</label>
        <button onClick={() => goToPage(pageNumber + 1)} disabled={!pdf || pageNumber >= pdf.numPages} type="button" aria-label="Página siguiente">→</button>
      </div>
      <div className="pdf-zoom-controls">
        <button onClick={() => { setSearchOpen((current) => !current); if (searchOpen) setQuery(''); }} disabled={!pdf} type="button" aria-label="Buscar en PDF" title="Buscar texto · Ctrl/⌘F">⌕</button>
        <button onClick={() => zoom(-.18)} disabled={!pdf || effectiveScale <= .45} type="button" aria-label="Alejar PDF">−</button><span>{Math.round(effectiveScale * 100)}%</span>
        <button onClick={() => zoom(.18)} disabled={!pdf || effectiveScale >= 3} type="button" aria-label="Acercar PDF">＋</button>
        <button className={fitMode === 'width' ? 'active' : ''} onClick={() => setFitMode('width')} disabled={!pdf} type="button">Ancho</button>
        <button className={fitMode === 'page' ? 'active' : ''} onClick={() => setFitMode('page')} disabled={!pdf} type="button">Página</button>
      </div>
    </div>
    {searchOpen ? <div className="pdf-search-bar"><input className="pdf-search-input" autoFocus value={query} maxLength={160} onChange={(event) => { completedSearch.current = null; setQuery(event.target.value); setSearchMatches([]); setSearchStatus(''); setSearchBusy(false); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); advanceMatch(event.shiftKey ? -1 : 1); } }} placeholder="Buscar texto" aria-label="Texto que buscar en PDF" /><span role="status">{query.trim() ? searchBusy ? 'Buscando…' : `${selectedMatch ? `${matchIndex + 1} / ` : ''}${searchStatus}` : 'Texto seleccionable · Enter: siguiente'}</span><button onClick={() => advanceMatch(-1)} disabled={!searchMatches.length} aria-label="Coincidencia anterior" type="button">↑</button><button onClick={() => advanceMatch(1)} disabled={!searchMatches.length} aria-label="Coincidencia siguiente" type="button">↓</button><button onClick={() => { setSearchOpen(false); setQuery(''); }} aria-label="Cerrar búsqueda PDF" type="button">×</button></div> : null}
    <div className="pdf-canvas-viewport" ref={viewportRef}>
      {loading ? <div className="pdf-state"><i />Cargando documento…</div> : null}
      {error ? <div className="pdf-state error"><span>!</span><p>{error}</p></div> : null}
      {!loading && !error && pdf ? <div className="pdf-pages">{pageSizes.map((size, index) => {
        const number = index + 1;
        const displayScale = scaleFor(size);
        const rasterScale = Math.max(.005, Math.round(scaleFor(size, rasterViewport.width ? rasterViewport : viewportSize) * 40) / 40);
        return <div className={`pdf-canvas-sheet${number === pageNumber ? ' active' : ''}`} ref={(node) => { if (node) pageRefs.current.set(number, node); else pageRefs.current.delete(number); }} style={{ width: `${Math.floor(size.width * displayScale)}px`, height: `${Math.floor(size.height * displayScale)}px`, '--pdf-text-display-scale': displayScale / rasterScale } as CSSProperties} data-page={number} key={number}>
          <span className="pdf-page-label">{number}</span>
          {Math.abs(number - pageNumber) <= radius ? <PdfPageCanvas document={pdf} name={name} pageNumber={number} scale={rasterScale} size={size} active={active && viewportSize.width > 0} query={query} selected={selectedMatch?.page === number ? selectedMatch : undefined} /> : <div className="pdf-page-placeholder" aria-label={`Página ${number} pendiente de renderizado`} />}
        </div>;
      })}</div> : null}
    </div>
  </div>;
}
