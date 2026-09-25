import assert from 'node:assert/strict';
import test from 'node:test';
import { LatestRequest } from './latestRequest.ts';

test('a slow earlier mail cannot replace the newer selection', async () => {
  const requests = new LatestRequest();
  let displayed = '';
  let resolveFirst = () => {};
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const firstIsCurrent = requests.begin();
  const pending = first.then(() => { if (firstIsCurrent()) displayed = 'first'; });
  const secondIsCurrent = requests.begin();
  if (secondIsCurrent()) displayed = 'second';
  resolveFirst();
  await pending;
  assert.equal(displayed, 'second');
});

test('changing mailbox invalidates even the last pending read', () => {
  const requests = new LatestRequest();
  const isCurrent = requests.begin();
  requests.invalidate();
  assert.equal(isCurrent(), false);
});
