export type MarkdownImageToken = {
  from: number;
  to: number;
  alt: string;
  source: string;
};

const escapedAt = (text: string, index: number) => {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
};

/** Parse single-line inline Markdown images, including balanced destination parentheses and titles. */
export function findMarkdownImages(text: string): MarkdownImageToken[] {
  const images: MarkdownImageToken[] = [];
  let searchFrom = 0;
  while (searchFrom < text.length - 3) {
    const start = text.indexOf('![', searchFrom);
    if (start < 0) break;
    if (escapedAt(text, start)) {
      searchFrom = start + 2;
      continue;
    }
    let cursor = start + 2;
    let altEnd = -1;
    while (cursor < text.length) {
      if (text[cursor] === ']' && !escapedAt(text, cursor)) {
        altEnd = cursor;
        break;
      }
      cursor += 1;
    }
    if (altEnd < 0) break;
    if (text[altEnd + 1] !== '(') {
      searchFrom = altEnd + 1;
      continue;
    }
    cursor = altEnd + 2;
    while (/\s/.test(text[cursor] ?? '')) cursor += 1;
    let source = '';
    if (text[cursor] === '<') {
      const sourceStart = ++cursor;
      while (cursor < text.length && (text[cursor] !== '>' || escapedAt(text, cursor))) cursor += 1;
      if (text[cursor] !== '>') break;
      source = text.slice(sourceStart, cursor);
      cursor += 1;
    } else {
      const sourceStart = cursor;
      let depth = 0;
      while (cursor < text.length) {
        const character = text[cursor];
        if (character === '\\') {
          cursor += 2;
          continue;
        }
        if (character === '(') depth += 1;
        else if (character === ')') {
          if (depth === 0) break;
          depth -= 1;
        } else if (/\s/.test(character) && depth === 0) break;
        cursor += 1;
      }
      source = text.slice(sourceStart, cursor);
    }
    if (!source) {
      searchFrom = Math.max(cursor + 1, altEnd + 1);
      continue;
    }
    while (/\s/.test(text[cursor] ?? '')) cursor += 1;
    if (text[cursor] === '"' || text[cursor] === "'") {
      const quote = text[cursor++];
      while (cursor < text.length && (text[cursor] !== quote || escapedAt(text, cursor))) cursor += 1;
      if (text[cursor] !== quote) break;
      cursor += 1;
      while (/\s/.test(text[cursor] ?? '')) cursor += 1;
    }
    if (text[cursor] !== ')') {
      searchFrom = Math.max(cursor + 1, altEnd + 1);
      continue;
    }
    images.push({
      from: start,
      to: cursor + 1,
      alt: text.slice(start + 2, altEnd).replace(/\\\]/g, ']'),
      source: source.trim(),
    });
    searchFrom = cursor + 1;
  }
  return images;
}
