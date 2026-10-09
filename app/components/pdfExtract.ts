/** Plain text of the first pages of a PDF, for the Ctrl/⌘J agent (bounded). */
export async function extractPdfText(dataBase64: string, maxPages = 10, maxChars = 9_000): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  const binary = window.atob(dataBase64);
  const task = pdfjs.getDocument({ data: Uint8Array.from(binary, (character) => character.charCodeAt(0)) });
  try {
    const pdf = await task.promise;
    let text = '';
    for (let number = 1; number <= Math.min(pdf.numPages, maxPages) && text.length < maxChars; number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      text += `\n[página ${number}]\n${content.items.map((item) => ('str' in item ? item.str : '')).join(' ').replace(/\s+/g, ' ').trim()}`;
      page.cleanup();
    }
    return text.slice(0, maxChars).trim();
  } finally {
    void task.destroy();
  }
}
