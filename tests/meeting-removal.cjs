/* eslint-disable @typescript-eslint/no-require-imports */
// Synthetic DOM only; no project file is read or moved. Needs jsdom through
// ESPRIT_TEST_NODE_MODULES, as documented for the other DOM regressions.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, file);
require.extensions['.css'] = () => {};
const { JSDOM } = require(path.join(process.env.ESPRIT_TEST_NODE_MODULES || '/tmp/esprit-dom-test-deps/node_modules', 'jsdom'));
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'https://esprit.test' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) Object.defineProperty(global, name, { value: name === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[name], configurable: true });
global.IS_REACT_ACT_ENVIRONMENT = true;

const calls = [];
const meeting = { id: 'ab12-cd34', kind: 'meeting', project: 'tesis', title: 'Seguimiento', date: '2026-09-20', fields: { agenda: 'Figura 3' } };
const apiPath = require.resolve('@tauri-apps/api/core');
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: { invoke: async (command, payload) => {
  calls.push({ command, payload });
  if (command === 'research_prepare_archive') return { plan_id: 'plan-1', destination: 'Proyectos/Tesis/docs/esprit/archive/meetings/ab12-cd34.md', before: 'x', after: '', state_link: true };
  if (command === 'research_apply') return { notes: [], warnings: [] };
  return null;
} } };
const React = require('react'); const { act } = React; const { createRoot } = require('react-dom/client');
const { ResearchSpace } = require('../app/components/ResearchSpace.tsx');

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const button = (text) => [...document.querySelectorAll('button')].find(item => item.textContent.trim() === text);
const state = { overview: null, drafts: { 'draft-1': { ...meeting, fields: { agenda: 'Editando' } }, 'draft-2': { ...meeting, id: '', title: 'Otra' } }, puts: [] };
const research = () => ({
  ready: true, notes: state.overview ? state.overview.notes : [meeting], warnings: [], error: '', drafts: state.drafts,
  refresh: async () => {}, flush: async () => {}, setOverview: (value) => { state.overview = value; },
  putDraft: (key, value) => { state.puts.push([key, value]); if (value === null) { const next = { ...state.drafts }; delete next[key]; state.drafts = next; } },
});
const root = createRoot(document.getElementById('root'));
const render = () => act(async () => { root.render(React.createElement(ResearchSpace, { research: research(), projects: [{ slug: 'tesis', name: 'Tesis doctoral', next: '', summary: '' }], onOpen: () => {}, onProject: () => {} })); });

(async () => {
  await render();
  // Cancelling releases the native plan and leaves the meeting listed.
  await act(async () => { button('Borrar…').click(); await tick(); });
  assert.match(document.querySelector('.research-removal').textContent, /archive\/meetings\/ab12-cd34\.md/);
  assert.match(document.querySelector('.research-removal').textContent, /STATE\.md/);
  await act(async () => { button('Cancelar').click(); await tick(); });
  assert.equal(document.querySelector('.research-removal'), null);
  assert.deepEqual(calls.map(call => call.command), ['research_prepare_archive', 'research_cancel']);

  // Confirming applies exactly the reviewed plan and clears drafts of that meeting only.
  await act(async () => { button('Borrar…').click(); await tick(); });
  await act(async () => { button('Confirmar borrado').click(); await tick(); });
  const apply = calls.find(call => call.command === 'research_apply');
  assert.deepEqual(apply.payload, { planId: 'plan-1', confirmed: true });
  assert.deepEqual(state.puts, [['draft-1', null]]);
  await render();
  assert.equal(document.querySelectorAll('.research-card').length, 0);

  // A conserved draft needs an explicit second click before it is discarded.
  await act(async () => { button('Descartar…').click(); await tick(); });
  assert.deepEqual(state.puts, [['draft-1', null]]);
  await act(async () => { button('Descartar').click(); await tick(); });
  assert.deepEqual(state.puts.at(-1), ['draft-2', null]);
  await act(async () => { root.unmount(); });
  console.log('PASS: meeting removal is reviewed, cancellable and archive-only; drafts discard after confirmation.');
})().catch((error) => { console.error(error); process.exit(1); });
