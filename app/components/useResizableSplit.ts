'use client';

import { KeyboardEvent, PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

type SplitAxis = 'horizontal' | 'vertical';
export type ResizableSplit = ReturnType<typeof useResizableSplit>;

const readNumber = (key: string, fallback: number, min: number, max: number) => {
  if (typeof window === 'undefined') return fallback;
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? Math.min(max, Math.max(min, value)) : fallback;
  } catch { return fallback; }
};
const persist = (key: string, value: string) => {
  try { window.localStorage.setItem(key, value); } catch { /* Layout remains usable without storage. */ }
};

export function useResizableSplit({ storageKey, defaultValue, min, max, axis = 'vertical', collapsible = false }: {
  storageKey: string;
  defaultValue: number;
  min: number;
  max: number;
  axis?: SplitAxis;
  collapsible?: boolean;
}) {
  const clamp = useCallback((value: number) => Math.min(max, Math.max(min, value)), [max, min]);
  // El estado arranca en los valores por defecto y lo guardado se aplica
  // después de montar. Leerlo en el inicializador de `useState` no funciona:
  // el HTML pre-renderizado lleva el valor por defecto, el primer render del
  // cliente llevaría el guardado, y ante ese desajuste React conserva el
  // atributo del servidor, así que la posición guardada no llegaba nunca al
  // DOM y todos los divisores volvían a su tamaño inicial al reiniciar.
  const [value, setValue] = useState(defaultValue);
  const [collapsed, setCollapsed] = useState(false);
  const valueRef = useRef(value);
  const restoredRef = useRef(false);
  const dragCleanup = useRef<(() => void) | null>(null);
  const collapsedKey = `${storageKey}-collapsed`;

  useEffect(() => {
    let cancelled = false;
    // Un microtask, no `requestAnimationFrame`: éste queda suspendido mientras
    // la ventana está oculta, así que una ventana que arranca minimizada o en
    // otro escritorio no recuperaría su reparto hasta mostrarse.
    queueMicrotask(() => {
      if (cancelled) return;
      setValue(readNumber(storageKey, defaultValue, min, max));
      try { setCollapsed(window.localStorage.getItem(collapsedKey) === '1'); }
      catch { /* Layout remains usable without storage. */ }
      restoredRef.current = true;
    });
    return () => { cancelled = true; };
  }, [collapsedKey, defaultValue, max, min, storageKey]);

  useEffect(() => {
    valueRef.current = value;
    // Hasta que se restaura, escribir sobrescribiría lo guardado con el valor
    // por defecto de este primer render.
    if (!restoredRef.current || dragCleanup.current) return;
    persist(storageKey, String(value));
  }, [storageKey, value]);
  useEffect(() => {
    if (!restoredRef.current) return;
    persist(collapsedKey, collapsed ? '1' : '0');
  }, [collapsedKey, collapsed]);
  useEffect(() => () => dragCleanup.current?.(), []);

  const startResize = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const divider = event.currentTarget;
    const container = divider.parentElement;
    if (!container) return;
    event.preventDefault();
    dragCleanup.current?.();
    const vertical = axis === 'vertical';
    const bounds = container.getBoundingClientRect();
    const dividerBounds = divider.getBoundingClientRect();
    const start = vertical ? bounds.left : bounds.top;
    const size = vertical ? bounds.width : bounds.height;
    if (size <= 0) return;
    const grabOffset = (vertical ? event.clientX : event.clientY) - (vertical ? dividerBounds.left : dividerBounds.top);
    const { pointerId } = event;
    let frame: number | null = null;
    let next = valueRef.current;
    try { divider.setPointerCapture(pointerId); } catch { /* Window listeners also cover the gesture. */ }
    setCollapsed(false);
    document.body.dataset.splitDragging = vertical ? 'vertical' : 'horizontal';
    window.dispatchEvent(new CustomEvent('esprit:split-resize', { detail: { active: true } }));
    const flush = () => {
      frame = null;
      valueRef.current = next;
      setValue(next);
    };
    const move = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      next = clamp((((vertical ? moveEvent.clientX : moveEvent.clientY) - grabOffset - start) / size) * 100);
      if (frame === null) frame = requestAnimationFrame(flush);
    };
    const finish = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      flush();
      try { if (divider.hasPointerCapture(pointerId)) divider.releasePointerCapture(pointerId); } catch { /* Already released. */ }
      delete document.body.dataset.splitDragging;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', finish);
      dragCleanup.current = null;
      persist(storageKey, String(next));
      window.dispatchEvent(new CustomEvent('esprit:split-resize', { detail: { active: false } }));
    };
    const end = (endEvent: globalThis.PointerEvent) => { if (endEvent.pointerId === pointerId) finish(); };
    dragCleanup.current = finish;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', finish);
  }, [axis, clamp, storageKey]);

  const toggleCollapse = useCallback(() => setCollapsed((current) => !current), []);
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (collapsible && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); toggleCollapse(); return;
    }
    const negative = axis === 'vertical' ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
    const positive = axis === 'vertical' ? event.key === 'ArrowRight' : event.key === 'ArrowDown';
    if (!negative && !positive && event.key !== 'Home') return;
    event.preventDefault();
    if (collapsed) setCollapsed(false);
    setValue((current) => event.key === 'Home' ? defaultValue : clamp(current + (negative ? -2 : 2)));
  }, [axis, clamp, collapsed, collapsible, defaultValue, toggleCollapse]);

  const separatorProps = useMemo(() => ({
    role: 'separator' as const, 'aria-orientation': axis,
    'aria-valuemin': collapsed ? 0 : min, 'aria-valuemax': max,
    'aria-valuenow': collapsed ? 0 : Math.round(value), tabIndex: 0,
  }), [axis, collapsed, max, min, value]);
  return {
    value, size: collapsed ? 0 : value,
    track: (minPx: number) => collapsed ? '0px' : `minmax(var(--split-min, ${minPx}px), ${value}%)`,
    collapsed, collapsible, axis,
    setValue: (next: number) => setValue(clamp(next)), startResize, onKeyDown, toggleCollapse,
    expand: () => setCollapsed(false), reset: () => { setCollapsed(false); setValue(defaultValue); }, separatorProps,
  };
}
