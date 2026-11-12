import test from 'node:test';
import assert from 'node:assert/strict';
import { MattermostChannels, mattermostLastChannelKey, mergeMattermostRecent } from './mattermostChannels.ts';

const channel = (id = 'one', last_post_at = 20) => ({ id, last_post_at, restricted: false });
const data = (id = 'one', posts = []) => ({ channel: channel(id), posts, history: { mode: 'recent', complete: false, window_start_at: 10 } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('hover, overview and foreground share a channel read; forced refresh waits for it', async () => {
  const cache = new MattermostChannels(), first = deferred();
  let calls = 0;
  const oldRead = cache.read('one', 20, () => { calls++; return first.promise; });
  const joined = cache.read('one', 20, () => { throw new Error('duplicate read'); });
  const forced = cache.read('one', 30, async () => { calls++; return data('one', [{ id: 'new' }]); }, true);
  await Promise.resolve();
  assert.equal(calls, 1);
  first.resolve(data());
  assert.deepEqual(await joined, await oldRead);
  assert.equal((await forced).posts[0].id, 'new');
  assert.equal(calls, 2);
  assert.equal(cache.hasPending('one'), false);
  assert.equal(cache.snapshots.get('one').stamp, 30);
});

test('read-ahead is capped at two, skips restricted/fresh channels and retries errors', async () => {
  const cache = new MattermostChannels(), pending = deferred();
  const calls = [];
  const load = id => () => { calls.push(id); return pending.promise.then(() => data(id)); };
  const first = cache.prefetch(channel('one'), load('one'));
  const second = cache.prefetch(channel('two'), load('two'));
  await cache.prefetch(channel('three'), load('three'));
  await cache.prefetch({ ...channel('secret'), restricted: true }, load('secret'));
  await Promise.resolve();
  assert.deepEqual(calls, ['one', 'two']);
  pending.resolve();
  await Promise.all([first, second]);
  await cache.prefetch(channel('one'), load('one'));
  assert.deepEqual(calls, ['one', 'two']);
  assert.equal(cache.isFresh(channel('one'), Date.now() + 21_000), false);
  assert.equal(cache.isFresh(channel('one', 21)), false);
  await assert.rejects(cache.read('fail', 1, async () => { throw new Error('offline'); }));
  await cache.read('fail', 1, async () => data('fail'));
  assert.equal(cache.hasPending('fail'), false);
});

test('snapshots are bounded, account preference keys distinct, and activity stamps captured', async () => {
  const cache = new MattermostChannels();
  for (let index = 0; index < 14; index++) await cache.read(String(index), index, async () => data(String(index)));
  assert.equal(cache.snapshots.size, 12);
  assert.equal(cache.snapshots.has('0'), false);
  const account = { server: 'https://chat.example.test', team: 'demo', identity: 'reader' };
  assert.notEqual(mattermostLastChannelKey(account), mattermostLastChannelKey({ ...account, identity: 'other' }));
  assert.notEqual(mattermostLastChannelKey(account), mattermostLastChannelKey({ ...account, server: 'https://other.example.test' }));
});

test('refresh removes deleted posts inside the authoritative window and preserves older history', () => {
  const current = { ...data('one', [{ id: 'old', create_at: 1 }, { id: 'deleted', create_at: 15 }, { id: 'edited', create_at: 20, message: 'before' }]), history: { mode: 'full' } };
  const next = data('one', [{ id: 'edited', create_at: 20, message: 'after' }]);
  const merged = mergeMattermostRecent(current, next, true);
  assert.deepEqual(merged.posts, [current.posts[0], next.posts[0]]);
  assert.equal(merged.history.mode, 'full');
  assert.equal(mergeMattermostRecent(current, { ...next, history: { ...next.history, complete: true } }, true).posts.length, 1);
  assert.equal(mergeMattermostRecent(current, data('other'), true).channel.id, 'other');
});
