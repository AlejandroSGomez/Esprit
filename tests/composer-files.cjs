/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, file);
require.extensions['.css'] = () => {};
const { JSDOM } = require(path.join(process.env.ESPRIT_TEST_NODE_MODULES || path.resolve(__dirname, '../node_modules'), 'jsdom'));
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'https://esprit.test' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'Element', 'Node', 'MutationObserver', 'FileReader', 'File', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'KeyboardEvent']) Object.defineProperty(global, name, { value: dom.window[name], configurable: true });
global.IS_REACT_ACT_ENVIRONMENT = true;
global.ResizeObserver = class { observe() {} disconnect() {} };
window.__TAURI_INTERNALS__ = {};

const files = require('../app/composerFiles.ts');
const now = new Date(2026, 8, 29, 15, 4, 5);
assert.equal(files.pastedName('image.png', 'image/png', 0, now), 'Pegado 2026-09-29 15.04.05.png');
assert.equal(files.pastedName('image.jpeg', 'image/jpeg', 1, now), 'Pegado 2026-09-29 15.04.05 (2).jpg');
assert.equal(files.pastedName('', 'image/tiff', 0, now), 'Pegado 2026-09-29 15.04.05.tif');
assert.equal(files.pastedName('Resultados/fig 3.pdf', 'application/pdf', 0, now), 'Resultadosfig 3.pdf', 'separators never survive');
assert.equal(files.mimeFor('x.PDF'), 'application/pdf');
assert.equal(files.mimeFor('x.bin', 'application/octet-stream'), 'application/octet-stream');
assert.equal(files.mimeFor('x.png', 'image/png'), 'image/png');
const limits = { files: 2, perFile: 10, total: 15 };
assert.equal(files.limitProblem([], [{ name: 'a', size: 5 }], limits), null);
assert.match(files.limitProblem([{ size: 5 }], [{ name: 'a', size: 5 }, { name: 'b', size: 1 }], limits), /Máximo 2 archivos/);
assert.match(files.limitProblem([], [{ name: 'big.pdf', size: 11 }], limits), /big\.pdf pesa/);
assert.match(files.limitProblem([{ size: 9 }], [{ name: 'a', size: 9 }], limits), /en total/);
assert.match(files.limitProblem([], [{ name: 'carpeta', size: 0 }], limits), /vacío o es una carpeta/);
assert.ok(files.textOnlyNamesFiles('', ['a.png']));
assert.ok(files.textOnlyNamesFiles('paper.pdf\nfig.png', ['paper.pdf', 'fig.png']), 'Finder puts the names as text');
assert.ok(files.textOnlyNamesFiles('https://example.org/x.png', ['image.png']), 'a copied web image');
assert.ok(!files.textOnlyNamesFiles('1\t2\n3\t4', ['image.png']), 'Excel cells stay text');
assert.ok(files.pasteMayCarryFiles(['Files'], 0, ''));
assert.ok(files.pasteMayCarryFiles(['text/uri-list'], 0, 'file:///Users/a/x.pdf'));
assert.ok(!files.pasteMayCarryFiles(['text/plain', 'text/uri-list'], 0, 'https://example.org'));
assert.deepEqual(files.insertText('hola mundo', 5, 10, 'Esprit'), { value: 'hola Esprit', cursor: 11 });

const calls = [];
const apiPath = require.resolve('@tauri-apps/api/core');
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: { invoke: async (command, payload) => {
  calls.push({ command, payload });
  if (command === 'mattermost_emoji_catalog') return { names: [], page: 0, has_more: false };
  return {};
} } };
const React = require('react'); const { act } = React; const { createRoot } = require('react-dom/client');
const { default: Composer } = require('../app/components/MattermostComposer.tsx');
const container = { current: document.getElementById('root') };
const root = createRoot(document.getElementById('root'));
const settle = async () => { for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };

function paste({ fileList = [], types = [], text = '', uri = '' }) {
  const textarea = document.querySelector('textarea');
  const event = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files: fileList, types: [...types, ...(fileList.length ? ['Files'] : [])], getData: (type) => type === 'text/plain' ? text : type === 'text/uri-list' ? uri : '' } });
  act(() => { textarea.dispatchEvent(event); });
  return event;
}
const cards = () => [...document.querySelectorAll('.composer-files li strong')].map((node) => node.textContent);

(async () => {
  await act(async () => root.render(React.createElement(Composer, {
    containerRef: container, channelId: 'channelone', label: 'Research', editing: null, onCancelEdit() {}, customEmojis: {}, onRequestImages() {},
    onOpenLink: async () => {}, onCreatePost: async () => {}, onUpdatePost: async () => {}, onSent() {},
  })));

  const pressV = async () => {
    const field = document.querySelector('textarea');
    const event = new KeyboardEvent('keydown', { key: 'v', metaKey: true, bubbles: true, cancelable: true });
    act(() => { field.dispatchEvent(event); });
    await settle();
    return event;
  };

  // Portable ClipboardEvent path: explicit bytes supplied by the webview.
  paste({fileList:[new File([new Uint8Array([137,80,78,71])], 'image.png', {type:'image/png'})]});
  await settle();
  paste({fileList:[new File(['%PDF'], 'paper.pdf', {type:'application/pdf'})]});
  await settle();
  assert.equal(cards().length, 2);
  assert.ok(document.querySelector('.composer-files.inline img'));
  assert.ok(!calls.some(call => call.command.startsWith('clipboard_')), 'no platform-specific clipboard read');

  // Outside the app (browser preview) the web clipboard is used: plain text stays native.
  delete window.__TAURI_INTERNALS__;
  assert.equal(paste({ types: ['text/plain'], text: 'hola' }).defaultPrevented, false);
  assert.equal((await pressV()).defaultPrevented, false);
  window.__TAURI_INTERNALS__ = {};

  // Preview opens over the app; Escape closes only the preview.
  let escaped = false;
  const bubble = (event) => { if (event.key === 'Escape') escaped = true; };
  window.addEventListener('keydown', bubble);
  await act(async () => document.querySelector('.composer-file-open').click());
  assert.ok(document.querySelector('.composer-preview-layer img'), 'the pasted image opens in full');
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(document.querySelector('.composer-preview-layer'), null);
  assert.equal(escaped, false, 'the composer does not close with it');
  window.removeEventListener('keydown', bubble);

  // Remove one, then review and send: the review shows the thumbnails and only the kept file uploads.
  await act(async () => document.querySelector('.composer-file-remove').click());
  assert.deepEqual(cards(), ['paper.pdf']);
  await act(async () => document.querySelector('.mm-send').click());
  assert.ok(document.querySelector('.mm-review-layer .composer-files.compact'), 'the review shows the files');
  await act(async () => document.querySelector('.mm-review-layer .primary').click());
  await settle();
  const sent = calls.find((call) => call.command === 'mattermost_send_files');
  assert.deepEqual(sent.payload.request.files, [{ name: 'paper.pdf', data_base64: 'JVBERg==' }]);
  assert.equal(sent.payload.request.confirmed, true);
  assert.equal(cards().length, 0);

  await act(async () => root.unmount());
  console.log('PASS: portable image/file paste, text preservation, limits, preview, reviewed upload and no native clipboard reads.');
})().catch((error) => { console.error(error); process.exit(1); });
