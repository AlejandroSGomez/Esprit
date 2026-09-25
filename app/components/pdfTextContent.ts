import type { PDFPageProxy } from 'pdfjs-dist';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';

function aborted() {
  const error = new Error('Lectura de texto cancelada');
  error.name = 'AbortError';
  return error;
}

/** PDF.js 6's getTextContent uses async iteration, absent in some WKWebViews.
 * Consume its public text stream via getReader instead, preserving styles/lang
 * for the selectable TextLayer as well as text items for document search.
 */
export async function readPdfTextContent(page: PDFPageProxy, signal?: AbortSignal): Promise<TextContent> {
  if (signal?.aborted) throw aborted();
  if (page.isPureXfa) return page.getTextContent();
  const reader = page.streamTextContent().getReader();
  const content: TextContent = { items: [], styles: Object.create(null), lang: null };
  const cancel = () => { void reader.cancel(aborted()).catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (signal?.aborted) throw aborted();
      if (done) return content;
      content.lang ??= value.lang;
      Object.assign(content.styles, value.styles);
      content.items.push(...value.items);
    }
  } catch (error) {
    await reader.cancel(error instanceof Error ? error : new Error(String(error))).catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export function pdfTextFailureMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  // Keep useful engine diagnostics, without arbitrary stacks or document text.
  if (/async.*iterat|symbol.*iterator|readablestream/i.test(reason)) return 'El visor no pudo leer el flujo de texto';
  if (/abort|cancel|destroy|closed|terminat/i.test(reason)) return 'La lectura del texto se interrumpió';
  return 'No se pudo extraer el texto de la página';
}

export function pdfSearchSummary(matches: number, pages: number, failures: number, totalPages: number, characters: number): string {
  if (!pages && failures) return `No se pudo buscar: falló la lectura de ${failures} ${failures === 1 ? 'página' : 'páginas'}. Prueba a reabrir el PDF`;
  const partial = pages < totalPages || failures > 0 || matches >= 500;
  return `${matches}${matches >= 500 ? '+' : ''} coincidencias${partial ? ` · búsqueda parcial (${pages}/${totalPages} páginas${failures ? `; ${failures} con error` : ''})` : ''}${!characters && !partial ? ' · PDF sin texto extraíble' : ''}`;
}
