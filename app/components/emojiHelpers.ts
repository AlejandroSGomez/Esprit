import { get as unicodeEmoji, search as allEmoji } from 'node-emoji';
import { MATTERMOST_EMOJI_NAMES } from './mattermostEmojiNames.mjs';

export type EmojiOption = { name: string; value: string; kind: 'unicode' | 'custom' };
export type EmojiScope = 'all' | 'recent' | 'custom';
export type EmojiCompletion = { start: number; end: number; query: string };
const VALID_NAME = /^[a-z0-9_+\-]{1,64}$/;
export const RECENT_EMOJI_KEY = 'esprit.mattermost.recent-emojis.v1';
const POPULAR = ['thumbsup', 'smile', 'heart', 'tada', 'rocket', 'thinking_face', 'eyes', 'white_check_mark', 'pray', 'wave', 'laughing', 'clap'];
const ALIASES: Record<string, string> = { thumbsup: '+1', thumbs_up: '+1', thumbsdown: '-1', thumbs_down: '-1', thinking_face: 'thinking', slight_smile: 'slightly_smiling_face', slight_frown: 'slightly_frowning_face', satisfied: 'laughing', facepunch: 'punch', hankey: 'poop', shit: 'poop', hocho: 'knife' };
// Mattermost names system emoji after Unicode (hugging_face, face_with_tears_of_joy…),
// which node-emoji often spells differently.
const unicodeGlyph = (name: string) => unicodeEmoji(ALIASES[name] ?? name) ?? MATTERMOST_EMOJI_NAMES[name];
export const emojiGlyph = (name: string) => unicodeGlyph(name.toLowerCase());
const NODE_UNICODE = allEmoji('').map(({ name, emoji }) => ({ name, value: emoji, kind: 'unicode' as const }));
const NODE_NAMES = new Set(NODE_UNICODE.map((emoji) => emoji.name));
const UNICODE = [...NODE_UNICODE, ...Object.entries(MATTERMOST_EMOJI_NAMES).filter(([name]) => !NODE_NAMES.has(name)).map(([name, value]) => ({ name, value, kind: 'unicode' as const }))];
const SPANISH: Record<string, string> = { sonrisa: 'smile', feliz: 'smile', corazon: 'heart', gracias: 'pray', pulgar: 'thumbsup', fiesta: 'tada', cohete: 'rocket', pensar: 'thinking', ojos: 'eyes', aprobado: 'check', aplauso: 'clap', saludo: 'wave' };

export const isUnicodeEmoji = (name: string) => Boolean(unicodeGlyph(name));
export const validEmojiName = (name: unknown): name is string => typeof name === 'string' && VALID_NAME.test(name);

export function recentEmojiNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(validEmojiName))].slice(0, 24);
}

export function rememberEmoji(names: string[], name: string): string[] {
  return validEmojiName(name) ? recentEmojiNames([name, ...names]) : recentEmojiNames(names);
}

export function findEmojiCompletion(text: string, start: number, end = start): EmojiCompletion | null {
  if (start !== end || start < 0 || start > text.length) return null;
  const prefix = text.slice(0, start);
  // A token starts at a prose boundary. URLs, times, escaped colons and a
  // completed shortcode never start a completion session.
  const match = prefix.match(/(?:^|[\s([{.,!?]):([a-zA-Z0-9_+\-]{0,64})$/);
  if (!match) return null;
  const colon = start - match[1].length - 1;
  const preceding = text.slice(0, colon);
  const fenceCount = (preceding.match(/^\s*```/gm) ?? []).length;
  const inlineTicks = (preceding.split('\n').at(-1)?.match(/`/g) ?? []).length;
  if (fenceCount % 2 || inlineTicks % 2) return null;
  return { start: colon, end: start, query: match[1].toLowerCase() };
}

export function insertEmoji(text: string, start: number, end: number, value: string, maxLength = 16_000): { text: string; cursor: number } | null {
  const from = Math.max(0, Math.min(text.length, Math.trunc(start)));
  const to = Math.max(from, Math.min(text.length, Math.trunc(end)));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const result = text.slice(0, from) + value + text.slice(to);
  if (result.length > maxLength) return null;
  return { text: result, cursor: from + value.length };
}

export function searchEmojiOptions(query: string, customNames: string[], recent: string[], scope: EmojiScope = 'all', limit = 72): EmojiOption[] {
  const normalized = query.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/^:|:$/g, '').slice(0, 64);
  const term = SPANISH[normalized] ?? normalized.replace(/\s+/g, '_');
  const needle = ALIASES[term] ?? term;
  const customs = [...new Set(customNames.filter(validEmojiName))].filter((name) => !isUnicodeEmoji(name)).map((name) => ({ name, value: `:${name}:`, kind: 'custom' as const }));
  const allowedCustoms = new Set(customs.map((emoji) => emoji.name));
  const named = (name: string): EmojiOption[] => {
    const unicode = unicodeGlyph(name);
    if (unicode) return [{ name, value: unicode, kind: 'unicode' }];
    return allowedCustoms.has(name) ? [{ name, value: `:${name}:`, kind: 'custom' }] : [];
  };
  const candidates = scope === 'custom' ? customs : scope === 'recent' ? recent.flatMap(named)
    : normalized ? [...UNICODE, ...customs] : [...recent.flatMap(named), ...POPULAR.flatMap(named), ...customs, ...UNICODE];
  const seen = new Set<string>();
  const matches = candidates.filter((emoji) => {
    if ((needle && !emoji.name.includes(needle)) || seen.has(emoji.name)) return false;
    seen.add(emoji.name); return true;
  });
  if (needle) matches.sort((left, right) => Number(right.name === needle) - Number(left.name === needle)
    || Number(right.name.startsWith(needle)) - Number(left.name.startsWith(needle)) || left.name.localeCompare(right.name));
  return matches.slice(0, Math.max(0, Math.min(3_000, limit)));
}

export function customShortcodes(texts: string[]): string[] {
  return [...new Set(texts.flatMap((text) => Array.from(text.matchAll(/:([A-Za-z0-9_+\-]{1,64}):/g), (match) => match[1].toLowerCase())))].filter((name) => !isUnicodeEmoji(name));
}

export function normalizeEmojiAliases(text: string): string {
  return text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g).map((part, index) => index % 2 ? part : part.replace(/:([A-Za-z0-9_+\-]{1,64}):/g, (token, name: string) => ALIASES[name.toLowerCase()] ? unicodeGlyph(name.toLowerCase()) ?? token : token)).join('');
}
