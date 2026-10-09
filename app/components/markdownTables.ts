export type CellAlignment = 'left' | 'center' | 'right' | null;

export type MarkdownTable = {
  /** Número de la primera línea, 1-indexado, como en CodeMirror. */
  firstLine: number;
  /** Número de la última línea, inclusive. */
  lastLine: number;
  header: string[];
  alignments: CellAlignment[];
  rows: string[][];
};

/**
 * Divide una fila de tabla GFM por barras sin escapar.
 *
 * Descarta la celda vacía que dejan las barras exteriores, para que
 * `| a | b |` y `a | b` produzcan las mismas dos celdas.
 */
export function splitTableRow(text: string): string[] | null {
  if (!text.includes('|')) return null;
  const trimmed = text.trim();
  const cells: string[] = [];
  let current = '';
  let protectedUntil = -1;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    // Scientific notes often put |psi> or |x| inside inline math/code. Treat
    // those paired spans as one cell, while a lone dollar/backtick stays text.
    if (index >= protectedUntil) {
      if (character === '`') {
        const fence = /^`+/.exec(trimmed.slice(index))![0];
        const end = trimmed.indexOf(fence, index + fence.length);
        if (end >= 0) protectedUntil = end + fence.length;
      } else if (character === '$') {
        const end = trimmed.slice(index + 1).search(/(?<!\\)\$/);
        if (end >= 0) protectedUntil = index + end + 2;
      } else if (character === '\\' && trimmed[index + 1] === '(') {
        const end = trimmed.indexOf('\\)', index + 2);
        if (end >= 0) protectedUntil = end + 2;
      }
    }
    if (character === '\\' && index + 1 < trimmed.length) {
      const next = trimmed[index + 1];
      if (next === '|') {
        current += '|';
        index += 1;
        continue;
      }
      // Consume escaped backslashes/punctuation together: \\| is a separator,
      // whereas \\\| escapes the pipe. Preserve all non-pipe source escapes.
      if ('\\`$'.includes(next)) {
        current += character + next;
        index += 1;
        continue;
      }
    }
    if (character === '|' && index >= protectedUntil) {
      cells.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  cells.push(current);
  if (cells.length > 1 && !cells[0].trim()) cells.shift();
  if (cells.length > 1 && !cells[cells.length - 1].trim()) cells.pop();
  return cells.length ? cells.map((cell) => cell.trim()) : null;
}

export const isDelimiterCell = (cell: string) => /^:?-+:?$/.test(cell);

export const alignmentOf = (cell: string): CellAlignment => {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
};

/**
 * Localiza las tablas GFM de un documento: una fila de cabecera seguida de una
 * de guiones con el mismo número de celdas, y después las filas que sigan
 * teniendo barras.
 *
 * `skip` marca las líneas que ya pertenecen a un bloque de código o a una
 * ecuación, para no interpretar su contenido como una tabla.
 */
export function findMarkdownTables(lines: string[], skip: (lineNumber: number) => boolean): MarkdownTable[] {
  const tables: MarkdownTable[] = [];
  const total = lines.length;
  let number = 1;
  while (number < total) {
    if (skip(number) || skip(number + 1)) {
      number += 1;
      continue;
    }
    const header = splitTableRow(lines[number - 1]);
    const delimiter = header ? splitTableRow(lines[number]) : null;
    if (!header || !delimiter || delimiter.length !== header.length || !delimiter.every(isDelimiterCell)) {
      number += 1;
      continue;
    }

    const rows: string[][] = [];
    let last = number + 1;
    while (last < total) {
      const next = last + 1;
      if (skip(next)) break;
      const cells = splitTableRow(lines[next - 1]);
      if (!cells) break;
      rows.push(cells);
      last = next;
    }

    tables.push({
      firstLine: number,
      lastLine: last,
      header,
      alignments: delimiter.map(alignmentOf),
      rows,
    });
    number = last + 1;
  }
  return tables;
}
