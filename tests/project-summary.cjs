/* eslint-disable @typescript-eslint/no-require-imports */
// Synthetic projects and deferred native reads; no user configuration or files.
const fs = require('node:fs'), assert = require('node:assert/strict'), ts = require('typescript');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, file);
require.extensions['.css'] = () => {};
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'https://esprit.test/' });
for (const name of ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLInputElement', 'Node']) Object.defineProperty(global, name, { value: dom.window[name], configurable: true });
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react'), { act } = React, { createRoot } = require('react-dom/client');
function mock(file, exports) { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; }
const calls = [];
mock('@tauri-apps/api/core', { invoke: (command, payload) => new Promise((resolve, reject) => {
  assert.ok(['project_summary', 'library_overview', 'library_read'].includes(command), `Unexpected native write/integration: ${command}`);
  calls.push({ command, payload, resolve, reject, settled: false });
}) });
mock('../app/appConfig.ts', { getAppTimeZone: () => 'UTC' });
mock('../app/components/RichText.tsx', { __esModule: true, default: ({ content }) => React.createElement('div', { className: 'rendered-markdown' }, content) });
mock('../app/components/PdfViewer.tsx', { __esModule: true, default: props => React.createElement('div', { 'data-testid': 'pdf', 'data-name': props.name, 'data-base64': props.dataBase64, 'data-active': String(props.active), 'data-storage': props.storageKey }, props.name) });
const ProjectSummary = require('../app/components/ProjectSummary.tsx').default;
const root = createRoot(document.getElementById('root'));
const projectA = { slug: 'project-a', name: 'Proyecto A', eyebrow: 'Prueba', summary: '**Objetivo A**', next: '$x^2$' };
const projectB = { slug: 'project-b', name: 'Proyecto B', eyebrow: 'Prueba', summary: '', next: '' };
let openedState = 0;
let props = { project: projectA, active: false, libraryEnabled: false, onOpenState: () => openedState++ };
const render = async patch => { props = { ...props, ...patch }; await act(async () => root.render(React.createElement(ProjectSummary, props))); };
const button = label => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === label);
const click = async node => { assert.ok(node, 'control exists'); await act(async () => node.click()); };
const pending = command => { const request = calls.find(call => call.command === command && !call.settled); assert.ok(request, `pending ${command}`); return request; };
const resolve = async (request, value) => { request.settled = true; await act(async () => request.resolve(value)); };
const reject = async (request, reason) => { request.settled = true; await act(async () => request.reject(reason)); };
const text = () => document.body.textContent;
const pdf = () => document.querySelector('[data-testid="pdf"]');
const list = () => [...document.querySelectorAll('.project-bibliography li strong')].map(node => node.textContent);
const paperButton = title => [...document.querySelectorAll('.project-bibliography li button')].find(node => node.querySelector('strong')?.textContent === title);
const paper = (id, overrides = {}) => ({ id, name: `${id}.pdf`, folder: 'synthetic', collection: 'general', tags: [], read: false, note: '', updated_ms: 0, radar: null, ...overrides });
const catalogue = { papers: [
  paper('read', { tags: ['project-a'], read: true, radar: { title: 'Paper leído', tldr: 'Resumen ficticio' } }),
  paper('tagged', { tags: ['project-a'], radar: { title: 'Paper por etiqueta', tldr: 'Asignación por etiqueta' } }),
  paper('collection', { collection: 'project-a', radar: { title: 'Paper por colección', tldr: '' } }),
  paper('other', { tags: ['project-b'], collection: 'project-b', radar: { title: 'Otro proyecto', tldr: '' } }),
  paper('unassigned'),
] };

(async () => {
  await render({});
  assert.equal(calls.length, 0, 'Inactive summary performs no reads');
  assert.equal(button('Bibliografía'), undefined, 'Disabled library has no entry point');
  await click(button('Actualizar'));
  assert.equal(calls.length, 0, 'Inactive refresh cannot read');

  await render({ active: true });
  assert.deepEqual(calls.map(call => call.command), ['project_summary']);
  assert.deepEqual(pending('project_summary').payload, { project: 'project-a' });
  await resolve(pending('project_summary'), { content: '# Estado A\n\n**Texto original** con $x^2$', modified: 1_700_000_000 });
  assert.match(text(), /Estado A/);
  assert.equal(document.querySelector('.project-summary-document .rendered-markdown').textContent, '# Estado A\n\n**Texto original** con $x^2$', 'STATE text reaches the Markdown renderer unchanged');
  assert.ok(document.querySelector('time'));
  await click(button('Abrir archivo'));
  assert.equal(openedState, 1);
  assert.equal(calls.length, 1, 'Opening STATE delegates to the explorer, without a write');
  await click(button('Actualizar'));
  await resolve(pending('project_summary'), { content: null, modified: null });
  assert.match(text(), /todavía no tiene STATE.md/);
  assert.equal(button('Abrir archivo'), undefined);
  assert.equal(calls.filter(call => call.command.startsWith('library_')).length, 0, 'Library disabled never reads its catalogue or PDFs');

  await click(button('Actualizar'));
  await reject(pending('project_summary'), 'Fallo sintético');
  assert.equal(document.querySelector('[role="alert"]').textContent, 'Fallo sintético');
  await click(button('Actualizar'));
  const lateA = pending('project_summary');
  await render({ project: projectB });
  assert.doesNotMatch(text(), /Fallo sintético|todavía no tiene STATE.md/, 'A project switch immediately clears the previous project state');
  const freshB = calls.find(call => call.command === 'project_summary' && call.payload.project === 'project-b' && !call.settled);
  await resolve(lateA, { content: 'LATE PROJECT A', modified: null });
  assert.doesNotMatch(text(), /LATE PROJECT A/);
  await resolve(freshB, { content: '# Estado B', modified: null });
  assert.match(text(), /Estado B/);
  await click(button('Actualizar'));
  const hiddenB = pending('project_summary');
  await render({ active: false });
  await resolve(hiddenB, { content: 'HIDDEN RESPONSE', modified: null });
  assert.doesNotMatch(text(), /HIDDEN RESPONSE/, 'A hidden summary ignores pending results');

  await render({ project: projectA, libraryEnabled: true, active: false });
  const beforeInactive = calls.length;
  await click(button('Bibliografía'));
  assert.equal(calls.length, beforeInactive, 'Selecting inactive bibliography still performs no reads');
  await render({ active: true });
  await resolve(pending('project_summary'), { content: '# Estado A', modified: null });
  await resolve(pending('library_overview'), catalogue);
  assert.deepEqual(list(), ['Paper por colección', 'Paper por etiqueta', 'Paper leído'], 'Project membership includes collection or tags, with unread papers first');
  assert.doesNotMatch(text(), /Otro proyecto|unassigned/);
  const input = document.querySelector('[aria-label="Buscar en la bibliografía"]');
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'ETIQUETA'); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
  assert.deepEqual(list(), ['Paper por etiqueta']);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ''); input.dispatchEvent(new window.Event('input', { bubbles: true })); });

  await click(paperButton('Paper por etiqueta'));
  const previewRead = pending('library_read');
  assert.deepEqual(previewRead.payload, { paperId: 'tagged' }, 'PDF read uses the opaque library identifier only');
  await resolve(previewRead, { name: 'tagged.pdf', data_base64: 'SYNTHETIC_PDF' });
  assert.equal(pdf().dataset.name, 'tagged.pdf');
  assert.equal(pdf().dataset.base64, 'SYNTHETIC_PDF');
  assert.equal(pdf().dataset.active, 'true');
  assert.equal(pdf().dataset.storage, 'esprit.project.bib.project-a.tagged.pdf');
  await render({ active: false });
  assert.equal(pdf().dataset.active, 'false', 'Hidden PDF rendering is paused');
  await render({ active: true });
  await resolve(pending('project_summary'), { content: '# Estado A', modified: null });
  await resolve(pending('library_overview'), catalogue);
  await click(button('Volver a los papers'));
  await click(paperButton('Paper por etiqueta'));
  const first = pending('library_read');
  await click(paperButton('Paper por colección'));
  const second = calls.find(call => call.command === 'library_read' && !call.settled && call !== first);
  await resolve(second, { name: 'latest.pdf', data_base64: 'LATEST' });
  await resolve(first, { name: 'stale.pdf', data_base64: 'STALE' });
  assert.equal(pdf().dataset.name, 'latest.pdf', 'A late PDF never replaces the more recent selection');

  await click(button('Volver a los papers'));
  await click(paperButton('Paper por etiqueta'));
  const hiddenPdf = pending('library_read');
  await render({ active: false });
  const beforeHiddenClick = calls.length;
  await click(paperButton('Paper por colección'));
  assert.equal(calls.length, beforeHiddenClick, 'Inactive paper controls cannot issue a read');
  await resolve(hiddenPdf, { name: 'hidden.pdf', data_base64: 'HIDDEN' });
  assert.equal(pdf(), null, 'A pending PDF is invalidated when its space becomes inactive');
  await render({ active: true });
  await resolve(pending('project_summary'), { content: '# Estado A', modified: null });
  const disabledOverview = pending('library_overview');
  await render({ libraryEnabled: false });
  await resolve(disabledOverview, catalogue);
  assert.equal(document.querySelector('.project-bibliography'), null, 'Disabling library unmounts the bibliography and rejects late catalogue results');
  assert.equal(button('Bibliografía'), undefined);
  assert.equal(pdf(), null);

  await act(async () => root.unmount());
  dom.window.close();
  console.log('PASS: optional/inactive read gates, unchanged STATE and missing/error views, project isolation, filtered bibliography, PDF handoff and late-response cancellation; no native writes.');
})().catch(error => { console.error(error); process.exitCode = 1; dom.window.close(); });
