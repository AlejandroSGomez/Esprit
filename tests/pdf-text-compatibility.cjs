/* eslint-disable @typescript-eslint/no-require-imports -- Uses Node's actual PDF.js loader with synthetic bytes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
const { readPdfTextContent, pdfSearchSummary } = require('../app/components/pdfTextContent.ts');

function syntheticPdf() {
  const stream = 'BT /F1 18 Tf 30 150 Td (Quantum synchronization synthetic fixture) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let content = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(content)); content += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => { content += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(content));
}
(async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.resolve(__dirname, '../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
  const task = pdfjs.getDocument({ data: syntheticPdf(), verbosity: 0 });
  const pdf = await task.promise;
  try {
    const page = await pdf.getPage(1);
    const baseline = await page.getTextContent();
    assert.match(baseline.items.map(item => item.str || '').join(' '), /Quantum synchronization/);
    const descriptor = Object.getOwnPropertyDescriptor(ReadableStream.prototype, Symbol.asyncIterator);
    try {
      delete ReadableStream.prototype[Symbol.asyncIterator];
      // Reproduce the WKWebView capability gap against the actual installed PDF.js,
      // capturing its unread failed stream so this regression test leaves no task.
      const streamTextContent = page.streamTextContent;
      let failedStream;
      page.streamTextContent = function(...args) { return failedStream = streamTextContent.apply(this, args); };
      await assert.rejects(page.getTextContent(), /async.*iterable|Symbol.asyncIterator/i);
      await failedStream.cancel(new Error('Synthetic baseline completed'));
      page.streamTextContent = streamTextContent;
      const result = await readPdfTextContent(page);
      assert.deepEqual(result, baseline);
      assert.match(result.items.map(item => item.str || '').join(' '), /Quantum synchronization/);
      console.log('Real PDF.js 6.2 synthetic PDF: original getTextContent fails without stream asyncIterator; compatible reader returns identical text, styles and language.');
    } finally {
      Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, descriptor);
    }
  } finally { await task.destroy(); }

  let cancelled = false;
  const controller = new AbortController();
  const pending = readPdfTextContent({ isPureXfa: false, streamTextContent: () => new ReadableStream({ cancel() { cancelled = true; } }) }, controller.signal);
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.ok(cancelled, 'hiding/cancelling stops the live stream');
  assert.doesNotMatch(pdfSearchSummary(0, 0, 17, 17, 0), /sin texto|coincidencias/);
  assert.match(pdfSearchSummary(0, 17, 0, 17, 0), /sin texto extraíble/);
  assert.match(pdfSearchSummary(3, 16, 1, 17, 500), /1 con error/);
  assert.doesNotMatch(pdfSearchSummary(0, 500, 0, 700, 0), /sin texto/);
  console.log('Cancellation and failed/partial/empty-text search states passed; no private PDF or network used.');
})().catch(error => { console.error(error); process.exitCode = 1; });
