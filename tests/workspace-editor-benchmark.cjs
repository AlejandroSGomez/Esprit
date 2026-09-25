/* eslint-disable @typescript-eslint/no-require-imports -- Node loader tests intentionally use CommonJS. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const ts = require('typescript');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
  let input = fs.readFileSync(filename, 'utf8');
  if (process.env.ESPRIT_EDITOR_BASELINE && filename === fs.realpathSync(process.env.ESPRIT_EDITOR_BASELINE)) input = input.replace('function markdownDecorations(', 'export function markdownDecorations(').replace('function livePreview(', 'export function livePreview(');
  module._compile(ts.transpileModule(input, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, filename);
};
require.extensions['.css'] = () => {};
const { EditorState, EditorSelection } = require('@codemirror/state');
const current = require('../app/components/ScientificEditor.tsx');
const baseline = process.env.ESPRIT_EDITOR_BASELINE ? require(path.resolve(process.env.ESPRIT_EDITOR_BASELINE)) : null;
const fixtures = [10_000, 100_000].map((target) => Array.from({ length: Math.ceil(target / 60) }, (_, index) => `Line ${index}: **bold** and _emphasis_ with [a link](https://example.org).`).join('\n').slice(0, target));
const sample = (implementation, doc, kind) => {
  const extension = implementation.livePreview({ current: {} });
  let state = EditorState.create({ doc, extensions: [extension] });
  const start = performance.now();
  for (let index = 0; index < 100; index += 1) {
    const line = state.doc.line(index % state.doc.lines + 1);
    state = state.update(kind === 'cursor' ? { selection: EditorSelection.cursor(line.from) } : { changes: { from: line.to, insert: 'x' }, selection: EditorSelection.cursor(line.to + 1) }).state;
  }
  return performance.now() - start;
};
const median = (samples) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
const results = fixtures.map((doc) => {
  const measure = (implementation, kind) => { sample(implementation, doc, kind); return +median(Array.from({ length: 5 }, () => sample(implementation, doc, kind))).toFixed(2); };
  return { characters: doc.length, transactionsPerSample: 100, medianOf: 5, currentCursorMs: measure(current, 'cursor'), baselineCursorMs: baseline ? measure(baseline, 'cursor') : null, currentTypingMs: measure(current, 'typing'), baselineTypingMs: baseline ? measure(baseline, 'typing') : null };
});
if (baseline) {
  // Original and updated render semantics match across code fences, GFM tables and LaTeX.
  const doc = '# Heading\n\nText **bold** $x$\n\n```\n**literal**\n```\n\n$$\nx^2\n$$\n\n| a | b |\n|---|---|\n| c | d |\n';
  const snapshot = (set) => { const values = []; for (const it = set.iter(); it.value; it.next()) values.push([it.from, it.to, it.value.spec]); return JSON.parse(JSON.stringify(values)); };
  for (let at = 0; at <= doc.length; at += 3) {
    const state = EditorState.create({ doc, selection: EditorSelection.cursor(at) });
    assert.deepEqual(snapshot(current.markdownDecorations(state, {})), snapshot(baseline.markdownDecorations(state, {})));
  }
}
console.log(JSON.stringify({ node: process.version, scope: 'CodeMirror state transactions on synthetic text. Does not measure DOM, input latency or FPS.', results }, null, 2));
