import type { Text, Transaction } from '@codemirror/state';
import { findMarkdownTables } from './markdownTables';

type MathBlock = { firstLine: number; lastLine: number; expression: string };
type Structure = { fencedLines: Set<number>; mathLines: Set<number>; math: MathBlock[]; tableLines: Set<number>; tables: ReturnType<typeof findMarkdownTables> };
const structures = new WeakMap<Text, Structure>();

/** Structural parsing depends on document text, never on the cursor. */
export const markdownStructure = (doc: Text): Structure => {
  const cached = structures.get(doc);
  if (cached) return cached;
  const fencedLines = new Set<number>();
  let fence = ''; let length = 0;
  const lines: string[] = [];
  for (let number = 1; number <= doc.lines; number += 1) {
    const text = doc.line(number).text;
    lines.push(text);
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(text)?.[1] ?? '';
    if (!fence && marker) { fence = marker[0]; length = marker.length; fencedLines.add(number); }
    else if (fence) {
      fencedLines.add(number);
      if (new RegExp(`^\\s{0,3}${fence}{${length},}\\s*$`).test(text)) { fence = ''; length = 0; }
    }
  }
  const source = doc.toString();
  const mathLines = new Set<number>();
  const math: MathBlock[] = [];
  for (const pattern of [/\$\$([\s\S]+?)\$\$/g, /\\\[([\s\S]+?)\\\]/g]) {
    for (const match of source.matchAll(pattern)) {
      if (!match[0].includes('\n')) continue;
      const first = doc.lineAt(match.index);
      const last = doc.lineAt(match.index + match[0].length);
      if (source.slice(first.from, match.index).trim() || source.slice(match.index + match[0].length, last.to).trim()) continue;
      let fenced = false;
      for (let line = first.number; line <= last.number; line += 1) if (fencedLines.has(line)) { fenced = true; break; }
      if (fenced) continue;
      for (let line = first.number; line <= last.number; line += 1) mathLines.add(line);
      math.push({ firstLine: first.number, lastLine: last.number, expression: match[1].trim() });
    }
  }
  const tables = findMarkdownTables(lines, (number) => fencedLines.has(number) || mathLines.has(number));
  const tableLines = new Set<number>();
  for (const table of tables) for (let line = table.firstLine; line <= table.lastLine; line += 1) tableLines.add(line);
  const result = { fencedLines, mathLines, math, tableLines, tables };
  structures.set(doc, result);
  return result;
};

/** A plain edit on one non-structural line cannot change fences, math or table topology. */
export const incrementalMarkdownLines = (transaction: Transaction): Set<number> | null => {
  const before = transaction.startState;
  const after = transaction.state;
  const structure = markdownStructure(before.doc);
  const lines = new Set<number>();
  let safe = true;
  transaction.changes.iterChanges((fromA, toA, fromB, toB) => {
    const oldLine = before.doc.lineAt(fromA);
    const newLine = after.doc.lineAt(fromB);
    if (oldLine.number !== before.doc.lineAt(toA).number || newLine.number !== after.doc.lineAt(toB).number || before.doc.lines !== after.doc.lines || /[`~$\\|]/.test(oldLine.text + newLine.text) || structure.fencedLines.has(oldLine.number) || structure.mathLines.has(oldLine.number) || structure.tableLines.has(oldLine.number)) safe = false;
    lines.add(newLine.number);
  });
  if (!safe) return null;
  structures.set(after.doc, structure);
  return lines;
};

export const changedMarkdownSelectionLines = (transaction: Transaction): Set<number> => {
  const lines = new Set<number>();
  for (const state of [transaction.startState, transaction.state]) {
    for (const range of state.selection.ranges) {
      lines.add(state.doc.lineAt(range.from).number);
      lines.add(state.doc.lineAt(range.to).number);
    }
  }
  const structure = markdownStructure(transaction.state.doc);
  for (const block of [...structure.math, ...structure.tables]) {
    const activeIn = (state: typeof transaction.state) => state.selection.ranges.some((range) => state.doc.lineAt(range.from).number <= block.lastLine && state.doc.lineAt(range.to).number >= block.firstLine);
    if (activeIn(transaction.startState) !== activeIn(transaction.state) || [...lines].some((line) => line >= block.firstLine && line <= block.lastLine)) {
      for (let line = block.firstLine; line <= block.lastLine; line += 1) lines.add(line);
    }
  }
  return lines;
};
