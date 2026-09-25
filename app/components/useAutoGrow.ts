'use client';

import { RefObject, useLayoutEffect } from 'react';

type AutoGrowOptions = {
  /** Altura mínima en píxeles: normalmente una línea. */
  minHeight: number;
  /** Tope en píxeles. A partir de ahí el textarea se desplaza en vertical. */
  maxHeight: number;
  /**
   * Con `false` el textarea se mantiene colapsado en `minHeight` aunque tenga
   * contenido. Sirve para superficies que se expanden sobre otra cosa y no
   * deben quedarse grandes cuando ya nadie está escribiendo en ellas.
   */
  expanded?: boolean;
};

/**
 * Ajusta la altura de un textarea a su contenido, entre un mínimo y un tope.
 *
 * Marca el nodo con `data-grown` cuando pasa de una línea, para que el CSS
 * pueda tratarlo distinto sin que React tenga que mantener ese estado. La
 * medición se repite al cambiar el tamaño de la ventana porque el número de
 * líneas depende del ancho disponible.
 */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  { minHeight, maxHeight, expanded = true }: AutoGrowOptions,
) {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;

    const measure = () => {
      if (!expanded) {
        node.style.height = `${minHeight}px`;
        node.style.overflowY = 'hidden';
        // Sin esto, al colapsar un borrador largo quedaría visible un trozo
        // del medio en lugar del principio.
        node.scrollTop = 0;
        node.scrollLeft = 0;
        node.dataset.grown = 'false';
        return;
      }

      // `auto` primero: si no, scrollHeight nunca decrece al borrar texto.
      node.style.height = 'auto';
      const content = node.scrollHeight;
      node.style.height = `${Math.min(Math.max(content, minHeight), maxHeight)}px`;
      node.style.overflowY = content > maxHeight ? 'auto' : 'hidden';
      node.dataset.grown = content > minHeight + 1 ? 'true' : 'false';
    };

    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [ref, value, minHeight, maxHeight, expanded]);
}
