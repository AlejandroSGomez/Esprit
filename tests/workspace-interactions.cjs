/* eslint-disable @typescript-eslint/no-require-imports -- Node loader tests intentionally use CommonJS. */
// No private fixtures or network. Transpile the actual components into the Node test process.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const ts = require('typescript');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  module._compile(source, filename);
};
require.extensions['.css'] = () => {};
const { EditorState, EditorSelection } = require('@codemirror/state');
const { markdownDecorations, livePreview } = require('../app/components/ScientificEditor.tsx');
const { searchProjectFiles } = require('../app/components/projectNavigation.ts');
const { findPdfTextMatches, joinPdfText, validatePdfReadingState, savePdfReadingState, readPdfReadingState } = require('../app/components/pdfReadingState.ts');
const snapshot = (set) => {
  const result = [];
  for (const iterator = set.iter(); iterator.value; iterator.next()) result.push([iterator.from, iterator.to, iterator.value.spec]);
  return JSON.parse(JSON.stringify(result));
};
const assets = { 'assets/demo.png': 'data:image/png;base64,fixture' };
const fixture = ['# Heading', '', 'Text **bold** and _italic_ plus [link](https://example.org).', '', '```julia', '# Leave **code** literal', 'x = "$a$"', '```', '', '$$', 'x^2 + y^2', '$$', '', '| Left | Right |', '| :--- | ---: |', '| $x$ | **y** |', '', '![figure](assets/demo.png)', '', 'End ~~old~~ $z$'].join('\n');
const preview = livePreview({ current: assets });
let state = EditorState.create({ doc: fixture, extensions: [preview] });
let checks = 0;
const verify = () => {
  assert.deepEqual(snapshot(state.field(preview)), snapshot(markdownDecorations(state, assets)));
  checks += 1;
};
verify();
// Single-line typing, structural edits, fenced code, tables, math, long selections and undo-shaped deletes.
for (const number of [3, 6, 11, 15, 18, 20, 1, 3]) {
  const line = state.doc.line(number);
  state = state.update({ selection: EditorSelection.cursor(line.from) }).state; verify();
  state = state.update({ changes: { from: line.from + Math.min(2, line.length), insert: 'abc' } }).state; verify();
  state = state.update({ changes: { from: line.from + Math.min(2, line.length), to: line.from + Math.min(2, line.length) + 3, insert: '' } }).state; verify();
}
state = state.update({ selection: EditorSelection.range(0, state.doc.length) }).state; verify();
state = state.update({ selection: EditorSelection.cursor(0) }).state; verify();
state = state.update({ changes: { from: state.doc.line(3).from, insert: '\nNew paragraph\n' } }).state; verify();
state = state.update({ changes: { from: state.doc.line(3).from, insert: '```\n' } }).state; verify();
assert.ok(state.doc.toString().includes('![figure](assets/demo.png)'));
// Repeated deterministic ordinary edits compare incremental decorations with a complete reference pass.
state = EditorState.create({ doc: fixture, extensions: [preview] });
for (let index = 0; index < 100; index += 1) {
  const line = state.doc.line(index % 2 ? 3 : 20);
  state = state.update({ changes: { from: line.to, insert: index % 3 ? 'x' : '*' }, selection: EditorSelection.cursor(line.to + 1) }).state;
  verify();
}
// Metadata validation and bounded local persistence; no PDF content is persisted.
const storage = new Map();
global.window = { localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } };
for (let index = 0; index < 80; index += 1) savePdfReadingState(`fixture-${index}`, { page: index + 1, scale: 1.2, fit: null, offset: .2 });
assert.equal(readPdfReadingState('fixture-0'), null);
assert.equal(readPdfReadingState('fixture-79').page, 80);
assert.equal(JSON.parse(storage.get('esprit-pdf-reading-v1')).length, 60);
for (const invalid of [{ page: -1, scale: 1, fit: 'width' }, { page: 1, scale: Infinity, fit: 'width' }, { page: 1, scale: 1, fit: 'bad' }, { page: 1.4, scale: 1, fit: null }]) assert.equal(validatePdfReadingState(invalid), null);
assert.deepEqual(findPdfTextMatches('Hello  world. HELLO world.', 'hello world'), [{ start: 0, end: 12 }, { start: 14, end: 25 }]);
assert.deepEqual(findPdfTextMatches('a+b a.b', 'a+b'), [{ start: 0, end: 3 }]);
const joined = joinPdfText(['First', 'second']);
assert.deepEqual(joined.offsets, [0, 6]);
assert.deepEqual(findPdfTextMatches(joined.text, 'first second'), [{ start: 0, end: 12 }]);
(async () => {
  const entry = (id, kind = 'directory', name = id, sensitive = false) => ({ id, name, kind, sensitive, size: 1, modified: 1 });
  const root = { directory_id: 'root', entries: [entry('results'), entry('link', 'symlink'), entry('hidden', 'directory', '.secret'), entry('sensitive', 'directory', 'private', true), entry('notes'), entry('top', 'file')], truncated: false };
  const calls = [];
  const list = async (id) => { calls.push(id); return { directory_id: id, entries: [entry('note', 'file'), entry('loop', 'directory', 'child')], truncated: false }; };
  const found = await searchProjectFiles(root, list, () => false);
  assert.deepEqual(calls, ['notes', 'loop']);
  assert.equal(found.files[0].id, 'top');
  assert.ok(found.files.some((file) => file.relativePath === 'notes/note'));
  const bounded = await searchProjectFiles(root, list, () => false, false, { directories: 1, entries: 100, files: 100, depth: 2 });
  assert.equal(bounded.directories, 1); assert.equal(bounded.limited, true);
  const cancelled = await searchProjectFiles(root, list, () => true);
  assert.equal(cancelled.directories, 0); assert.equal(cancelled.limited, true);
  // Synthetic editor measurements: state transactions only, not DOM FPS or device latency.
  const large = Array.from({ length: 3000 }, (_, index) => `Line ${index}: **bold** and _emphasis_ with [a link](https://example.org).`).join('\n');
  let measured = EditorState.create({ doc: large, extensions: [preview] });
  let start = performance.now();
  for (let index = 0; index < 100; index += 1) measured = measured.update({ selection: EditorSelection.cursor(measured.doc.line(index + 1).from) }).state;
  const incremental = performance.now() - start;
  start = performance.now();
  for (let index = 0; index < 100; index += 1) markdownDecorations(measured, assets);
  const full = performance.now() - start;
  console.log(JSON.stringify({ tests: 'passed', exactDecorationComparisons: checks, syntheticDocumentCharacters: large.length, cursorTransactions100Ms: +incremental.toFixed(2), fullDecorationPasses100Ms: +full.toFixed(2), scope: 'Node CodeMirror state only; no DOM, FPS or private content' }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
