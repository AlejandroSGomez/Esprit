export type MentionSegment = string | { mention: string; own: boolean };
const EVERYONE = new Set(['channel', 'all', 'here']);
const MENTION = /(^|[^\p{L}\p{N}_@./\\-])@([a-z0-9][a-z0-9._-]{0,63})(?![a-z0-9._-])/giu;

/** Recognize prose mentions, never email addresses or path components. */
export function mentionSegments(text: string, ownUsername = ''): MentionSegment[] {
  const own = ownUsername.toLowerCase(), segments: MentionSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
    const name = match[2].replace(/[._-]+$/, '');
    const start = (match.index ?? 0) + match[1].length;
    if (start > last) segments.push(text.slice(last, start));
    segments.push({ mention: `@${name}`, own: name.toLowerCase() === own || EVERYONE.has(name.toLowerCase()) });
    last = start + 1 + name.length;
  }
  if (!segments.length) return [text];
  if (last < text.length) segments.push(text.slice(last));
  return segments;
}

type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] };
const NO_MENTIONS = new Set(['code', 'pre', 'a']);

/** Run before KaTeX so code, links and math keep their literal contents. */
export const rehypeMattermostMentions = (own: string) => () => (tree: HastNode) => {
  const walk = (node: HastNode) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child): HastNode[] => {
      if (child.type === 'element') { if (!NO_MENTIONS.has(child.tagName ?? '')) walk(child); return [child]; }
      if (child.type !== 'text' || !child.value?.includes('@')) return [child];
      return mentionSegments(child.value, own).map(segment => typeof segment === 'string'
        ? { type: 'text', value: segment }
        : { type: 'element', tagName: 'span', properties: { className: segment.own ? ['mm-mention', 'own'] : ['mm-mention'] }, children: [{ type: 'text', value: segment.mention }] });
    });
  };
  walk(tree);
};
