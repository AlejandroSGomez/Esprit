import assert from 'node:assert/strict';
import { test } from 'node:test';
import { customShortcodes, findEmojiCompletion, insertEmoji, normalizeEmojiAliases, recentEmojiNames, rememberEmoji, searchEmojiOptions } from './emojiHelpers.ts';

test('inserts at caret and replaces only the selected range in a draft', () => {
  assert.deepEqual(insertEmoji('Hola mundo', 5, 5, '🙂'), { text: 'Hola 🙂mundo', cursor: 7 });
  assert.deepEqual(insertEmoji('Antes BORRAR después', 6, 12, ':koi:'), { text: 'Antes :koi: después', cursor: 11 });
  assert.deepEqual(insertEmoji('🙂 respuesta :ko', 13, 16, ':koi:'), { text: '🙂 respuesta :koi:', cursor: 18 });
  assert.equal(insertEmoji('a'.repeat(16_000), 2, 2, '🙂'), null);
});

test('completion detects unfinished names, excluding URLs, times, code and selections', () => {
  assert.deepEqual(findEmojiCompletion('Hola :smi', 9), { start: 5, end: 9, query: 'smi' });
  assert.deepEqual(findEmojiCompletion(':', 1), { start: 0, end: 1, query: '' });
  for (const text of ['https:', '10:30', ':smile:', '\\:escape', '` :code', '```python\n:code']) {
    assert.equal(findEmojiCompletion(text, text.length), null, text);
  }
  assert.equal(findEmojiCompletion('Hola :smi', 5, 9), null);
});

test('Unicode shortcodes never enter an authenticated custom-name batch', () => {
  assert.deepEqual(customShortcodes([':smile: :thumbsup: :team_koi: :heart:', ':team_koi: :another_custom:']), ['team_koi', 'another_custom']);
});

test('search is literal, supports Spanish common terms and ranks exact matches', () => {
  assert.ok(searchEmojiOptions('corazón', [], [])[0].name.includes('heart'));
  assert.equal(searchEmojiOptions('team_koi', ['team_koi'], [])[0].kind, 'custom');
  assert.deepEqual(searchEmojiOptions('[invalid regex', ['team_koi'], []), []);
  assert.equal(searchEmojiOptions('smile', [], [])[0].name, 'smile');
  assert.ok(searchEmojiOptions('', [], [], 'all', 500).length > 72);
});

test('recents contain only bounded semantic names and remove duplicates', () => {
  assert.deepEqual(recentEmojiNames(['smile', 'smile', 'https://example.com', {}, 'team_koi']), ['smile', 'team_koi']);
  assert.deepEqual(rememberEmoji(['smile', 'team_koi'], 'team_koi'), ['team_koi', 'smile']);
  assert.deepEqual(searchEmojiOptions('', [], ['unknown_custom'], 'recent'), []);
});

test('Mattermost aliases render as Unicode while literal code remains unchanged', () => {
  assert.equal(normalizeEmojiAliases(':thumbsup: `:thumbsup:`'), '👍 `:thumbsup:`');
});

test('Mattermost system names resolve even when node-emoji spells them differently', async () => {
  const { emojiGlyph, isUnicodeEmoji } = await import('./emojiHelpers.ts');
  assert.equal(emojiGlyph('hugging_face'), '🤗');
  assert.equal(emojiGlyph('face_with_tears_of_joy'), '😂');
  assert.equal(emojiGlyph('thumbsup'), '👍');
  assert.equal(isUnicodeEmoji('hugging_face'), true, 'System names are never requested as custom images');
  assert.deepEqual(customShortcodes([':hugging_face: :koi_party:']), ['koi_party']);
});
