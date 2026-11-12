import test from 'node:test';
import assert from 'node:assert/strict';
import { mentionSegments, rehypeMattermostMentions } from './mattermostMentions.ts';

test('mentions highlight the configured reader and everyone, preserving punctuation', () => {
  assert.deepEqual(mentionSegments('Hola @Ana.P, @other y @here.', 'ana.p'), ['Hola ', { mention: '@Ana.P', own: true }, ', ', { mention: '@other', own: false }, ' y ', { mention: '@here', own: true }, '.']);
  assert.deepEqual(mentionSegments('ana@example.test user/@scope y @-none'), ['ana@example.test user/@scope y @-none']);
  assert.deepEqual(mentionSegments(`@${'a'.repeat(65)}`), [`@${'a'.repeat(65)}`]);
});

test('Markdown processing leaves code, links and math untouched', () => {
  const tree = { type: 'root', children: [
    { type: 'element', tagName: 'p', children: [{ type: 'text', value: '@reader' }] },
    ...['code', 'pre', 'a'].map(tagName => ({ type: 'element', tagName, children: [{ type: 'text', value: '@reader' }] })),
  ] };
  rehypeMattermostMentions('reader')()(tree);
  assert.deepEqual(tree.children[0].children[0].properties.className, ['mm-mention', 'own']);
  for (const child of tree.children.slice(1)) assert.deepEqual(child.children, [{ type: 'text', value: '@reader' }]);
});
