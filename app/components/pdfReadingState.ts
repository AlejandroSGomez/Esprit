export type PdfReadingState = { page: number; scale: number; fit: 'width' | 'page' | null; offset?: number };
const STORE = 'esprit-pdf-reading-v1';
const LIMIT = 60;
export const validatePdfReadingState = (value: unknown): PdfReadingState | null => {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<PdfReadingState>;
  if (!Number.isInteger(item.page) || item.page! < 1 || item.page! > 100_000 || !Number.isFinite(item.scale) || item.scale! < .45 || item.scale! > 3 || !['width', 'page', null].includes(item.fit!)) return null;
  return { page: item.page!, scale: item.scale!, fit: item.fit!, offset: Number.isFinite(item.offset) ? Math.min(1, Math.max(0, item.offset!)) : 0 };
};
const readAll = (): Array<[string, PdfReadingState]> => {
  if (typeof window === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORE) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-LIMIT).flatMap((entry) => {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || entry[0].length > 1000) return [];
      const state = validatePdfReadingState(entry[1]);
      return state ? [[entry[0], state] as [string, PdfReadingState]] : [];
    });
  } catch { return []; }
};
export const readPdfReadingState = (key: string) => readAll().find(([id]) => id === key)?.[1] ?? null;
export const savePdfReadingState = (key: string, value: PdfReadingState) => {
  const state = validatePdfReadingState(value);
  if (!state || key.length > 1000 || typeof window === 'undefined') return;
  try { window.localStorage.setItem(STORE, JSON.stringify([...readAll().filter(([id]) => id !== key), [key, state]].slice(-LIMIT))); }
  catch { /* Reading stays available when local preferences are full. */ }
};

export type TextMatch = { start: number; end: number };
export const joinPdfText = (strings: string[]) => {
  const offsets: number[] = [];
  let text = '';
  strings.forEach((value) => { offsets.push(text.length); text += `${value} `; });
  return { text, offsets };
};
export const findPdfTextMatches = (text: string, query: string, limit = 500): TextMatch[] => {
  const escaped = query.trim().slice(0, 160).split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  if (!escaped) return [];
  const pattern = new RegExp(escaped, 'giu');
  const matches: TextMatch[] = [];
  for (const match of text.matchAll(pattern)) {
    matches.push({ start: match.index, end: match.index + match[0].length });
    if (matches.length >= limit) break;
  }
  return matches;
};
