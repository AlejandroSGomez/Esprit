/* eslint-disable @typescript-eslint/no-require-imports */
// Synthetic DOM only. Install jsdom separately and set ESPRIT_TEST_NODE_MODULES;
// the user's app/profile, native bridges and private files are never accessed.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, file);
require.extensions['.css'] = () => {};
const React = require('react');
const { renderToString } = require('react-dom/server');
const Home = require('../app/page.tsx').default;
const NativeDate = Date;
function clock(iso) {
  const now = NativeDate.parse(iso);
  global.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
}
(async () => {
  clock('2026-09-07T10:00:00Z');
  const prerender = renderToString(React.createElement(Home));
  clock('2026-09-16T10:00:00Z');
  const later = renderToString(React.createElement(Home));
  assert.equal(prerender, later, 'First markup must survive a later day and expiration of a pinned deadline');
  const { JSDOM } = require(process.env.ESPRIT_TEST_NODE_MODULES ? path.join(process.env.ESPRIT_TEST_NODE_MODULES, 'jsdom') : 'jsdom');
  const dom = new JSDOM(`<!doctype html><div id="root">${prerender}</div><div id="editor"></div>`, { pretendToBeVisual: true, url: 'https://esprit.test/' });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'DOMRect', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) Object.defineProperty(global, name, { value: name in dom.window ? (typeof dom.window[name] === 'function' && ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(name) ? dom.window[name].bind(dom.window) : dom.window[name]) : undefined, configurable: true });
  window.localStorage.setItem('esprit-theme', 'dark');
  window.localStorage.setItem('esprit-mail-split', '65');
  window.localStorage.setItem('esprit-chat-expanded', '0');
  // Isolate the initial hydration pass from effects that read native services.
  const effect = React.useEffect, layoutEffect = React.useLayoutEffect;
  React.useEffect = React.useLayoutEffect = () => {};
  const { hydrateRoot } = require('react-dom/client');
  const container = document.getElementById('root'), header = container.querySelector('.topbar');
  const failures = [];
  const hydrated = hydrateRoot(container, React.createElement(Home), { onRecoverableError: error => failures.push(error.message) });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(failures, []);
  assert.equal(container.querySelector('.topbar'), header, 'Hydration must reuse the original DOM');
  hydrated.unmount(); React.useEffect = effect; React.useLayoutEffect = layoutEffect; global.Date = NativeDate;
  const { EditorState } = require('@codemirror/state');
  const { EditorView } = require('@codemirror/view');
  const { livePreview, markdownLinkEvents } = require('../app/components/ScientificEditor.tsx');
  const opened = [];
  const source = '# Fixture\n\n[Web](https://example.org/paper)\n\n| Link | Note |\n| --- | --- |\n| [**Table**](https://example.org/table) | text |\n';
  const view = new EditorView({ parent: document.getElementById('editor'), state: EditorState.create({ doc: source, extensions: [livePreview({ current: {} }), markdownLinkEvents(() => url => opened.push(url))] }) });
  for (const href of ['https://example.org/paper', 'https://example.org/table']) {
    const link = view.dom.querySelector(`[data-href="${href}"]`), target = link.querySelector('strong') || link;
    assert.ok(link, 'Both prose and table must expose their destination');
    const caret = view.state.selection.main.head;
    const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    target.dispatchEvent(down);
    assert.ok(down.defaultPrevented, 'Caret movement must not remove the link before click');
    assert.equal(view.state.selection.main.head, caret);
    assert.ok(link.isConnected);
    target.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, button: 0 }));
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    assert.equal(opened.at(-1), href);
  }
  assert.deepEqual(opened, ['https://example.org/paper', 'https://example.org/table']);
  const keyboardLink = view.dom.querySelector('[data-href="https://example.org/paper"]');
  assert.equal(keyboardLink.getAttribute('role'), 'link');
  keyboardLink.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.deepEqual(opened, ['https://example.org/paper', 'https://example.org/table', 'https://example.org/paper']);
  assert.equal(view.state.doc.toString(), source, 'Opening never edits the note');
  view.destroy(); dom.window.close();
  console.log('PASS: later-day hydration reuses DOM; prose/table mouse sequence opens once and preserves source.');
})().catch(error => { global.Date = NativeDate; console.error(error); process.exitCode = 1; });
