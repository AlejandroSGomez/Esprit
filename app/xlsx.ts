/**
 * Minimal .xlsx reader/writer for the explorer. Reading shows values, formulas
 * and dates; writing touches only the edited cells of the edited sheets and
 * copies every other part of the package byte for byte, so styles, widths,
 * merged cells, charts and other sheets survive. Formulas are recomputed by
 * Excel on open (fullCalcOnLoad).
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';

/** Reject oversized Office packages before allocating their inflated entries. */
export function readOfficePackage(bytes: Uint8Array): Record<string, Uint8Array> {
  let total = 0, count = 0;
  return unzipSync(bytes, { filter: file => {
    total += file.originalSize;
    if (++count > 4096 || file.originalSize > 32 * 1_048_576 || total > 128 * 1_048_576) {
      throw new Error('El documento Office supera el límite de vista previa. Ábrelo con su aplicación.');
    }
    return true;
  } });
}

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const MAX_ROWS = 2000;
export const MAX_COLS = 120;

export type Cell = { ref: string; value: string; formula: string | null; kind: 'string' | 'number' | 'bool' | 'error' | 'date' | 'empty' };
export type Sheet = { name: string; path: string; cells: Map<string, Cell>; rows: number; cols: number; truncated: boolean; editProblem?: string };
export type Workbook = { files: Record<string, Uint8Array>; sheets: Sheet[] };

export const columnName = (index: number) => { let name = ''; for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + ((value - 1) % 26)) + name; return name; };
export const parseRef = (ref: string) => {
  const match = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!match) return null;
  const col = [...match[1]].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  return { col, row: Number(match[2]) - 1 };
};
export const cellRef = (row: number, col: number) => `${columnName(col)}${row + 1}`;

const parse = (text: string) => new DOMParser().parseFromString(text, 'application/xml');
const children = (node: Element | Document, name: string) => [...node.getElementsByTagNameNS(MAIN, name)];
const resolve = (base: string, target: string) => {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const piece of target.split('/')) { if (piece === '..') parts.pop(); else if (piece !== '.') parts.push(piece); }
  return parts.join('/');
};

/** Excel serial date → yyyy-mm-dd (hh:mm). */
export function serialDate(serial: number, date1904 = false) {
  if (!Number.isFinite(serial)) return String(serial);
  // Excel retains the fictitious leap day 1900-02-29 at serial 60.
  const epoch = date1904 ? 24107 : serial < 60 ? 25568 : 25569;
  const date = new Date(Math.round((serial - epoch) * 86400 * 1000));
  if (!Number.isFinite(date.getTime())) return String(serial);
  const iso = !date1904 && Math.floor(serial) === 60 ? `1900-02-29${date.toISOString().slice(10)}` : date.toISOString();
  return serial % 1 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

/** Translate A1 references without touching strings, sheet names or table columns. */
export function translateFormula(formula: string, from: string, to: string) {
  const origin = parseRef(from), target = parseRef(to);
  if (!origin || !target) throw new Error('Referencia de fórmula inválida.');
  const dc = target.col - origin.col, dr = target.row - origin.row;
  // Quoted strings/names and bracketed workbook/structured references are tokens.
  const tokens = /"(?:[^"]|"")*"|'(?:[^']|'')*'|\[[^\]]*\]|(?:[A-Za-z_][\w.]*)(?::[A-Za-z_][\w.]*)?!|\$?[A-Za-z]{1,3}\$?\d+|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?\d+:\$?\d+/g;
  const shift = (part: string, column: boolean) => {
    if (part.startsWith('$')) return part;
    const n = column ? parseRef(`${part.toUpperCase()}1`)!.col + dc : Number(part) - 1 + dr;
    return n < 0 || n >= (column ? 16384 : 1048576) ? '#REF!' : column ? columnName(n) : String(n + 1);
  };
  return formula.replace(tokens, (token, offset: number) => {
    if (/^["'[]/.test(token) || token.endsWith('!')) return token;
    const before = formula[offset - 1] ?? '', after = formula[offset + token.length] ?? '';
    if (/[\p{L}\p{N}_.]/u.test(before) || /[\p{L}\p{N}_.(]/u.test(after)) return token; // names, LOG10(...)
    if (token.includes(':')) return token.split(':').map((part: string) => shift(part, /[A-Za-z]/.test(part))).join(':');
    const match = /^(\$?)([A-Za-z]+)(\$?)(\d+)$/.exec(token)!;
    const position = parseRef(`${match[2].toUpperCase()}${match[4]}`)!;
    if (position.col >= 16384 || position.row >= 1048576) return token;
    const col = shift(match[1] + match[2], true), row = shift(match[3] + match[4], false);
    return col === '#REF!' || row === '#REF!' ? '#REF!' : col + row;
  });
}

/** Expand shared formulas before editing a master; unsupported arrays stay read-only. */
function expandShared(doc: Document): string | undefined {
  const formulas = children(doc, 'f');
  if (formulas.some((f) => ['array', 'dataTable'].includes(f.getAttribute('t') ?? ''))) return 'Esta hoja usa fórmulas matriciales o tablas de cálculo. Edítala en Excel para conservarlas.';
  const masters = new Map<string, { ref: string; text: string }>();
  for (const f of formulas) if (f.getAttribute('t') === 'shared' && f.textContent?.trim()) {
    const id = f.getAttribute('si'), ref = f.parentElement?.getAttribute('r');
    if (id === null || !ref || masters.has(id)) return 'No se pudo resolver una fórmula compartida. Edítala en Excel.';
    masters.set(id, { ref, text: f.textContent });
  }
  for (const f of formulas) if (f.getAttribute('t') === 'shared') {
    const master = masters.get(f.getAttribute('si') ?? ''), ref = f.parentElement?.getAttribute('r');
    if (!master || !ref) return 'Falta la fórmula maestra de una celda. Edítala en Excel.';
    f.textContent = translateFormula(master.text, master.ref, ref);
    for (const attr of ['t', 'si', 'ref']) f.removeAttribute(attr);
  }
  return undefined;
}

function dateStyles(files: Record<string, Uint8Array>) {
  const styles = files['xl/styles.xml'];
  const dates = new Set<number>();
  if (!styles) return dates;
  const doc = parse(strFromU8(styles));
  const custom = new Map(children(doc, 'numFmt').map((node) => [Number(node.getAttribute('numFmtId')), node.getAttribute('formatCode') ?? '']));
  const isDate = (id: number) => (id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /(^|[^"\\])[dmy]/i.test((custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, ''));
  const xfs = children(doc, 'cellXfs')[0];
  if (xfs) children(xfs, 'xf').forEach((xf, index) => { if (isDate(Number(xf.getAttribute('numFmtId') ?? 0))) dates.add(index); });
  return dates;
}

export function readWorkbook(bytes: Uint8Array): Workbook {
  const files = readOfficePackage(bytes);
  const workbook = files['xl/workbook.xml'];
  if (!workbook) throw new Error('No es un libro de Excel (.xlsx) válido.');
  const rels = files['xl/_rels/workbook.xml.rels'] ? parse(strFromU8(files['xl/_rels/workbook.xml.rels'])) : null;
  const targets = new Map([...(rels?.getElementsByTagName('Relationship') ?? [])].map((node) => [node.getAttribute('Id') ?? '', resolve('xl/workbook.xml', node.getAttribute('Target') ?? '')]));
  const shared = files['xl/sharedStrings.xml'] ? children(parse(strFromU8(files['xl/sharedStrings.xml'])), 'si').map((si) => children(si, 't').map((node) => node.textContent ?? '').join('')) : [];
  const dates = dateStyles(files);
  const workbookDoc = parse(strFromU8(workbook));
  const date1904 = ['1', 'true'].includes(children(workbookDoc, 'workbookPr')[0]?.getAttribute('date1904') ?? '');
  const sheets = children(workbookDoc, 'sheet').map((node) => {
    const path = targets.get(node.getAttributeNS(REL, 'id') ?? node.getAttribute('r:id') ?? '') ?? '';
    const cells = new Map<string, Cell>();
    let rows = 0, cols = 0, truncated = false;
    const source = files[path];
    let editProblem: string | undefined;
    if (source) {
      const doc = parse(strFromU8(source));
      editProblem = expandShared(doc);
      for (const cell of children(doc, 'c')) {
        const ref = cell.getAttribute('r') ?? '';
        const position = parseRef(ref);
        if (!position) continue;
        if (position.row >= MAX_ROWS || position.col >= MAX_COLS) { truncated = true; continue; }
        const type = cell.getAttribute('t') ?? 'n';
        const raw = children(cell, 'v')[0]?.textContent ?? '';
        const formula = children(cell, 'f')[0]?.textContent ?? null;
        let value = raw, kind: Cell['kind'] = raw === '' ? 'empty' : 'number';
        if (type === 's') { value = shared[Number(raw)] ?? ''; kind = 'string'; }
        else if (type === 'inlineStr') { value = children(cell, 't').map((item) => item.textContent ?? '').join(''); kind = 'string'; }
        else if (type === 'str') kind = 'string';
        else if (type === 'b') { value = raw === '1' ? 'VERDADERO' : 'FALSO'; kind = 'bool'; }
        else if (type === 'e') kind = 'error';
        else if (raw !== '' && dates.has(Number(cell.getAttribute('s') ?? -1))) { value = serialDate(Number(raw), date1904); kind = 'date'; }
        if (kind === 'empty' && formula === null) continue;
        cells.set(ref, { ref, value, formula, kind });
        rows = Math.max(rows, position.row + 1); cols = Math.max(cols, position.col + 1);
      }
    }
    return { name: node.getAttribute('name') ?? 'Hoja', path, cells, rows, cols, truncated, editProblem };
  });
  return { files, sheets };
}

/** Number typed the Spanish way ("3,5", "1.234,5") or plain ("3.5"). */
export function parseNumber(input: string) {
  const text = input.trim();
  if (!/^[-+]?(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$|^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(text)) return null;
  const normalized = /,/.test(text) ? text.replace(/\./g, '').replace(',', '.') : text;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/** Applies edits ({ sheetIndex → { A1 → typed input } }) and returns new .xlsx bytes. */
export function writeWorkbook(book: Workbook, edits: Map<number, Map<string, string>>): Uint8Array {
  const out: Zippable = { ...book.files };
  let formulasTouched = false;
  for (const [index, changes] of edits) {
    const sheet = book.sheets[index];
    if (!sheet || !changes.size) continue;
    const doc = parse(strFromU8(book.files[sheet.path]));
    const problem = expandShared(doc);
    if (problem) throw new Error(problem);
    const data = children(doc, 'sheetData')[0];
    if (!data) continue;
    for (const [ref, input] of changes) {
      const position = parseRef(ref);
      if (!position) continue;
      const rowNumber = String(position.row + 1);
      let row = children(data, 'row').find((node) => node.getAttribute('r') === rowNumber);
      if (!row) {
        row = doc.createElementNS(MAIN, 'row');
        row.setAttribute('r', rowNumber);
        const after = children(data, 'row').find((node) => Number(node.getAttribute('r')) > position.row + 1);
        data.insertBefore(row, after ?? null);
      }
      let cell = children(row, 'c').find((node) => node.getAttribute('r') === ref);
      if (!cell) {
        cell = doc.createElementNS(MAIN, 'c');
        cell.setAttribute('r', ref);
        const after = children(row, 'c').find((node) => (parseRef(node.getAttribute('r') ?? '')?.col ?? 0) > position.col);
        row.insertBefore(cell, after ?? null);
        row.removeAttribute('spans');
      }
      [...cell.childNodes].forEach((node) => cell!.removeChild(node));
      cell.removeAttribute('t');
      const text = input;
      if (text.startsWith('=') && text.length > 1) {
        const formula = doc.createElementNS(MAIN, 'f');
        formula.textContent = text.slice(1);
        cell.appendChild(formula);
        formulasTouched = true;
      } else if (text.trim() === '') {
        // Empty: keep the cell's style, drop its value.
      } else if (parseNumber(text) !== null) {
        const value = doc.createElementNS(MAIN, 'v');
        value.textContent = String(parseNumber(text));
        cell.appendChild(value);
      } else {
        cell.setAttribute('t', 'inlineStr');
        const inline = doc.createElementNS(MAIN, 'is');
        const node = doc.createElementNS(MAIN, 't');
        node.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
        node.textContent = text;
        inline.appendChild(node);
        cell.appendChild(inline);
      }
    }
    // Any formula may now depend on an edited value: its cached result is stale.
    children(doc, 'f').forEach((formula) => { const value = children(formula.parentElement as Element, 'v')[0]; if (value) formula.parentElement!.removeChild(value); });
    formulasTouched = formulasTouched || children(doc, 'f').length > 0;
    out[sheet.path] = strToU8(new XMLSerializer().serializeToString(doc));
  }
  if (formulasTouched || edits.size) {
    const workbook = parse(strFromU8(book.files['xl/workbook.xml']));
    let calc = children(workbook, 'calcPr')[0];
    if (!calc) { calc = workbook.createElementNS(MAIN, 'calcPr'); workbook.documentElement.appendChild(calc); }
    calc.setAttribute('fullCalcOnLoad', '1');
    out['xl/workbook.xml'] = strToU8(new XMLSerializer().serializeToString(workbook));
    // The calculation chain lists formula cells; Excel rebuilds it, and a stale one makes it "repair" the file.
    if (out['xl/calcChain.xml']) {
      delete out['xl/calcChain.xml'];
      for (const [name, strip] of [['[Content_Types].xml', /<Override[^>]*calcChain\.xml"[^>]*\/>/g], ['xl/_rels/workbook.xml.rels', /<Relationship[^>]*calcChain\.xml"[^>]*\/>/g]] as const) {
        if (out[name]) out[name] = strToU8(strFromU8(out[name] as Uint8Array).replace(strip, ''));
      }
    }
  }
  return zipSync(out, { level: 6 });
}

/** Shows the display value and the text the user can edit (formula or raw). */
export const cellInput = (cell: Cell | undefined) => cell ? (cell.formula !== null ? `=${cell.formula}` : cell.value) : '';

/** Text of a .docx or .pptx, for a read-only preview. */
export function officeText(bytes: Uint8Array, name: string) {
  const files = readOfficePackage(bytes);
  const lower = name.toLowerCase();
  if (lower.endsWith('.docx')) {
    const doc = files['word/document.xml'];
    if (!doc) return '';
    return [...parse(strFromU8(doc)).getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'p')].map((paragraph) => [...paragraph.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 't')].map((node) => node.textContent ?? '').join('')).join('\n');
  }
  const slides = Object.keys(files).filter((file) => /^ppt\/slides\/slide\d+\.xml$/.test(file)).sort((left, right) => Number(left.match(/\d+/)![0]) - Number(right.match(/\d+/)![0]));
  return slides.map((file, index) => `— Diapositiva ${index + 1} —\n${[...parse(strFromU8(files[file])).getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 't')].map((node) => node.textContent ?? '').join(' ')}`).join('\n\n');
}

/** CSV/TSV in both directions, with quotes and Excel's semicolon default. */
export function parseCsv(text: string) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = firstLine.includes('\t') ? '\t' : (firstLine.split(';').length > firstLine.split(',').length ? ';' : ',');
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field === '') quoted = true;
    else if (character === delimiter) { row.push(field); field = ''; }
    else if (character === '\n' || character === '\r') { if (character === '\r' && text[index + 1] === '\n') index += 1; row.push(field); rows.push(row); row = []; field = ''; }
    else field += character;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return { rows, delimiter };
}
export function writeCsv(rows: string[][], delimiter: string) {
  const quote = (value: string) => /["\n\r]/.test(value) || value.includes(delimiter) ? `"${value.replace(/"/g, '""')}"` : value;
  return rows.map((row) => row.map(quote).join(delimiter)).join('\n') + '\n';
}
