'use client';

/* Los adjuntos llegan como data URLs autenticadas del puente nativo. */
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef } from 'react';
import type { MattermostAttachment } from './MattermostSpace';

/**
 * Imagen o GIF de un adjunto, mostrado dentro del mensaje.
 *
 * No se pide hasta que el mensaje se acerca a la ventana: un canal con cientos
 * de posts podría arrastrar decenas de megas si se cargaran todos de golpe.
 * Los bytes vienen por el mismo puente autenticado que el visor lateral, así
 * que no se hace ninguna petición a un servidor externo.
 */
export default function MattermostInlineImage({
  file,
  source,
  failed,
  onRequest,
  onOpen,
}: {
  file: MattermostAttachment;
  source: string | null;
  failed: boolean;
  onRequest: (file: MattermostAttachment) => void;
  onOpen: (file: MattermostAttachment) => void;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(onRequest);

  useEffect(() => {
    requestRef.current = onRequest;
  }, [onRequest]);

  useEffect(() => {
    if (source || failed) return;
    const node = holderRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      requestRef.current(file);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      requestRef.current(file);
    }, { rootMargin: '320px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [failed, file, source]);

  if (failed) return null;

  return (
    <div className="mm-inline-image" ref={holderRef}>
      {source ? (
        <button onClick={() => onOpen(file)} type="button" title={`Abrir ${file.name}`}>
          <img src={source} alt={file.name} />
        </button>
      ) : (
        <span className="mm-inline-image-pending" aria-label={`Cargando ${file.name}`}>{file.name}</span>
      )}
    </div>
  );
}
