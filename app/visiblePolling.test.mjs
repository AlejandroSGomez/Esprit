import assert from 'node:assert/strict';
import test from 'node:test';
import { startVisiblePolling } from './visiblePolling.ts';

function surface() {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  let now = 0, next = 0;
  const timers = new Map();
  const document = new EventTarget();
  document.visibilityState = 'visible';
  globalThis.document = document;
  globalThis.window = { setTimeout: (callback, delay) => { const id = ++next; timers.set(id, { at: now + delay, callback }); return id; }, clearTimeout: (id) => timers.delete(id) };
  return {
    async advance(ms) { const until = now + ms; while (true) { const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; now = due[1].at; timers.delete(due[0]); due[1].callback(); await Promise.resolve(); await Promise.resolve(); } now = until; },
    visibility(value) { document.visibilityState = value; document.dispatchEvent(new Event('visibilitychange')); },
    restore() { globalThis.window = originalWindow; globalThis.document = originalDocument; },
  };
}

test('hidden windows make no requests and resume uses the configured priority delay', async () => {
  const app = surface(); let reads = 0;
  const stop = startVisiblePolling(() => { reads++; }, 100, { resumeDelayMs: 30 });
  try {
    await app.advance(0); assert.equal(reads, 1);
    app.visibility('hidden'); await app.advance(1000); assert.equal(reads, 1);
    app.visibility('visible'); await app.advance(29); assert.equal(reads, 1);
    await app.advance(1); assert.equal(reads, 2);
  } finally { stop(); app.restore(); }
});

test('slow integrations never overlap and unmount prevents further scheduling', async () => {
  const app = surface(); let reads = 0; let finish = () => {};
  const stop = startVisiblePolling(() => { reads++; return new Promise((resolve) => { finish = resolve; }); }, 100);
  try {
    await app.advance(0); await app.advance(500); assert.equal(reads, 1);
    stop(); finish(); await Promise.resolve(); await app.advance(1000); assert.equal(reads, 1);
  } finally { stop(); app.restore(); }
});

test('failed sources back off and a successful snapshot restores the normal interval', async () => {
  const app = surface(); let reads = 0;
  const stop = startVisiblePolling(() => ({ error: ++reads === 1 ? 'offline' : null }), 100);
  try {
    await app.advance(0); assert.equal(reads, 1);
    await app.advance(199); assert.equal(reads, 1);
    await app.advance(1); assert.equal(reads, 2);
    await app.advance(100); assert.equal(reads, 3);
  } finally { stop(); app.restore(); }
});
