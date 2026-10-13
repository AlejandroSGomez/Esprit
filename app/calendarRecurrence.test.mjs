import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The expander is plain JavaScript run by osascript; load it the same way.
const source = readFileSync(new URL('../src-tauri/resources/calendar_recurrence.js', import.meta.url), 'utf8');
const { expandRecurrence, configureRecurrenceZone } = new Function(`${source}; return { expandRecurrence, configureRecurrenceZone };`)();
configureRecurrenceZone('Europe/Madrid');
const at = (iso) => Date.parse(iso);
const hour = 3_600_000;
const iso = (values) => values.map((ms) => new Date(ms).toISOString());

test('a weekly series created long ago reaches the browsed range at the same local time across DST', () => {
  // Tuesdays 10:00 Madrid since January (CET), read in October around the change to CET.
  const start = at('2026-01-13T09:00:00Z');
  const out = expandRecurrence('FREQ=WEEKLY;INTERVAL=1', start, start + hour, at('2026-10-19T00:00:00Z'), at('2026-11-02T00:00:00Z'), [], 50);
  assert.deepEqual(iso(out), ['2026-10-20T08:00:00.000Z', '2026-10-27T09:00:00.000Z']);
});

test('UNTIL, COUNT, INTERVAL and excluded dates end or thin the series', () => {
  const start = at('2026-09-01T10:30:00Z');
  const range = [at('2026-09-01T00:00:00Z'), at('2026-12-01T00:00:00Z')];
  assert.equal(expandRecurrence('FREQ=WEEKLY;INTERVAL=1;UNTIL=20260917T215959Z', start, start + hour, ...range, [], 50).length, 3);
  assert.equal(expandRecurrence('FREQ=WEEKLY;COUNT=4', start, start + hour, ...range, [], 50).length, 4);
  assert.deepEqual(iso(expandRecurrence('FREQ=WEEKLY;INTERVAL=2;COUNT=3', start, start + hour, ...range, [], 50)), ['2026-09-01T10:30:00.000Z', '2026-09-15T10:30:00.000Z', '2026-09-29T10:30:00.000Z']);
  const skipped = expandRecurrence('FREQ=WEEKLY;COUNT=3', start, start + hour, ...range, [at('2026-09-08T10:30:00Z')], 50);
  assert.deepEqual(iso(skipped), ['2026-09-01T10:30:00.000Z', '2026-09-15T10:30:00.000Z']);
});

test('weekday lists, monthly ordinals and yearly dates', () => {
  const range = [at('2026-10-01T00:00:00Z'), at('2026-11-01T00:00:00Z')];
  const monday = at('2026-09-28T07:00:00Z');
  assert.equal(expandRecurrence('FREQ=WEEKLY;BYDAY=MO,WE', monday, monday + hour, ...range, [], 50).length, 8);
  const second = at('2026-09-08T08:00:00Z');
  assert.deepEqual(iso(expandRecurrence('FREQ=MONTHLY;BYDAY=2TU', second, second + hour, ...range, [], 50)), ['2026-10-13T08:00:00.000Z']);
  const birthday = at('2001-10-19T22:00:00Z');
  assert.deepEqual(iso(expandRecurrence('FREQ=YEARLY;INTERVAL=1', birthday, birthday + 24 * hour, ...range, [], 50)), ['2026-10-19T22:00:00.000Z']);
});

test('an unknown rule keeps only the original event', () => {
  const start = at('2026-10-05T08:00:00Z');
  assert.deepEqual(expandRecurrence('FREQ=HOURLY', start, start + hour, at('2026-10-01T00:00:00Z'), at('2026-11-01T00:00:00Z'), [], 50), [start]);
});

test('the wall-clock time follows the configured zone', () => {
  configureRecurrenceZone('America/New_York');
  const start = at('2026-10-06T14:00:00Z'); // Tuesday 10:00 EDT
  const out = expandRecurrence('FREQ=WEEKLY', start, start + hour, at('2026-10-30T00:00:00Z'), at('2026-11-12T00:00:00Z'), [], 50);
  assert.deepEqual(iso(out), ['2026-11-03T15:00:00.000Z', '2026-11-10T15:00:00.000Z']);
  configureRecurrenceZone('Europe/Madrid');
});
