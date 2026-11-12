/** A document link never grants access beyond the explorer's native session. */
export type DocumentLink =
  | { kind: 'web'; url: string }
  | { kind: 'anchor'; slug: string }
  | { kind: 'file'; relativePath: string; slug: string | null }
  | { kind: 'blocked' };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const CONTROL = /[\u0000-\u001f\u007f]/;

const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return null; } };

export const headingSlug = (text: string) => text
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/<[^>]*>/g, '')
  .trim().toLocaleLowerCase('es')
  .replace(/[^\p{L}\p{N}\s-]/gu, '')
  .replace(/\s/g, '-');

/** Shared by rendered headings and the editor, including repeated titles. */
export const createHeadingSlugger = () => {
  const used = new Set<string>();
  return (text: string) => {
    const base = headingSlug(text);
    let slug = base;
    let suffix = 0;
    while (used.has(slug)) slug = `${base}-${++suffix}`;
    used.add(slug);
    return slug;
  };
};

/** Find the source line without treating fenced source code as headings. */
export function headingLine(markdown: string, slug: string): number | null {
  const wanted = decode(slug)?.toLocaleLowerCase('es');
  if (wanted == null) return null;
  const nextSlug = createHeadingSlugger();
  const lines = markdown.split('\n');
  let fence: { character: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const run = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[index]);
    if (fence) {
      if (run && run[1][0] === fence.character && run[1].length >= fence.length && !run[2].trim()) fence = null;
      continue;
    }
    if (run) { fence = { character: run[1][0], length: run[1].length }; continue; }
    const atx = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(lines[index]);
    const setext = !atx && lines[index].trim() && /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1] ?? '') && !/^\s{4}/.test(lines[index]);
    const title = atx?.[1] ?? (setext ? lines[index].trim() : null);
    if (title != null && nextSlug(title) === wanted) return index + 1;
    if (setext) index += 1;
  }
  return null;
}

/** Resolve relative paths; opening still uses the existing confined handles. */
export function resolveDocumentLink(href: string, documentPath: string): DocumentLink {
  const raw = href.trim().replace(/^<(.*)>$/, '$1');
  if (!raw || CONTROL.test(raw) || raw.includes('\\')) return { kind: 'blocked' };
  if (SCHEME.test(raw)) {
    if (!/^https?:\/\//i.test(raw)) return { kind: 'blocked' };
    try {
      const url = new URL(raw);
      return url.hostname && !url.username && !url.password ? { kind: 'web', url: raw } : { kind: 'blocked' };
    } catch { return { kind: 'blocked' }; }
  }
  if (raw.startsWith('#')) return { kind: 'anchor', slug: raw.slice(1) };
  const hash = raw.indexOf('#');
  const slug = hash >= 0 ? raw.slice(hash + 1) || null : null;
  const target = decode((hash >= 0 ? raw.slice(0, hash) : raw).replace(/\?.*$/, ''));
  if (!target || CONTROL.test(target) || /[\\:]/.test(target) || /^[\/~]/.test(target)) return { kind: 'blocked' };
  const parts = documentPath.replace(/\\/g, '/').split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return { kind: 'blocked' };
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? { kind: 'file', relativePath: parts.join('/'), slug } : { kind: 'blocked' };
}
