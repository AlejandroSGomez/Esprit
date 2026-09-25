'use client';

import type { PointerEvent } from 'react';
import type { ResizableSplit } from './useResizableSplit';
import './workspaceRefinements.css';

/**
 * Divisor de paneles. Reúne el arrastre, el teclado, el doble clic para
 * restaurar y, cuando el panel es cerrable, un control para cerrarlo y
 * reabrirlo. Existe para que los nueve divisores de Esprit se comporten igual
 * en lugar de repetir el mismo markup en cada espacio.
 */
export default function SplitDivider({
  split,
  className,
  label,
  paneLabel,
  onCollapseStart, onCollapseEnd, startPaneLabel, endPaneLabel,
}: {
  split: ResizableSplit;
  /** Clases del espacio anfitrión, para conservar su aspecto. */
  className: string;
  label: string;
  /** Nombre del panel que se cierra, para el texto accesible. */
  paneLabel?: string;
  onCollapseStart?: () => void;
  onCollapseEnd?: () => void;
  startPaneLabel?: string;
  endPaneLabel?: string;
}) {
  const vertical = split.axis === 'vertical';
  const chevron = vertical
    ? (split.collapsed ? '›' : '‹')
    : (split.collapsed ? '⌄' : '⌃');

  // El botón no debe iniciar un arrastre, así que detiene el pointerdown antes
  // de que llegue al divisor.
  const swallowDrag = (event: PointerEvent<HTMLButtonElement>) => event.stopPropagation();

  return (
    <div
      className={`esprit-split ${className}${split.collapsed ? ' collapsed' : ''}`}
      onPointerDown={split.startResize}
      onKeyDown={split.onKeyDown}
      onDoubleClick={split.reset}
      aria-label={label}
      {...split.separatorProps}
    >
      <i aria-hidden="true" />
      {onCollapseStart || onCollapseEnd ? <span className={`split-direction-actions${vertical ? '' : ' horizontal'}`}>
        {onCollapseStart ? <button onPointerDown={swallowDrag} onKeyDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onClick={onCollapseStart} aria-label={`Ocultar ${startPaneLabel ?? 'panel inicial'}`} title={`Ocultar ${startPaneLabel ?? 'panel inicial'}`} type="button">{vertical ? '‹' : '⌃'}</button> : null}
        {onCollapseEnd ? <button onPointerDown={swallowDrag} onKeyDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onClick={onCollapseEnd} aria-label={`Ocultar ${endPaneLabel ?? 'panel final'}`} title={`Ocultar ${endPaneLabel ?? 'panel final'}`} type="button">{vertical ? '›' : '⌄'}</button> : null}
      </span> : split.collapsible ? (
        <button
          className="split-collapse"
          onPointerDown={swallowDrag}
          onClick={split.toggleCollapse}
          type="button"
          onDoubleClick={(event) => event.stopPropagation()}
          title={split.collapsed ? `Mostrar ${paneLabel ?? 'el panel'}` : `Ocultar ${paneLabel ?? 'el panel'}`}
          aria-expanded={!split.collapsed}
          aria-label={split.collapsed
            ? `Mostrar ${paneLabel ?? 'el panel'}`
            : `Ocultar ${paneLabel ?? 'el panel'}`}
        >
          {chevron}
        </button>
      ) : null}
    </div>
  );
}
