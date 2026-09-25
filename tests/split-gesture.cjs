/* eslint-disable @typescript-eslint/no-require-imports -- Node loader tests intentionally use CommonJS. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
const { performance } = require('node:perf_hooks');
const slots = [];
let cursor = 0;
let pending = [];
let renders = 0;
let changed = false;
const equalDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
const hooks = {
  useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
  useState(value) { const index = cursor++; if (!(index in slots)) slots[index] = typeof value === 'function' ? value() : value; return [slots[index], (next) => { const result = typeof next === 'function' ? next(slots[index]) : next; if (!Object.is(result, slots[index])) { slots[index] = result; changed = true; } }]; },
  useCallback(fn, deps) { const index = cursor++; if (!slots[index] || !equalDeps(slots[index].deps, deps)) slots[index] = { value: fn, deps }; return slots[index].value; },
  useMemo(fn, deps) { return this.useCallback(fn(), deps); },
  useEffect(fn, deps) { const index = cursor++; const previous = slots[index]; if (!previous || !equalDeps(previous.deps, deps)) pending.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: fn() }; }); },
};
// Destructured React exports have no receiver.
hooks.useMemo = (fn, deps) => { const index = cursor++; if (!slots[index] || !equalDeps(slots[index].deps, deps)) slots[index] = { value: fn(), deps }; return slots[index].value; };
const actualLoad = Module._load;
Module._load = function(request, parent) { return request === 'react' && parent?.filename.endsWith('useResizableSplit.ts') ? hooks : actualLoad.apply(this, arguments); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
const writes = [];
const listeners = new Map();
const frames = new Map();
let nextFrame = 0;
global.window = {
  localStorage: { getItem: () => null, setItem: (key, value) => writes.push([key, value]) },
  addEventListener: (type, handler) => { const set = listeners.get(type) ?? new Set(); set.add(handler); listeners.set(type, set); },
  removeEventListener: (type, handler) => listeners.get(type)?.delete(handler),
  dispatchEvent: (event) => { for (const handler of listeners.get(event.type) ?? []) handler(event); },
};
global.document = { body: { dataset: {} } };
global.requestAnimationFrame = (fn) => { const id = ++nextFrame; frames.set(id, fn); return id; };
global.cancelAnimationFrame = (id) => frames.delete(id);
const { useResizableSplit } = require('../app/components/useResizableSplit.ts');
let result;
const render = () => { cursor = 0; changed = false; renders += 1; result = useResizableSplit({ storageKey: 'fixture', defaultValue: 42, min: 20, max: 80, collapsible: true }); const effects = pending; pending = []; effects.forEach((fn) => fn()); };
const frame = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((fn) => fn()); if (changed) render(); };
const emit = (type, x, pointerId = 1) => window.dispatchEvent({ type, pointerId, clientX: x });
render(); writes.length = 0;
const divider = { parentElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }) }, getBoundingClientRect: () => ({ left: 420, top: 0, width: 9, height: 800 }), setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} };
result.startResize({ button: 0, currentTarget: divider, clientX: 424, clientY: 0, pointerId: 1, preventDefault() {} });
const started = performance.now();
for (let tick = 0; tick < 20; tick += 1) {
  for (let event = 0; event < 100; event += 1) emit('pointermove', 430 + tick * 10 + event / 100);
  assert.equal(frames.size, 1, '100 pointer events share one animation frame');
  frame();
  assert.equal(writes.length, 0, 'No storage write occurs while dragging');
}
const elapsed = performance.now() - started;
assert.equal(renders, 21, 'Exactly one state render per animation frame plus mount');
emit('pointerup', 620);
assert.equal(writes.length, 1, 'Final width persists once after pointerup');
assert.equal(document.body.dataset.splitDragging, undefined);
assert.equal(listeners.get('pointermove').size, 0);
assert.equal(listeners.get('pointercancel').size, 0);
assert.ok(result.value > 60 && result.value < 64);
// Releasing between frames commits the latest pointer, and cancellation cleans up.
result.startResize({ button: 0, currentTarget: divider, clientX: 424, clientY: 0, pointerId: 2, preventDefault() {} });
emit('pointermove', 1000, 2);
emit('pointercancel', 1000, 2);
assert.equal(frames.size, 0);
assert.equal(writes.at(-1)[1], '80');
assert.equal(listeners.get('blur').size, 0);
console.log(JSON.stringify({ tests: 'passed', pointerEvents: 2000, animationFrames: 20, stateRendersExcludingMount: renders - 1, writesDuringDrag: 0, writesAfterFirstRelease: 1, simulatedGestureCpuMs: +elapsed.toFixed(2), scope: 'Actual hook with a deterministic hook/frame/storage harness; no DOM FPS claim' }, null, 2));
