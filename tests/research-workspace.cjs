/* eslint-disable @typescript-eslint/no-require-imports -- Test the actual TypeScript with the local compiler. */
const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
const { ResearchDraftWriter } = require('../app/research.ts');
const { buildSearchIndex, searchEntries } = require('../app/globalSearch.ts');
const { coalescedRead } = require('../app/coalescedRead.ts');
const note = (text) => ({ id: '', title: 'Meeting', kind: 'meeting', project: 'tesis', date: '2026-09-07', fields: { notes: text } });
const content = (text) => ({ notes: { ab: note(text) }, bases: { ab: null } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('mount and global-search reads share one native catalogue and its valid handles', async () => {
  const gate = deferred(); let calls = 0; let nativeHandle;
  const read = coalescedRead(async () => { calls++; await gate.promise; nativeHandle = `catalogue-${calls}`; return { id: nativeHandle }; });
  const mounted = read(); const searched = read();
  assert.equal(mounted, searched); await Promise.resolve(); assert.equal(calls, 1);
  gate.resolve(); const results = await Promise.all([mounted, searched]);
  assert.ok(results.every(value => value.id === nativeHandle));
  assert.equal((await read()).id, 'catalogue-2'); assert.equal(calls, 2);
});
test('a failed catalogue read permits an explicit retry', async () => {
  let calls = 0;
  const read = coalescedRead(async () => { if (++calls === 1) throw Error('unavailable'); return 'fresh'; });
  await assert.rejects(read(), /unavailable/); assert.equal(await read(), 'fresh');
});

test('quit waits for the newest draft while a native write is in flight', async () => {
  const gate = deferred(); const calls = [];
  const writer = new ResearchDraftWriter(4, async value => { calls.push(value); if (calls.length === 1) await gate.promise; return value.revision + 1; });
  writer.queue(content('First')); const closing = writer.flush(); await Promise.resolve();
  writer.queue(content('Last keystroke x')); let closed = false; const final = closing.then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); gate.resolve(); await final;
  assert.equal(calls.length,2); assert.deepEqual(calls.map(value => value.revision), [4,5]); assert.equal(calls[1].notes.ab.fields.notes, 'Last keystroke x');
});
test('failed saves preserve the latest edits and original base for a retry', async () => {
  const gate = deferred(); let fail = true; const writes = [];
  const writer = new ResearchDraftWriter(2, async value => { writes.push(value); if (fail) { await gate.promise; throw Error('disk unavailable'); } return value.revision + 1; });
  const base = { ...note('Original'), id: 'ab12' }; const first = { notes: { ab: { ...base, fields: { notes: 'Edit A' } } }, bases: { ab: base } };
  writer.queue(first); const attempt = writer.flush(); await Promise.resolve();
  writer.queue({ ...first, notes: { ab: { ...base, fields: { notes: 'Edit B' } } } }); gate.resolve(); await assert.rejects(attempt);
  fail = false; await writer.flush(); assert.equal(writes[1].revision,2); assert.equal(writes[1].notes.ab.fields.notes,'Edit B'); assert.equal(writes[1].bases.ab.fields.notes,'Original');
});
test('a late queued draft during completion is included by flush', async () => {
  const values = []; let writer;
  writer = new ResearchDraftWriter(0, async value => { values.push(value); if (values.length === 1) queueMicrotask(() => writer.queue(content('Late'))); return value.revision + 1; });
  writer.queue(content('First')); await Promise.all([writer.flush(), writer.flush()]); assert.equal(values.at(-1).notes.ab.fields.notes, 'Late'); assert.equal(values.length,2);
});
test('global search handles accents, exact-title ranking and multiword content', () => {
  const entries = [
    { key:'1', kind:'Espacio',title:'Reuniones',detail:'Abrir',target:'meetings' },
    { key:'2', kind:'Reunión',title:'Reunión de Kerr',detail:'Tesis',text:'Calibración de fase',target:'ab' },
    { key:'3', kind:'Chat',title:'Otro chat',detail:'General',text:'Reunión de Kerr y calibración',target:'cd' },
  ];
  const index = buildSearchIndex(entries);
  assert.deepEqual(searchEntries(index,'reunion de kerr').map(value => value.key), ['2','3']);
  assert.equal(searchEntries(index,'fase calibracion')[0].key,'2');
  assert.deepEqual(searchEntries(index,'[unsafe]+'),[]); assert.equal(searchEntries(index,'reunion',1).length,1);
});
