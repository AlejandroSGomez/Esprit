import { getAppTimeZone } from './appConfig';
/**
 * Plain-text email structure for the reader: the message itself, the
 * signature and the quoted history each render differently, so a long reply
 * chain no longer looks like one wall of text.
 */
export type MailPart = { kind: 'text'; value: string } | { kind: 'link'; value: string; href: string };
export type MailParagraph = MailPart[][];
export type ParsedMail = {
  paragraphs: MailParagraph[];
  signature: string[];
  quote: { header: string; body: string } | null;
};

/** Lines that open the quoted previous message in Gmail, Outlook and Apple Mail. */
const QUOTE_OPENERS: RegExp[] = [
  /^(?:El|On)\b.{4,240}\b(?:escribió|wrote|a écrit|schrieb)\s*:?\s*$/i,
  /^-{2,}\s*(?:Original Message|Mensaje original|Forwarded message|Mensaje reenviado)\s*-{2,}/i,
  /^_{8,}\s*$/,
];
const OUTLOOK_FIELDS = /^(?:De|From|Enviado|Sent|Fecha|Date|Para|To|Asunto|Subject|CC)\s*:/i;
/** Closing words after which signature-looking lines fold away. */
const CLOSINGS = /^(?:un\s+(?:abrazo|saludo|beso)|saludos(?:\s+cordiales)?|(?:muchas\s+)?gracias|atentamente|cordialmente|best(?:\s+(?:regards|wishes))?|kind\s+regards|regards|cheers|thanks|un\s+fuerte\s+abrazo)\b[.,!]*\s*$/i;
const SIGNATURE_LINE = /^(?:dr\.?|dra\.?|prof\.?|dpto\.?|departamento|facultad|universidad|instituto|campus|cantoblanco|c\/|avda\.?|phone|tel[ée]?fono|tel\.?|fax|mobile|m[óo]vil|e-?mail|web|https?:\/\/|www\.|\+?\d[\d\s()./-]{6,}$)/i;

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+[^\s<>"')\].,;:!?]/gi;

/** Splits text into plain parts and links (http, https and www only). */
export function linkify(text: string): MailPart[] {
  const parts: MailPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ kind: 'text', value: text.slice(cursor, index) });
    const raw = match[0];
    const href = raw.startsWith('www.') ? `https://${raw}` : raw;
    parts.push({ kind: 'link', value: shortUrl(href), href });
    cursor = index + raw.length;
  }
  if (cursor < text.length) parts.push({ kind: 'text', value: text.slice(cursor) });
  return parts;
}

/** `dauam-my.sharepoint.com/…/IgDZhE5T…` instead of a 150-character address. */
export function shortUrl(href: string) {
  try {
    const url = new URL(href);
    const path = url.pathname.replace(/\/$/, '');
    const host = url.host.replace(/^www\./, '');
    if (!path && !url.search) return host;
    const segments = path.split('/').filter(Boolean);
    const last = segments.at(-1) ?? '';
    const tail = last.length > 18 ? `${last.slice(0, 16)}…` : last;
    return segments.length > 1 ? `${host}/…/${tail}` : `${host}/${tail}${url.search && !tail ? '…' : ''}`;
  } catch {
    return href.length > 60 ? `${href.slice(0, 57)}…` : href;
  }
}

/** Where the quoted history starts, and how many lines its header spans. */
function quoteStart(lines: string[]): { index: number; span: number } {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    // "El lun, 28 sept 2026 a las 12:27, X <x@y>" often wraps before "escribió:".
    const joined = `${line} ${lines[index + 1]?.trim() ?? ''}`.trim();
    if (QUOTE_OPENERS.some((pattern) => pattern.test(line))) return { index, span: 1 };
    if (/^(?:El|On)\b/i.test(line) && QUOTE_OPENERS[0].test(joined)) return { index, span: 2 };
    if (OUTLOOK_FIELDS.test(line)) {
      const window = lines.slice(index, index + 6).filter((value) => OUTLOOK_FIELDS.test(value.trim()));
      if (window.length >= 3) return { index, span: 0 };
    }
    if (line.startsWith('>') && lines.slice(index).filter((value) => value.trim()).every((value) => value.trim().startsWith('>'))) return { index, span: 0 };
  }
  return { index: -1, span: 0 };
}

function signatureStart(lines: string[]) {
  const dash = lines.findIndex((line) => line === '-- ' || line.trim() === '--');
  if (dash >= 0) return { closing: dash, fold: dash + 1 };
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!CLOSINGS.test(lines[index].trim())) continue;
    // Keep the closing and the name; fold the block of title, address and phones.
    const nameLine = lines.slice(index + 1).findIndex((line) => line.trim());
    const fold = nameLine < 0 ? lines.length : index + 1 + nameLine + 1;
    const rest = lines.slice(fold).filter((line) => line.trim());
    const signatureLike = rest.filter((line) => SIGNATURE_LINE.test(line.trim()) || line.trim().length <= 48).length;
    if (rest.length >= 2 && signatureLike / rest.length >= 0.6) return { closing: index, fold };
    return null;
  }
  return null;
}

/** Collapses runs of blank lines and trailing spaces. */
export function tidy(text: string) {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t ]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function parseMail(text: string): ParsedMail {
  const lines = tidy(text).split('\n');
  const { index: start, span } = quoteStart(lines);
  const own = start >= 0 ? lines.slice(0, start) : lines;
  const quoted = start >= 0 ? lines.slice(start) : [];
  let visible = own;
  let signature: string[] = [];
  const cut = signatureStart(own);
  if (cut) {
    visible = own.slice(0, cut.fold);
    signature = own.slice(cut.fold).map((line) => line.trim()).filter(Boolean);
  }
  const paragraphs = visible.join('\n').replace(/\n{2,}/g, '\n\n').split('\n\n').map((block) => block.split('\n').map((line) => linkify(line))).filter((block) => block.some((line) => line.some((part) => part.value.trim())));
  let quote: ParsedMail['quote'] = null;
  if (quoted.length) {
    // A "De:/Enviado:" block stays visible inside the quote; a one- or two-line
    // "El … escribió:" header becomes its label.
    const header = span ? quoted.slice(0, span).map((line) => line.trim()).join(' ') : '';
    const body = quoted.slice(span).filter((line, index) => span || index || !/^_{8,}\s*$/.test(line.trim())).map((line) => line.replace(/^\s*>\s?/, '')).join('\n');
    const label = header.replace(/^[-_\s]+|[-_\s]+$/g, '') || (quoted[0].trim().startsWith('>') ? 'Mensaje citado' : (quoted.find((line) => /^(?:De|From)\s*:/i.test(line.trim()))?.trim() ?? 'Mensaje anterior'));
    quote = { header: label, body: tidy(body) };
  }
  return { paragraphs, signature, quote };
}

/** First meaningful line of a message, for collapsed thread rows. */
export function mailPreview(text: string) {
  const parsed = parseMail(text);
  const first = parsed.paragraphs.flat().map((line) => line.map((part) => part.value).join('')).find((line) => line.trim() && !/^(?:hola|buenas|hi|hello|dear|querid[oa]s?)\b[^.]{0,40}[,.!]?$/i.test(line.trim()));
  return (first ?? parsed.paragraphs.flat().map((line) => line.map((part) => part.value).join('')).find((line) => line.trim()) ?? '').trim().slice(0, 180);
}

/** Epoch milliseconds (as Gmail threads return them) or any date string. */
export function mailDate(value: string) {
  const numeric = /^\d{10,13}$/.test(value.trim()) ? Number(value.trim()) : NaN;
  const date = Number.isFinite(numeric) ? new Date(value.trim().length === 10 ? numeric * 1000 : numeric) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatMailMoment(value: string, now = new Date()) {
  const date = mailDate(value);
  if (!date) return value;
  const time = date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: getAppTimeZone() });
  const day = (target: Date) => target.toLocaleDateString('en-CA', { timeZone: getAppTimeZone() });
  if (day(date) === day(now)) return `Hoy · ${time}`;
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (day(date) === day(yesterday)) return `Ayer · ${time}`;
  const sameYear = date.toLocaleDateString('en-CA', { timeZone: getAppTimeZone(), year: 'numeric' }) === now.toLocaleDateString('en-CA', { timeZone: getAppTimeZone(), year: 'numeric' });
  return `${date.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric', timeZone: getAppTimeZone() })} · ${time}`;
}

/** "Francesca, Antonio y 5 más" from a raw To header. */
export function recipientSummary(to: string, limit = 2) {
  const names = to.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((value) => value.trim()).filter(Boolean).map((value) => {
    const name = value.replace(/<[^>]*>/g, '').replace(/"/g, '').trim();
    return (name || value.replace(/[<>]/g, '')).split(/\s+/)[0];
  });
  if (names.length <= limit + 1) return names.join(', ');
  return `${names.slice(0, limit).join(', ')} y ${names.length - limit} más`;
}
