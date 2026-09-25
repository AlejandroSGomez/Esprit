'use client';
/* eslint-disable @next/next/no-img-element -- native emoji previews are bounded authenticated data URLs */

import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { EmojiOption, EmojiScope, RECENT_EMOJI_KEY, recentEmojiNames, rememberEmoji, searchEmojiOptions } from './emojiHelpers';
import './EmojiPicker.css';

type CatalogPage = { names: string[]; next_page: number | null; truncated: boolean };
type Catalog = { names: string[]; nextPage: number | null; truncated: boolean; loaded: boolean; fetchedAt: number };
export type EmojiPickerHandle = { handleKey: (key: string) => boolean };
type Props = {
  channelId: string;
  autocompleteQuery: string | null;
  anchorRef: RefObject<HTMLElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  images: Record<string, string>;
  onRequestImages: (names: string[]) => void;
  onSelect: (emoji: EmojiOption) => void;
  onClose: (restoreFocus?: boolean) => void;
};
// Names only, native-memory equivalent for this WebView session. No tokens,
// messages, server response records or image URLs are persisted.
const catalogCache = new Map<string, Catalog>();

export default forwardRef<EmojiPickerHandle, Props>(function EmojiPicker({ channelId, autocompleteQuery, anchorRef, containerRef, images, onRequestImages, onSelect, onClose }, ref) {
  const [catalog, setCatalog] = useState<Catalog>(() => {
    const cached = catalogCache.get(channelId);
    return cached && Date.now() - cached.fetchedAt < 300_000 ? cached : { names: [], nextPage: 0, truncated: false, loaded: false, fetchedAt: 0 };
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<EmojiScope>('all');
  const [recent, setRecent] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [visibleStart, setVisibleStart] = useState(0);
  const [resultLimit, setResultLimit] = useState(72);
  const [placement, setPlacement] = useState({ left: 12, top: 12, width: 350, height: 350 });
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const requestRef = useRef(false);
  const id = useId();
  const search = autocompleteQuery ?? query;
  const matches = useMemo(() => searchEmojiOptions(search, catalog.names, recent, scope, 3_000), [search, catalog.names, recent, scope]);
  const options = useMemo(() => matches.slice(0, resultLimit), [matches, resultLimit]);
  const activeIndex = Math.min(selected, Math.max(0, options.length - 1));

  const loadPage = useCallback(async (page: number) => {
    if (requestRef.current) return;
    if (!('__TAURI_INTERNALS__' in window)) { setError('El catálogo personalizado está disponible dentro de Esprit.'); return; }
    requestRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<CatalogPage>('mattermost_emoji_catalog', { request: { channel_id: channelId, page } });
      if (!mountedRef.current) return;
      setCatalog((current) => {
        const next = { names: [...new Set([...(page === 0 ? [] : current.names), ...result.names])], nextPage: result.next_page, truncated: result.truncated, loaded: true, fetchedAt: Date.now() };
        catalogCache.set(channelId, next);
        if (catalogCache.size > 30) catalogCache.delete(catalogCache.keys().next().value as string);
        return next;
      });
    } catch (reason) {
      if (mountedRef.current) setError(String(reason));
    } finally {
      requestRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    mountedRef.current = true;
    const timer = window.setTimeout(() => {
      try { setRecent(recentEmojiNames(JSON.parse(localStorage.getItem(RECENT_EMOJI_KEY) ?? '[]'))); } catch { /* Optional preferences. */ }
      if (!catalog.loaded) void loadPage(0);
      if (autocompleteQuery === null) inputRef.current?.focus();
    }, 0);
    return () => { mountedRef.current = false; window.clearTimeout(timer); };
    // This picker is keyed by its composer context and mounted only while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadPage]);

  useEffect(() => {
    const position = () => {
      const container = containerRef.current?.getBoundingClientRect();
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!container || !anchor) return;
      const width = Math.min(350, container.width - 24);
      const height = Math.min(350, container.height - 24);
      const left = Math.max(12, Math.min(container.width - width - 12, anchor.right - container.left - width));
      const above = anchor.top - container.top - height - 8;
      const top = above >= 12 ? above : Math.max(12, Math.min(container.height - height - 12, anchor.bottom - container.top + 8));
      setPlacement({ left, top, width, height });
    };
    const timer = window.setTimeout(position, 0);
    const observer = new ResizeObserver(position);
    if (containerRef.current) observer.observe(containerRef.current);
    if (anchorRef.current) observer.observe(anchorRef.current);
    window.addEventListener('resize', position);
    return () => { window.clearTimeout(timer); observer.disconnect(); window.removeEventListener('resize', position); };
  }, [anchorRef, containerRef]);

  const choose = useCallback((option: EmojiOption) => {
    const next = rememberEmoji(recent, option.name);
    try { localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(next)); } catch { /* Selection still works. */ }
    onSelect(option);
  }, [onSelect, recent]);

  const handleKey = useCallback((key: string) => {
    if (key === 'Escape') { onClose(true); return true; }
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
      const delta = key === 'ArrowDown' ? 6 : key === 'ArrowUp' ? -6 : key === 'ArrowRight' ? 1 : -1;
      setSelected(key === 'Home' ? 0 : key === 'End' ? Math.max(0, options.length - 1) : Math.max(0, Math.min(options.length - 1, activeIndex + delta)));
      return true;
    }
    if (key === 'Enter') { if (options[activeIndex]) choose(options[activeIndex]); return true; }
    return false;
  }, [activeIndex, choose, onClose, options]);
  useImperativeHandle(ref, () => ({ handleKey }), [handleKey]);

  useEffect(() => {
    const node = panelRef.current?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`);
    node?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeIndex, search, scope]);

  useEffect(() => {
    // At most one existing native batch, covering only rendered options.
    const names = options.slice(visibleStart, visibleStart + 24).filter((option) => option.kind === 'custom').map((option) => option.name);
    if (names.length) onRequestImages(names);
  }, [onRequestImages, options, visibleStart]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (!panelRef.current?.contains(event.target) && !anchorRef.current?.contains(event.target)) onClose();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [anchorRef, onClose]);

  return (
    <div className="mm-emoji-picker" ref={panelRef} role="dialog" aria-label="Elegir emoji" style={{ left: placement.left, top: placement.top, width: placement.width, maxHeight: placement.height }} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (event.key !== 'Escape' && target.closest('button') && !target.closest('[data-option-index]')) return;
      // Tab follows normal focus order; arrow navigation stays in the grid.
      if (handleKey(event.key)) { event.preventDefault(); event.stopPropagation(); }
    }}>
      <header><strong>Emojis</strong><button type="button" aria-label="Cerrar selector de emojis" onClick={() => onClose(true)}>×</button></header>
      {autocompleteQuery === null ? <input ref={inputRef} value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0); setResultLimit(72); setVisibleStart(0); }} maxLength={64} placeholder="Buscar nombre: smile, corazón…" aria-label="Buscar emojis" aria-controls={`${id}-options`} aria-activedescendant={options.length ? `${id}-option-${activeIndex}` : undefined} /> : <p className="mm-emoji-completing">Completando <b>:{autocompleteQuery}</b><span>↑ ↓ elegir · Enter insertar · Esc cerrar</span></p>}
      <nav aria-label="Colección de emojis">{([['all', 'Todos'], ['recent', 'Recientes'], ['custom', 'Personalizados']] as const).map(([value, label]) => <button key={value} className={scope === value ? 'active' : ''} type="button" onClick={() => { setScope(value); setSelected(0); setResultLimit(72); setVisibleStart(0); }}>{label}</button>)}</nav>
      <div className="mm-emoji-grid" onScroll={(event) => setVisibleStart(Math.floor(event.currentTarget.scrollTop / 45) * 6)} id={`${id}-options`} role="listbox" tabIndex={0} aria-activedescendant={options.length ? `${id}-option-${activeIndex}` : undefined} aria-label="Emojis disponibles">
        {options.map((option, index) => <button key={`${option.kind}-${option.name}`} id={`${id}-option-${index}`} data-option-index={index} role="option" aria-selected={index === activeIndex} aria-label={`:${option.name}:`} title={`:${option.name}:`} tabIndex={-1} className={index === activeIndex ? 'active' : ''} type="button" onPointerDown={(event) => event.preventDefault()} onClick={() => choose(option)}>{option.kind === 'unicode' ? <span>{option.value}</span> : images[option.name] ? <img src={images[option.name]} alt="" /> : <span className="mm-emoji-placeholder">:{option.name}:</span>}</button>)}
        {options.length < matches.length ? <button className="mm-emoji-more" type="button" onClick={() => setResultLimit((value) => value + 72)}>Mostrar más resultados ({matches.length})</button> : null}
        {!options.length ? <p>{scope === 'recent' ? 'Aún no hay recientes que coincidan.' : scope === 'custom' && loading ? 'Leyendo nombres personalizados…' : 'No hay coincidencias entre los emojis cargados.'}</p> : null}
      </div>
      <p className="mm-emoji-announcement" aria-live="polite">{options[activeIndex] ? `:${options[activeIndex].name}:` : 'Sin coincidencias'}</p>
      <footer aria-live="polite">{error ? <p className="mm-emoji-error">{error} <button type="button" onClick={() => void loadPage(catalog.nextPage ?? 0)}>Reintentar</button></p> : loading ? <p>Cargando catálogo personalizado…</p> : <p>{catalog.loaded ? `${catalog.names.length} personalizados cargados · ${matches.length} coincidencias` : 'Unicode disponible sin conexión'}</p>}{catalog.nextPage !== null && catalog.loaded && !error ? <button type="button" disabled={loading} onClick={() => void loadPage(catalog.nextPage!)}>Cargar más personalizados</button> : null}{catalog.loaded && !loading ? <button type="button" onClick={() => void loadPage(0)}>Actualizar personalizados</button> : null}{catalog.truncated ? <p>Se alcanzó el límite de 2.000 nombres; el catálogo puede estar incompleto.</p> : null}</footer>
    </div>
  );
});
