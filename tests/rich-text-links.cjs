/* eslint-disable @typescript-eslint/no-require-imports */
// Render the real Markdown stack with synthetic text; native opening is mocked.
const fs = require('node:fs'), assert = require('node:assert/strict'), ts = require('typescript');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, file);
require.extensions['.css'] = () => {};
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'https://esprit.test/' });
for (const name of ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'Node']) Object.defineProperty(global, name, { value: dom.window[name], configurable: true });
global.IS_REACT_ACT_ENVIRONMENT = true;
const scrolled = [];
HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this); };
const React = require('react'), { act } = React, { createRoot } = require('react-dom/client');
function mock(file, exports) { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; }
const native = [];
mock('@tauri-apps/api/core', { invoke: async (command, payload) => { native.push({ command, payload }); return 'opened'; } });
const RichText = require('../app/components/RichTextRenderer.tsx').default;
mock('../app/components/RichText.tsx', { __esModule: true, default: RichText });
const NotesSpace = require('../app/components/NotesSpace.tsx').default;
const root = createRoot(document.getElementById('root'));
const click = async (node) => { assert.ok(node); await act(async () => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))); };

(async () => {
  const source = '# Sección\n\n[Ir](#secci%C3%B3n)\n\n| Enlace | Nota |\n| --- | --- |\n| [**Paper**](https://example.org/paper) | $x^2$ |\n\n[Unsafe](javascript:alert) [Local](notes.md)\n\n@fixture y `@literal`';
  let outerClicks = 0;
  await act(async () => root.render(React.createElement('div', { onClick: () => outerClicks++ },
    React.createElement(RichText, { content: '# Sección', className: 'other' }),
    React.createElement(RichText, { content: source, className: 'subject', mentions: { own: 'fixture' } }))));
  const subject = document.querySelector('.subject');
  assert.ok(subject.querySelector('.rich-text-table-scroll table'), 'Rendered GFM table owns its horizontal scroll wrapper');
  assert.ok(subject.querySelector('.katex'), 'Scientific math remains rendered');
  assert.equal(subject.querySelector('.mm-mention.own').textContent, '@fixture');
  assert.equal(subject.querySelector('code').textContent, '@literal');
  await click(subject.querySelector('a[href="https://example.org/paper"] strong'));
  assert.deepEqual(native, [{ command: 'document_open_link', payload: { url: 'https://example.org/paper' } }]);
  assert.equal(outerClicks, 0, 'A nested link never triggers the surrounding card');
  await click(subject.querySelector('a[href^="#"]'));
  assert.equal(scrolled.at(-1), subject.querySelector('h1'), 'Anchors stay within the clicked document');
  assert.equal(document.activeElement, subject.querySelector('h1'));
  assert.equal(native.length, 1, 'Anchors do not invoke the browser');
  for (const anchor of subject.querySelectorAll('a')) if (['Unsafe', 'Local'].includes(anchor.textContent)) await click(anchor);
  assert.equal(native.length, 1, 'Unsupported local and unsafe schemes never reach the web bridge');
  assert.equal(outerClicks, 0);
  const custom = [];
  await act(async () => root.render(React.createElement(RichText, { content: '[Open](https://example.org/custom)', onOpenLink: href => custom.push(href) })));
  await click(document.querySelector('a'));
  assert.deepEqual(custom, ['https://example.org/custom']);
  assert.equal(native.length, 1, 'Explicit handlers open exactly once');

  let edits = 0;
  const note = { id: 'synthetic', category: 'general', title: 'Fixture', body: '[Read](https://example.org/note)', updated_ms: 1, logged: false };
  await act(async () => root.render(React.createElement(NotesSpace, { quick: { notes: [note], refresh: async () => {}, remove: async () => {} }, projects: [], onNew() {}, onEdit: () => edits++, onOpenMeeting() {}, onClose() {} })));
  const card = document.querySelector('.sticky-content');
  assert.equal(card.tagName, 'DIV', 'Notes never nest an anchor inside a native button');
  await click(card.querySelector('a'));
  assert.equal(native.at(-1).payload.url, 'https://example.org/note');
  assert.equal(edits, 0, 'Following a note link does not open its editor');
  await act(async () => card.querySelector('a').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  assert.equal(edits, 0, 'Link keyboard activation does not edit its note');
  await act(async () => card.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })));
  assert.equal(edits, 1, 'Keyboard users can still edit the note body');
  await act(async () => root.unmount());
  dom.window.close();
  console.log('PASS: rendered Markdown browser links, scoped anchors, tables/math, optional mentions and note-card keyboard behavior.');
})().catch(error => { console.error(error); process.exitCode = 1; dom.window.close(); });
