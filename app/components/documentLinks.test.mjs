import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHeadingSlugger, headingLine, headingSlug, resolveDocumentLink } from './documentLinks.ts';

test('only credential-free HTTP(S) links go to the public browser bridge', () => {
  for (const url of ['https://example.org/paper', 'http://example.org']) assert.deepEqual(resolveDocumentLink(url, 'notes.md'), { kind: 'web', url });
  for (const url of ['https://user:secret@example.org', 'https://', '//example.org', 'mailto:a@example.org', 'javascript:alert(1)', 'file:///tmp/a.pdf', 'data:text/html,test']) assert.equal(resolveDocumentLink(url, 'notes.md').kind, 'blocked', url);
});

test('relative paths resolve inside the explorer on both desktop platforms', () => {
  assert.deepEqual(resolveDocumentLink('../README.md#install', 'docs/notes.md'), { kind: 'file', relativePath: 'README.md', slug: 'install' });
  assert.deepEqual(resolveDocumentLink('./figs/Fig%201.png', 'paper/notes.md'), { kind: 'file', relativePath: 'paper/figs/Fig 1.png', slug: null });
  assert.deepEqual(resolveDocumentLink('<notes/a b.md>', 'index.md'), { kind: 'file', relativePath: 'notes/a b.md', slug: null });
  assert.deepEqual(resolveDocumentLink('next.md', 'docs\\notes.md'), { kind: 'file', relativePath: 'docs/next.md', slug: null });
  for (const path of ['../../outside.pdf', '%2e%2e/%2e%2e/outside.pdf', '/tmp/a.pdf', '~/a.pdf', 'C:/a.pdf', 'C:\\a.pdf', '..%5c..%5ca.pdf', '%2foutside.pdf', 'note.md%00.pdf', '%zz', 'notes.md:stream']) assert.equal(resolveDocumentLink(path, 'docs/notes.md').kind, 'blocked', path);
});

test('anchors share stable heading slugs and ignore fenced examples', () => {
  assert.deepEqual(resolveDocumentLink('#next-actions', 'notes.md'), { kind: 'anchor', slug: 'next-actions' });
  assert.equal(headingSlug('Revisión del **árbitro**'), 'revisión-del-árbitro');
  assert.equal(headingSlug('[Paper](https://example.org)'), 'paper');
  const next = createHeadingSlugger();
  assert.deepEqual(['Notes', 'Notes', 'Notes-1', 'Notes'].map(next), ['notes', 'notes-1', 'notes-1-1', 'notes-2']);
  const source = '# State\n\n````md\n```\n## Hidden\n~~~~\n````\n## Next actions\n\n## Next actions\n\nSetext title\n---\n';
  assert.equal(headingLine(source, 'next-actions'), 8);
  assert.equal(headingLine(source, 'next-actions-1'), 10);
  assert.equal(headingLine(source, 'hidden'), null);
  assert.equal(headingLine(source, 'setext-title'), 12);
  assert.equal(headingLine('## Revisión del árbitro', 'revisi%C3%B3n-del-%C3%A1rbitro'), 1);
});
