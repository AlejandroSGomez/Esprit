export type SearchEntry = { key: string; kind: string; title: string; detail: string; text?: string; target: string; context?: string };
export const normalizeSearch = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
export function buildSearchIndex(entries: SearchEntry[]) {
  return entries.map(entry => ({ entry, title: normalizeSearch(entry.title), haystack: normalizeSearch(`${entry.title} ${entry.detail} ${entry.text ?? ''}`) }));
}
export function searchEntries(index: ReturnType<typeof buildSearchIndex>, query: string, limit = 40): SearchEntry[] {
  const normalized = normalizeSearch(query);
  const words = normalized.split(' ').filter(Boolean);
  return index.filter(value => words.every(word => value.haystack.includes(word))).map(value => ({ ...value, rank: value.title === normalized ? 0 : value.title.startsWith(normalized) ? 1 : value.title.includes(normalized) ? 2 : 3 })).sort((a,b) => a.rank - b.rank || a.entry.kind.localeCompare(b.entry.kind) || a.entry.title.localeCompare(b.entry.title, 'es')).slice(0,limit).map(value => value.entry);
}
