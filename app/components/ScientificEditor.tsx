'use client';

import { autocompletion, closeBrackets, closeBracketsKeymap, CompletionContext } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory, undo as undoCommand } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, indentUnit, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { c, cpp } from '@codemirror/legacy-modes/mode/clike';
import { fortran } from '@codemirror/legacy-modes/mode/fortran';
import { json } from '@codemirror/legacy-modes/mode/javascript';
import { julia } from '@codemirror/legacy-modes/mode/julia';
import { python } from '@codemirror/legacy-modes/mode/python';
import { r } from '@codemirror/legacy-modes/mode/r';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, Extension, Prec, StateEffect, StateField, Transaction } from '@codemirror/state';
import {
  crosshairCursor,
  Decoration,
  DecorationSet,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  WidgetType,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import katex from 'katex';
import { forwardRef, MutableRefObject, useEffect, useImperativeHandle, useRef } from 'react';
import { findMarkdownImages } from './markdownImageSyntax';
import { type CellAlignment } from './markdownTables';
import { changedMarkdownSelectionLines, incrementalMarkdownLines, markdownStructure } from './markdownStructure';

export type ScientificEditorLanguage =
  | 'markdown'
  | 'latex'
  | 'python'
  | 'julia'
  | 'shell'
  | 'yaml'
  | 'json'
  | 'toml'
  | 'fortran'
  | 'c'
  | 'cpp'
  | 'r'
  | 'plain';
export type ScientificEditorMode = 'live' | 'source';

/// Markdown y LaTeX son superficies de prosa: corrector, ajuste de línea,
/// imágenes arrastrables y su propia barra de formato. El resto son
/// superficies de código: monoespaciada, sin ajuste y sin corrector.
export const isProseEditorLanguage = (language: ScientificEditorLanguage) => (
  language === 'markdown' || language === 'latex'
);

const EXTENSION_LANGUAGES: Record<string, ScientificEditorLanguage> = {
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  tex: 'latex', sty: 'latex', cls: 'latex', bbl: 'latex',
  py: 'python', pyi: 'python', pyx: 'python',
  jl: 'julia',
  sh: 'shell', bash: 'shell', zsh: 'shell', sbatch: 'shell', slurm: 'shell',
  yaml: 'yaml', yml: 'yaml',
  json: 'json', jsonl: 'json', ipynb: 'json',
  toml: 'toml',
  f: 'fortran', f90: 'fortran', f95: 'fortran', for: 'fortran',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  r: 'r',
};

const BASENAME_LANGUAGES: Record<string, ScientificEditorLanguage> = {
  makefile: 'shell',
  dockerfile: 'shell',
  '.gitignore': 'plain',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
};

/// Resuelve el lenguaje del editor a partir del nombre de fichero. Devuelve
/// `plain` cuando no hay modo conocido, que sigue dando gutter, historial,
/// búsqueda e indentación con Tab.
export const editorLanguageForFileName = (name: string): ScientificEditorLanguage => {
  const basename = name.slice(name.lastIndexOf('/') + 1).toLowerCase();
  const byBasename = BASENAME_LANGUAGES[basename];
  if (byBasename) return byBasename;
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) return 'plain';
  return EXTENSION_LANGUAGES[basename.slice(dot + 1)] ?? 'plain';
};

const languageExtensionFor = (language: ScientificEditorLanguage): Extension => {
  switch (language) {
    case 'markdown': return markdown({ base: markdownLanguage });
    case 'latex': return StreamLanguage.define(stex);
    case 'python': return StreamLanguage.define(python);
    case 'julia': return StreamLanguage.define(julia);
    case 'shell': return StreamLanguage.define(shell);
    case 'yaml': return StreamLanguage.define(yaml);
    case 'json': return StreamLanguage.define(json);
    case 'toml': return StreamLanguage.define(toml);
    case 'fortran': return StreamLanguage.define(fortran);
    case 'c': return StreamLanguage.define(c);
    case 'cpp': return StreamLanguage.define(cpp);
    case 'r': return StreamLanguage.define(r);
    default: return [];
  }
};

export type ScientificEditorHandle = {
  focus: () => void;
  insertTrusted: (text: string, position?: number) => void;
  wrap: (before: string, after: string, placeholder: string) => void;
  toggleLinePrefix: (prefix: string, placeholder: string) => void;
  undo: () => void;
  goToLine: (line: number) => void;
};

export type EditorImageDrop = {
  file?: File;
  projectEntryId?: string;
  name: string;
  position?: number;
};

export type ScientificEditorProps = {
  value: string;
  language: ScientificEditorLanguage;
  mode?: ScientificEditorMode;
  assets?: Record<string, string>;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (value: string) => void;
  onRequestSave?: () => void;
  onRequestCompile?: () => void;
  onImageDrop?: (drop: EditorImageDrop) => void;
  /**
   * Abre un enlace del documento. Sin este callback los enlaces se siguen
   * mostrando con su estilo pero no son accionables, que es el comportamiento
   * anterior.
   */
  onOpenLink?: (url: string) => void;
};

const previewRefresh = StateEffect.define<void>();

export function markdownLinkEvents(getOpen: () => ((url: string) => void) | undefined) {
  const hrefAt = (event: Event) => (event.target as HTMLElement | null)?.closest?.('[data-href]')?.getAttribute('data-href');
  return Prec.highest(EditorView.domEventHandlers({
    mousedown: (event) => {
      if (event.button !== 0 || event.altKey || event.shiftKey || !getOpen() || !hrefAt(event)) return false;
      // CodeMirror would move the caret and remove this live decoration before
      // mouseup/click. Keep the target in place until the click is dispatched.
      event.preventDefault();
      return true;
    },
    click: (event) => {
      if (event.button !== 0 || event.altKey || event.shiftKey) return false;
      const href = hrefAt(event);
      const open = getOpen();
      if (!href || !open) return false;
      event.preventDefault();
      open(href);
      return true;
    },
    keydown: (event) => {
      if (event.key !== 'Enter' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
      const href = hrefAt(event);
      const open = getOpen();
      if (!href || !open) return false;
      event.preventDefault(); open(href); return true;
    },
  }));
}

function mathNode(expression: string) {
  const node = document.createElement('span');
  node.className = 'cm-math-widget inline';
  try {
    katex.render(expression, node, { displayMode: false, throwOnError: false, trust: false, strict: 'ignore' });
  } catch {
    node.textContent = expression;
    node.classList.add('invalid');
  }
  return node;
}

/**
 * Marcado en línea dentro de una celda. Se construye con nodos del DOM y nunca
 * con HTML en crudo, así que el contenido del fichero no puede inyectar
 * elementos. El código va primero porque enmascara todo lo demás.
 */
const INLINE_RULES: Array<{ pattern: RegExp; build: (match: RegExpExecArray) => Node }> = [
  { pattern: /`([^`\n]+)`/, build: (match) => { const node = document.createElement('code'); node.textContent = match[1]; return node; } },
  { pattern: /\$([^$\n]+?)\$/, build: (match) => mathNode(match[1]) },
  { pattern: /\\\((.+?)\\\)/, build: (match) => mathNode(match[1]) },
  { pattern: /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/, build: (match) => inlineWrap('span', match[1], 'cm-md-link', match[2]) },
  { pattern: /(\*\*|__)(.+?)\1/, build: (match) => inlineWrap('strong', match[2]) },
  { pattern: /~~(.+?)~~/, build: (match) => inlineWrap('s', match[1]) },
  { pattern: /([*_])(?=\S)([^*_]+?\S)\1/, build: (match) => inlineWrap('em', match[2]) },
];

function inlineWrap(tag: string, inner: string, className?: string, href?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (href) {
    // Mismo atributo que la decoración de la prosa, para que el manejador de
    // clic del editor no tenga que distinguir dónde está el enlace.
    node.setAttribute('data-href', href);
    node.setAttribute('title', href);
    node.setAttribute('role', 'link');
    node.setAttribute('tabindex', '0');
  }
  appendInlineMarkdown(node, inner);
  return node;
}

function appendInlineMarkdown(target: HTMLElement, text: string) {
  let rest = text;
  // Cota defensiva: una regla que no consumiera nada colgaría el editor.
  for (let guard = 0; rest && guard < 400; guard += 1) {
    let best: { index: number; match: RegExpExecArray; build: (match: RegExpExecArray) => Node } | null = null;
    for (const rule of INLINE_RULES) {
      const match = rule.pattern.exec(rest);
      if (!match || match[0].length === 0) continue;
      if (!best || match.index < best.index) best = { index: match.index, match, build: rule.build };
    }
    if (!best) break;
    if (best.index > 0) target.appendChild(document.createTextNode(rest.slice(0, best.index)));
    target.appendChild(best.build(best.match));
    rest = rest.slice(best.index + best.match[0].length);
  }
  if (rest) target.appendChild(document.createTextNode(rest));
}

class TableWidget extends WidgetType {
  constructor(
    private readonly header: string[],
    private readonly alignments: CellAlignment[],
    private readonly rows: string[][],
  ) { super(); }

  private signature() {
    return JSON.stringify([this.header, this.alignments, this.rows]);
  }

  eq(other: TableWidget) { return other.signature() === this.signature(); }

  toDOM() {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-md-table';
    const table = document.createElement('table');

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    this.header.forEach((cell, index) => {
      const th = document.createElement('th');
      const alignment = this.alignments[index];
      if (alignment) th.style.textAlign = alignment;
      appendInlineMarkdown(th, cell);
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    table.appendChild(head);

    const body = document.createElement('tbody');
    this.rows.forEach((row) => {
      const tr = document.createElement('tr');
      // GFM: las celdas sobrantes se descartan y las que faltan quedan vacías.
      for (let index = 0; index < this.header.length; index += 1) {
        const td = document.createElement('td');
        const alignment = this.alignments[index];
        if (alignment) td.style.textAlign = alignment;
        appendInlineMarkdown(td, row[index] ?? '');
        tr.appendChild(td);
      }
      body.appendChild(tr);
    });
    table.appendChild(body);

    wrapper.appendChild(table);
    return wrapper;
  }

  ignoreEvent() { return false; }
}

class MathWidget extends WidgetType {
  constructor(private readonly expression: string, private readonly displayMode: boolean) { super(); }

  eq(other: MathWidget) {
    return other.expression === this.expression && other.displayMode === this.displayMode;
  }

  toDOM() {
    const node = document.createElement(this.displayMode ? 'div' : 'span');
    node.className = this.displayMode ? 'cm-math-widget display' : 'cm-math-widget inline';
    try {
      katex.render(this.expression, node, { displayMode: this.displayMode, throwOnError: false, trust: false, strict: 'ignore' });
    } catch {
      node.textContent = this.expression;
      node.classList.add('invalid');
    }
    return node;
  }

  ignoreEvent() { return false; }
}

class ImageWidget extends WidgetType {
  constructor(private readonly src: string, private readonly alt: string, private readonly block: boolean) { super(); }

  eq(other: ImageWidget) { return other.src === this.src && other.alt === this.alt && other.block === this.block; }

  toDOM(view: EditorView) {
    const figure = document.createElement(this.block ? 'figure' : 'span');
    figure.className = `cm-markdown-image ${this.block ? 'block' : 'inline'}`;
    const image = document.createElement('img');
    image.src = this.src;
    image.alt = this.alt;
    image.draggable = false;
    image.addEventListener('load', () => view.requestMeasure(), { once: true });
    figure.appendChild(image);
    if (this.alt) {
      const caption = document.createElement(this.block ? 'figcaption' : 'span');
      caption.className = 'cm-markdown-image-caption';
      caption.textContent = this.alt;
      figure.appendChild(caption);
    }
    return figure;
  }

  ignoreEvent() { return false; }
}

class MarkdownPrefixWidget extends WidgetType {
  constructor(private readonly label: string, private readonly kind: 'list' | 'task', private readonly checked = false) { super(); }

  eq(other: MarkdownPrefixWidget) { return other.label === this.label && other.kind === this.kind && other.checked === this.checked; }

  toDOM() {
    const node = document.createElement('span');
    node.className = `cm-md-prefix ${this.kind}${this.checked ? ' checked' : ''}`;
    node.textContent = this.label;
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  ignoreEvent() { return false; }
}

type DecorationCandidate = { from: number; to: number; decoration: Decoration };

const codeSpans = (text: string) => {
  const ranges: Array<[number, number]> = [];
  const matcher = /`+[^`]*`+/g;
  for (const match of text.matchAll(matcher)) ranges.push([match.index, match.index + match[0].length]);
  return ranges;
};

const overlaps = (from: number, to: number, ranges: Array<[number, number]>) => ranges.some(([start, end]) => from < end && to > start);

export function markdownDecorations(state: EditorState, assets: Record<string, string>, onlyLines?: Set<number>): DecorationSet {
  const candidates: DecorationCandidate[] = [];
  const activeLines = new Set<number>();
  for (const range of state.selection.ranges) {
    activeLines.add(state.doc.lineAt(range.from).number);
    activeLines.add(state.doc.lineAt(range.to).number);
  }
  const { fencedLines, mathLines: multilineMathLines, math, tableLines, tables } = markdownStructure(state.doc);
  const includesBlock = (first: number, last: number) => !onlyLines || [...onlyLines].some((number) => number >= first && number <= last);
  for (const block of math) {
    if (!includesBlock(block.firstLine, block.lastLine)) continue;
    const firstLine = state.doc.line(block.firstLine);
    const lastLine = state.doc.line(block.lastLine);
    const active = state.selection.ranges.some((range) => range.from <= lastLine.to && range.to >= firstLine.from);
    if (!active) candidates.push({ from: firstLine.from, to: lastLine.to, decoration: Decoration.replace({ widget: new MathWidget(block.expression, true), block: true }) });
  }
  for (const table of tables) {
    if (!includesBlock(table.firstLine, table.lastLine)) continue;
    const firstLine = state.doc.line(table.firstLine);
    const lastLine = state.doc.line(table.lastLine);
    const active = state.selection.ranges.some((range) => range.from <= lastLine.to && range.to >= firstLine.from);
    if (!active) candidates.push({ from: firstLine.from, to: lastLine.to, decoration: Decoration.replace({ widget: new TableWidget(table.header, table.alignments, table.rows), block: true }) });
  }
  const lineNumbers = onlyLines ? [...onlyLines].sort((left, right) => left - right) : Array.from({ length: state.doc.lines }, (_, index) => index + 1);
  for (const number of lineNumbers) {
    const line = state.doc.line(number);
    const text = line.text;
    if (fencedLines.has(number) || multilineMathLines.has(number) || tableLines.has(number)) continue;
    const active = activeLines.has(number);
    const occupied = codeSpans(text);

    const heading = /^(\s{0,3})(#{1,6})(\s+)/.exec(text);
    if (heading) {
      const level = heading[2].length;
      candidates.push({ from: line.from, to: line.from, decoration: Decoration.line({ class: `cm-md-heading cm-md-h${level}` }) });
      if (!active) {
        const from = line.from + heading[1].length;
        const to = from + heading[2].length + heading[3].length;
        candidates.push({ from, to, decoration: Decoration.replace({}) });
      }
    }

    if (!active) {
      for (const match of findMarkdownImages(text)) {
        const source = match.source;
        if (!Object.prototype.hasOwnProperty.call(assets, source) || typeof assets[source] !== 'string') continue;
        const preview = assets[source];
        const localFrom = match.from;
        const localTo = match.to;
        if (overlaps(localFrom, localTo, occupied)) continue;
        const block = text.trim() === text.slice(localFrom, localTo);
        const from = block ? line.from : line.from + localFrom;
        const to = block ? line.to : line.from + localTo;
        occupied.push([localFrom, localTo]);
        candidates.push({ from, to, decoration: Decoration.replace({ widget: new ImageWidget(preview, match.alt, block), block }) });
      }

      for (const match of text.matchAll(/\$\$([^$]+)\$\$/g)) {
        const localFrom = match.index;
        const localTo = localFrom + match[0].length;
        if (overlaps(localFrom, localTo, occupied)) continue;
        occupied.push([localFrom, localTo]);
        const block = text.trim() === match[0];
        candidates.push({
          from: block ? line.from : line.from + localFrom,
          to: block ? line.to : line.from + localTo,
          decoration: Decoration.replace({ widget: new MathWidget(match[1], block), block }),
        });
      }
      for (const match of text.matchAll(/\\\[([^\]]+)\\\]/g)) {
        const localFrom = match.index;
        const localTo = localFrom + match[0].length;
        if (overlaps(localFrom, localTo, occupied)) continue;
        occupied.push([localFrom, localTo]);
        const block = text.trim() === match[0];
        candidates.push({
          from: block ? line.from : line.from + localFrom,
          to: block ? line.to : line.from + localTo,
          decoration: Decoration.replace({ widget: new MathWidget(match[1], block), block }),
        });
      }
      for (const pattern of [/\\\((.+?)\\\)/g, /\$([^$\n]+?)\$/g]) {
        for (const match of text.matchAll(pattern)) {
          const localFrom = match.index;
          const localTo = localFrom + match[0].length;
          if (pattern.source.startsWith('\\$') && (text[localFrom - 1] === '\\' || text[localFrom - 1] === '$' || text[localTo] === '$')) continue;
          if (overlaps(localFrom, localTo, occupied)) continue;
          occupied.push([localFrom, localTo]);
          candidates.push({ from: line.from + localFrom, to: line.from + localTo, decoration: Decoration.replace({ widget: new MathWidget(match[1], false) }) });
        }
      }

      const task = /^(\s*)[-+*]\s+\[([ xX])\]\s+/.exec(text);
      const list = /^(\s*)([-+*]|\d+[.)])\s+/.exec(text);
      if (task) {
        const from = task[1].length;
        occupied.push([from, task[0].length]);
        candidates.push({
          from: line.from + from,
          to: line.from + task[0].length,
          decoration: Decoration.replace({ widget: new MarkdownPrefixWidget(task[2].toLowerCase() === 'x' ? '☑' : '☐', 'task', task[2].toLowerCase() === 'x') }),
        });
      } else if (list) {
        const from = list[1].length;
        occupied.push([from, list[0].length]);
        const label = /^\d/.test(list[2]) ? `${list[2]} ` : '• ';
        candidates.push({ from: line.from + from, to: line.from + list[0].length, decoration: Decoration.replace({ widget: new MarkdownPrefixWidget(label, 'list') }) });
      }

      for (const match of text.matchAll(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const localFrom = match.index;
        const localTo = localFrom + match[0].length;
        if (text[localFrom - 1] === '!') continue;
        if (overlaps(localFrom, localTo, occupied)) continue;
        const labelFrom = localFrom + 1;
        const labelTo = labelFrom + match[1].length;
        occupied.push([localFrom, localTo]);
        candidates.push({ from: line.from + localFrom, to: line.from + labelFrom, decoration: Decoration.replace({}) });
        candidates.push({
          from: line.from + labelFrom,
          to: line.from + labelTo,
          decoration: Decoration.mark({ class: 'cm-md-link', attributes: { 'data-href': match[2], title: match[2], role: 'link', tabindex: '0' } }),
        });
        candidates.push({ from: line.from + labelTo, to: line.from + localTo, decoration: Decoration.replace({}) });
      }

      for (const match of text.matchAll(/(\*\*|__)(.+?)\1/g)) {
        const localFrom = match.index;
        const localTo = localFrom + match[0].length;
        if (overlaps(localFrom, localTo, occupied)) continue;
        const marker = match[1].length;
        occupied.push([localFrom, localTo]);
        candidates.push({ from: line.from + localFrom, to: line.from + localFrom + marker, decoration: Decoration.replace({}) });
        candidates.push({ from: line.from + localFrom + marker, to: line.from + localTo - marker, decoration: Decoration.mark({ class: 'cm-md-strong' }) });
        candidates.push({ from: line.from + localTo - marker, to: line.from + localTo, decoration: Decoration.replace({}) });
      }
      for (const match of text.matchAll(/~~(.+?)~~/g)) {
        const localFrom = match.index;
        const localTo = localFrom + match[0].length;
        if (overlaps(localFrom, localTo, occupied)) continue;
        occupied.push([localFrom, localTo]);
        candidates.push({ from: line.from + localFrom, to: line.from + localFrom + 2, decoration: Decoration.replace({}) });
        candidates.push({ from: line.from + localFrom + 2, to: line.from + localTo - 2, decoration: Decoration.mark({ class: 'cm-md-strike' }) });
        candidates.push({ from: line.from + localTo - 2, to: line.from + localTo, decoration: Decoration.replace({}) });
      }
      for (const match of text.matchAll(/(^|[^*_])([*_])(?=\S)(.+?\S)\2(?!\2)/g)) {
        const localFrom = match.index + match[1].length;
        const localTo = match.index + match[0].length;
        if (overlaps(localFrom, localTo, occupied)) continue;
        occupied.push([localFrom, localTo]);
        candidates.push({ from: line.from + localFrom, to: line.from + localFrom + 1, decoration: Decoration.replace({}) });
        candidates.push({ from: line.from + localFrom + 1, to: line.from + localTo - 1, decoration: Decoration.mark({ class: 'cm-md-em' }) });
        candidates.push({ from: line.from + localTo - 1, to: line.from + localTo, decoration: Decoration.replace({}) });
      }
    }
  }
  candidates.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(candidates.map((candidate) => candidate.decoration.range(candidate.from, candidate.to)), true);
}

export function livePreview(assetsRef: MutableRefObject<Record<string, string>>) {
  const activeLineKey = (state: EditorState) => state.selection.ranges
    .flatMap((range) => [state.doc.lineAt(range.from).number, state.doc.lineAt(range.to).number])
    .join(':');
  return StateField.define<DecorationSet>({
    create: (state) => markdownDecorations(state, assetsRef.current),
    update: (decorations, transaction) => {
      const activeLineChanged = Boolean(transaction.selection) && activeLineKey(transaction.startState) !== activeLineKey(transaction.state);
      if (transaction.effects.some((effect) => effect.is(previewRefresh))) return markdownDecorations(transaction.state, assetsRef.current);
      if (!transaction.docChanged && !activeLineChanged) return decorations.map(transaction.changes);
      const changed = transaction.docChanged ? incrementalMarkdownLines(transaction) : new Set<number>();
      if (!changed) return markdownDecorations(transaction.state, assetsRef.current);
      for (const line of changedMarkdownSelectionLines(transaction)) changed.add(line);
      const ranges = [...changed].map((number) => transaction.state.doc.line(number));
      const additions = markdownDecorations(transaction.state, assetsRef.current, changed);
      const add = [];
      for (let iterator = additions.iter(); iterator.value; iterator.next()) add.push(iterator.value.range(iterator.from, iterator.to));
      return decorations.map(transaction.changes).update({
        filter: (from, to) => !ranges.some((line) => from <= line.to && to >= line.from),
        add, sort: true,
      });
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

const markdownOptions = [
  { label: 'Título principal', type: 'keyword', apply: '# ' },
  { label: 'Subtítulo', type: 'keyword', apply: '## ' },
  { label: 'Lista', type: 'keyword', apply: '- ' },
  { label: 'Tarea pendiente', type: 'keyword', apply: '- [ ] ' },
  { label: 'Fórmula en línea', type: 'function', apply: '$ecuación$' },
  { label: 'Fórmula en bloque', type: 'function', apply: '$$ecuación$$' },
  { label: 'Imagen', type: 'text', apply: '![descripción](ruta)' },
];

const latexOptions = [
  '\\section{}', '\\subsection{}', '\\begin{equation}\n  \n\\end{equation}', '\\begin{align}\n  \n\\end{align}',
  '\\label{}', '\\ref{}', '\\eqref{}', '\\cite{}', '\\includegraphics[width=\\linewidth]{}', '\\textbf{}', '\\emph{}',
].map((label) => ({ label, type: label.startsWith('\\begin') ? 'keyword' : 'function', apply: label }));

function localCompletions(language: ScientificEditorLanguage) {
  return (context: CompletionContext) => {
    const token = context.matchBefore(language === 'latex' ? /\\?[\w-]*/ : /[\p{L}\p{N}_-]*/u);
    if (!token || (token.from === token.to && !context.explicit)) return null;
    const documentWords = new Set<string>();
    const nearby = context.state.sliceDoc(Math.max(0, context.pos - 25_000), Math.min(context.state.doc.length, context.pos + 25_000));
    for (const match of nearby.matchAll(/[\p{L}][\p{L}\p{N}_-]{3,}/gu)) {
      if (documentWords.size >= 120) break;
      documentWords.add(match[0]);
    }
    const local = [...documentWords].map((label) => ({ label, type: 'text', apply: label }));
    const dictionary = language === 'markdown' ? markdownOptions : language === 'latex' ? latexOptions : [];
    const options = [...dictionary, ...local].map((option) => ({
      ...option,
      apply: typeof option.apply === 'string' ? option.apply.replace(/\n/g, context.state.lineBreak) : option.apply,
    }));
    return { from: token.from, options, validFor: language === 'latex' ? /^\\?[\w-]*$/ : /^[\p{L}\p{N}_-]*$/u };
  };
}

/// `defaultHighlightStyle` de CodeMirror fija colores oscuros y saturados
/// pensados para fondo blanco (`#00f`, `#219`, `#164`, `#708`, `#940`), así que
/// resultaba ilegible en tema oscuro y en cualquier superficie oscura. Este
/// estilo toma cada color de una variable CSS, de modo que el resaltado sigue
/// al tema activo igual que el resto de la interfaz.
const espritHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: tags.lineComment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: tags.blockComment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: tags.docComment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: tags.keyword, color: 'var(--syntax-keyword)', fontWeight: '600' },
  { tag: tags.controlKeyword, color: 'var(--syntax-keyword)', fontWeight: '600' },
  { tag: tags.moduleKeyword, color: 'var(--syntax-keyword)', fontWeight: '600' },
  { tag: tags.operatorKeyword, color: 'var(--syntax-keyword)' },
  { tag: tags.definitionKeyword, color: 'var(--syntax-keyword)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string), tags.inserted], color: 'var(--syntax-string)' },
  { tag: [tags.regexp, tags.escape], color: 'var(--syntax-escape)' },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.atom, tags.null], color: 'var(--syntax-number)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: 'var(--syntax-function)' },
  { tag: [tags.definition(tags.variableName), tags.definition(tags.propertyName)], color: 'var(--syntax-function)' },
  // `builtin`, `qualifier` y `tag` de los modos legacy: sin estas entradas los
  // builtins de Python y Julia (`print`, `len`, `np`) quedarían sin color.
  { tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)], color: 'var(--syntax-type)' },
  { tag: [tags.standard(tags.variableName), tags.tagName], color: 'var(--syntax-type)' },
  { tag: tags.modifier, color: 'var(--syntax-keyword)' },
  { tag: tags.special(tags.variableName), color: 'var(--syntax-property)' },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket], color: 'var(--syntax-operator)' },
  { tag: [tags.meta, tags.annotation, tags.processingInstruction], color: 'var(--syntax-meta)' },
  { tag: [tags.propertyName, tags.attributeName, tags.labelName], color: 'var(--syntax-property)' },
  { tag: tags.variableName, color: 'var(--syntax-variable)' },
  { tag: [tags.deleted, tags.invalid], color: 'var(--syntax-invalid)' },
  { tag: tags.link, color: 'var(--syntax-function)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--syntax-string)', textDecoration: 'underline' },
  { tag: tags.heading, color: 'var(--syntax-keyword)', fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.quote, color: 'var(--syntax-comment)' },
  { tag: [tags.monospace, tags.literal], color: 'var(--syntax-string)' },
]);

/// Superficie de código. Los colores salen de variables CSS que define cada
/// anfitrión, así que Projects conserva su fondo oscuro y el clúster su fondo
/// claro sin que el editor imponga una apariencia nueva.
const codeTheme = EditorView.theme({
  '&': { background: 'var(--code-bg, transparent)', color: 'var(--code-fg, var(--ink))' },
  '.cm-scroller': { fontFamily: 'var(--code-font, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)', fontSize: 'var(--code-size, .72rem)', lineHeight: '1.55' },
  '.cm-content': { padding: '16px 18px 60px', caretColor: 'var(--code-caret, var(--aubergine))' },
  '.cm-gutters': { background: 'var(--code-gutter-bg, transparent)', color: 'var(--code-gutter-fg, var(--muted))', borderRight: '1px solid var(--code-gutter-line, var(--line))' },
  '.cm-activeLine': { backgroundColor: 'var(--code-active-line, color-mix(in srgb, var(--sage) 10%, transparent))' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--code-active-line, color-mix(in srgb, var(--sage) 10%, transparent))' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--code-selection, color-mix(in srgb, var(--sage) 30%, transparent)) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--code-caret, var(--aubergine))' },
});

const baseTheme = EditorView.theme({
  '&': { height: '100%', background: 'transparent', color: 'var(--ink)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-sans)', lineHeight: '1.72', overflow: 'auto' },
  '.cm-content': { minHeight: '100%', padding: '28px clamp(24px, 4vw, 66px) 90px', caretColor: 'var(--aubergine)' },
  '.cm-line': { padding: '0 2px' },
  '.cm-gutters': { background: 'color-mix(in srgb, var(--paper) 92%, var(--surface-soft))', color: 'var(--muted)', borderRight: '1px solid var(--line)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--sage) 10%, transparent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--sage) 30%, transparent) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--aubergine)', borderLeftWidth: '2px' },
  '.cm-tooltip': { border: '1px solid var(--line-strong)', borderRadius: '10px', overflow: 'hidden', background: 'var(--paper)', color: 'var(--ink)', boxShadow: '0 14px 34px color-mix(in srgb, var(--plum) 18%, transparent)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: 'color-mix(in srgb, var(--sage) 20%, var(--paper))', color: 'var(--ink)' },
});

function wrapEditorSelection(view: EditorView, before: string, after: string, placeholder: string) {
  if (view.state.readOnly) return false;
  const selection = view.state.selection.main;
  const selected = view.state.sliceDoc(selection.from, selection.to) || placeholder;
  const normalizedBefore = before.replace(/\r\n|\r|\n/g, view.state.lineBreak);
  const normalizedAfter = after.replace(/\r\n|\r|\n/g, view.state.lineBreak);
  const insertion = `${normalizedBefore}${selected}${normalizedAfter}`;
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert: insertion },
    selection: EditorSelection.range(selection.from + normalizedBefore.length, selection.from + normalizedBefore.length + selected.length),
    scrollIntoView: true,
  });
  return true;
}

function toggleMarkdownLinePrefix(view: EditorView, prefix: string, placeholder: string) {
  if (view.state.readOnly) return false;
  const selection = view.state.selection.main;
  const first = view.state.doc.lineAt(selection.from);
  const finalPosition = !selection.empty && selection.to === view.state.doc.lineAt(selection.to).from ? selection.to - 1 : selection.to;
  const last = view.state.doc.lineAt(Math.max(selection.from, finalPosition));
  if (first.number === last.number && first.text.trim() === '') {
    const indentation = /^\s*/.exec(first.text)?.[0].length ?? 0;
    const from = first.from + indentation;
    view.dispatch({
      changes: { from, insert: `${prefix}${placeholder}` },
      selection: EditorSelection.range(from + prefix.length, from + prefix.length + placeholder.length),
      scrollIntoView: true,
    });
    return true;
  }
  const lines = Array.from({ length: last.number - first.number + 1 }, (_, index) => view.state.doc.line(first.number + index));
  const family = prefix.startsWith('#') ? /^(\s*)#{1,6}\s+/ : /^(\s*)(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
  const remove = lines.every((line) => {
    const familyMatch = family.exec(line.text);
    return Boolean(familyMatch && familyMatch[0] === `${familyMatch[1]}${prefix}`);
  });
  const changes = lines.map((line) => {
    const familyMatch = family.exec(line.text);
    if (remove && familyMatch) return { from: line.from + familyMatch[1].length, to: line.from + familyMatch[0].length, insert: '' };
    if (familyMatch) return { from: line.from + familyMatch[1].length, to: line.from + familyMatch[0].length, insert: prefix };
    const indentation = /^\s*/.exec(line.text)?.[0].length ?? 0;
    return { from: line.from + indentation, insert: prefix };
  });
  view.dispatch({ changes, scrollIntoView: true });
  return true;
}

function continueMarkdownList(view: EditorView) {
  if (view.state.readOnly) return false;
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const line = view.state.doc.lineAt(selection.from);
  const beforeCursor = view.state.sliceDoc(line.from, selection.from);
  const match = /^(\s*)([-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/.exec(beforeCursor);
  if (!match) return false;
  const prefix = match[0];
  if (beforeCursor.trim() === prefix.trim()) {
    view.dispatch({ changes: { from: line.from, to: selection.from, insert: '' } });
    return true;
  }
  const numbered = /^(\s*)(\d+)([.)])(\s+)/.exec(prefix);
  const next = numbered ? `${numbered[1]}${Number(numbered[2]) + 1}${numbered[3]}${numbered[4]}` : prefix.replace(/\[[xX]\]/, '[ ]');
  const insertion = `${view.state.lineBreak}${next}`;
  view.dispatch({ changes: { from: selection.from, insert: insertion }, selection: EditorSelection.cursor(selection.from + insertion.length) });
  return true;
}

const ScientificEditor = forwardRef<ScientificEditorHandle, ScientificEditorProps>(function ScientificEditor({
  value,
  language,
  mode = 'source',
  assets = {},
  disabled = false,
  ariaLabel,
  onChange,
  onRequestSave,
  onRequestCompile,
  onImageDrop,
  onOpenLink,
}, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const publishedValueRef = useRef(value);
  const saveRef = useRef(onRequestSave);
  const compileRef = useRef(onRequestCompile);
  const dropRef = useRef(onImageDrop);
  const openLinkRef = useRef(onOpenLink);
  const assetsRef = useRef(assets);
  const disabledRef = useRef(disabled);
  const previewCompartment = useRef(new Compartment());
  const editableCompartment = useRef(new Compartment());

  onChangeRef.current = onChange;
  saveRef.current = onRequestSave;
  compileRef.current = onRequestCompile;
  dropRef.current = onImageDrop;
  openLinkRef.current = onOpenLink;
  assetsRef.current = assets;
  disabledRef.current = disabled;

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    insertTrusted: (text, position) => {
      const view = viewRef.current;
      if (!view) return;
      const selection = view.state.selection.main;
      const at = typeof position === 'number' ? Math.max(0, Math.min(position, view.state.doc.length)) : selection.from;
      const to = typeof position === 'number' ? at : selection.to;
      const insertion = text.replace(/\r\n|\r|\n/g, view.state.lineBreak);
      view.dispatch({ changes: { from: at, to, insert: insertion }, selection: EditorSelection.cursor(at + insertion.length), scrollIntoView: true });
      view.focus();
    },
    wrap: (before, after, placeholder) => {
      const view = viewRef.current;
      if (!view || disabledRef.current) return;
      wrapEditorSelection(view, before, after, placeholder);
      view.focus();
    },
    toggleLinePrefix: (prefix, placeholder) => {
      const view = viewRef.current;
      if (!view || disabledRef.current) return;
      toggleMarkdownLinePrefix(view, prefix, placeholder);
      view.focus();
    },
    undo: () => {
      const view = viewRef.current;
      if (!view || disabledRef.current) return;
      undoCommand(view);
      view.focus();
    },
    goToLine: (line) => {
      const view = viewRef.current;
      if (!view) return;
      const bounded = Math.max(1, Math.min(line, view.state.doc.lines));
      const from = view.state.doc.line(bounded).from;
      view.dispatch({ selection: EditorSelection.cursor(from), scrollIntoView: true });
      view.focus();
    },
  }), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const lineSeparator = value.includes('\r\n') ? '\r\n' : value.includes('\r') ? '\r' : '\n';
    const prose = isProseEditorLanguage(language);
    const languageExtension: Extension = languageExtensionFor(language);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(), dropCursor(),
          indentOnInput(), bracketMatching(), closeBrackets(), autocompletion({ override: [localCompletions(language)], activateOnTyping: true }),
          rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { if (!disabledRef.current) saveRef.current?.(); return true; } },
            { key: 'Mod-Enter', preventDefault: true, run: () => { if (!disabledRef.current) compileRef.current?.(); return Boolean(compileRef.current); } },
            ...(language === 'markdown' ? [
              { key: 'Mod-b', preventDefault: true, run: (currentView: EditorView) => wrapEditorSelection(currentView, '**', '**', 'negrita') },
              { key: 'Mod-i', preventDefault: true, run: (currentView: EditorView) => wrapEditorSelection(currentView, '_', '_', 'cursiva') },
              { key: 'Mod-k', preventDefault: true, run: (currentView: EditorView) => wrapEditorSelection(currentView, '[', '](https://)', 'enlace') },
              { key: 'Enter', run: continueMarkdownList },
            ] : []),
            ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab,
          ]),
          languageExtension, syntaxHighlighting(espritHighlightStyle, { fallback: true }), baseTheme,
          // El tema de código va después del base para poder sobreescribirlo.
          ...(prose ? [] : [codeTheme, indentUnit.of('    ')]),
          EditorState.lineSeparator.of(lineSeparator),
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel, spellcheck: language === 'markdown' ? 'true' : 'false', autocorrect: language === 'markdown' ? 'on' : 'off', autocapitalize: language === 'markdown' ? 'sentences' : 'off' }),
          ...(prose ? [EditorView.lineWrapping] : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const content = update.state.sliceDoc();
              publishedValueRef.current = content;
              onChangeRef.current(content);
            }
          }),
          markdownLinkEvents(() => openLinkRef.current),
          EditorView.domEventHandlers({
            drop: (event, currentView) => {
              if (!dropRef.current || !prose || disabledRef.current) return false;
              const position = currentView.posAtCoords({ x: event.clientX, y: event.clientY }) ?? currentView.state.selection.main.from;
              const projectEntryId = event.dataTransfer?.getData('application/x-esprit-project-image');
              if (projectEntryId) {
                event.preventDefault();
                dropRef.current({ projectEntryId, name: event.dataTransfer?.getData('text/plain') || 'imagen', position });
                return true;
              }
              const image = [...(event.dataTransfer?.files ?? [])].find((file) => file.type.startsWith('image/') || /\.(?:png|jpe?g|gif|webp)$/i.test(file.name));
              if (image) {
                event.preventDefault();
                dropRef.current({ file: image, name: image.name, position });
                return true;
              }
              return false;
            },
            paste: (event, currentView) => {
              if (!dropRef.current || !prose || disabledRef.current) return false;
              const image = [...(event.clipboardData?.files ?? [])].find((file) => file.type.startsWith('image/') || /\.(?:png|jpe?g|gif|webp)$/i.test(file.name));
              if (!image) return false;
              event.preventDefault();
              dropRef.current({ file: image, name: image.name || 'imagen-portapapeles.png', position: currentView.state.selection.main.from });
              return true;
            },
          }),
          editableCompartment.current.of([EditorView.editable.of(!disabled), EditorState.readOnly.of(disabled)]),
          previewCompartment.current.of(language === 'markdown' && mode === 'live' ? livePreview(assetsRef) : []),
        ],
      }),
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // One editor instance per opened document; controlled changes are synchronized below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, ariaLabel]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === publishedValueRef.current) return;
    publishedValueRef.current = value;
    if (value === view.state.sliceDoc()) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: [Transaction.addToHistory.of(false), isolateHistory.of('full')],
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: previewCompartment.current.reconfigure(language === 'markdown' && mode === 'live' ? livePreview(assetsRef) : []) });
  }, [language, mode]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: editableCompartment.current.reconfigure([EditorView.editable.of(!disabled), EditorState.readOnly.of(disabled)]) });
  }, [disabled]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || language !== 'markdown' || mode !== 'live') return;
    view.dispatch({ effects: previewRefresh.of() });
  }, [assets, language, mode]);

  return <div className={`scientific-editor language-${language} mode-${mode}`} ref={hostRef} />;
});

export default ScientificEditor;
