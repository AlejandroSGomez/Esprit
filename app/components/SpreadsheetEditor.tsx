'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cellInput, cellRef, columnName, MAX_COLS, parseCsv, readWorkbook, writeCsv, writeWorkbook, type Workbook } from '../xlsx';

const ROW_HEIGHT = 26;
const decode = (base64: string) => Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
const encode = (bytes: Uint8Array) => { let binary = ''; for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000)); return btoa(binary); };

type Props = { name: string; onOpenExternal: () => void; readOnly?: boolean } & (
  | { mode: 'xlsx'; dataBase64: string; onSave: (dataBase64: string) => Promise<void>; onDirtyChange: (dirty: boolean) => void }
  | { mode: 'csv'; text: string; onChange: (text: string) => void }
);

/**
 * Spreadsheet view for the explorer. .xlsx edits stay in memory until a
 * reviewed save rewrites only those cells; CSV edits flow into the normal
 * text draft (same save review as any document).
 */
export default function SpreadsheetEditor(props: Props) {
  const xlsx = props.mode === 'xlsx';
  const source = xlsx ? props.dataBase64 : props.text;
  const book = useMemo<Workbook | null>(() => { if (!xlsx) return null; try { return readWorkbook(decode(source)); } catch { return null; } }, [xlsx, source]);
  const csv = useMemo(() => xlsx ? null : parseCsv(source), [xlsx, source]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [edits, setEdits] = useState<Map<number, Map<string, string>>>(() => new Map());
  const [selected, setSelected] = useState({ row: 0, col: 0 });
  const [editing, setEditing] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLInputElement>(null);
  const sheet = book?.sheets[sheetIndex];
  const readOnly = props.readOnly || Boolean(sheet?.editProblem);
  const sheetEdits = edits.get(sheetIndex) ?? new Map<string, string>();
  const editCount = [...edits.values()].reduce((total, map) => total + map.size, 0);
  const onDirty = xlsx ? props.onDirtyChange : null;
  useEffect(() => { onDirty?.(editCount > 0); }, [editCount, onDirty]);
  useEffect(() => {
    const node = grid.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setViewport(node.clientHeight));
    observer.observe(node); setViewport(node.clientHeight);
    return () => observer.disconnect();
  }, []);

  const rows = xlsx ? Math.max((sheet?.rows ?? 0) + 20, 40) : Math.max((csv?.rows.length ?? 0) + 20, 40);
  const cols = Math.min(MAX_COLS, xlsx ? Math.max((sheet?.cols ?? 0) + 3, 8) : Math.max(...(csv?.rows.map((row) => row.length) ?? [0]), 0) + 3);
  const inputAt = (row: number, col: number) => {
    if (!xlsx) return csv?.rows[row]?.[col] ?? '';
    const ref = cellRef(row, col);
    return sheetEdits.has(ref) ? sheetEdits.get(ref)! : cellInput(sheet?.cells.get(ref));
  };
  const displayAt = (row: number, col: number) => {
    if (!xlsx) return csv?.rows[row]?.[col] ?? '';
    const ref = cellRef(row, col);
    if (sheetEdits.has(ref)) return sheetEdits.get(ref)!;
    return sheet?.cells.get(ref)?.value ?? '';
  };
  const commit = (value: string, row = selected.row, col = selected.col) => {
    if (readOnly) return;
    if (!xlsx) {
      const next = (csv?.rows ?? []).map((line) => [...line]);
      while (next.length <= row) next.push([]);
      while (next[row].length <= col) next[row].push('');
      next[row][col] = value;
      props.onChange(writeCsv(next.map((line, index) => index === row ? line : line), csv?.delimiter ?? ','));
      return;
    }
    const original = cellInput(sheet?.cells.get(cellRef(row, col)));
    setEdits((current) => {
      const next = new Map(current);
      const map = new Map(next.get(sheetIndex) ?? []);
      if (value === original) map.delete(cellRef(row, col)); else map.set(cellRef(row, col), value);
      next.set(sheetIndex, map);
      return next;
    });
  };
  const move = (row: number, col: number) => {
    const next = { row: Math.max(0, Math.min(rows - 1, row)), col: Math.max(0, Math.min(cols - 1, col)) };
    setSelected(next);
    const node = grid.current;
    if (node) {
      const top = next.row * ROW_HEIGHT;
      if (top < node.scrollTop) node.scrollTop = top;
      else if (top + ROW_HEIGHT * 2 > node.scrollTop + node.clientHeight) node.scrollTop = top - node.clientHeight + ROW_HEIGHT * 2;
    }
  };
  const gridKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editing !== null) return;
    const { row, col } = selected;
    if (event.key === 'ArrowDown') { event.preventDefault(); move(row + 1, col); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(row - 1, col); }
    else if (event.key === 'ArrowRight' || (event.key === 'Tab' && !event.shiftKey)) { event.preventDefault(); move(row, col + 1); }
    else if (event.key === 'ArrowLeft' || (event.key === 'Tab' && event.shiftKey)) { event.preventDefault(); move(row, col - 1); }
    else if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); if (!readOnly) { setEditing(inputAt(row, col)); requestAnimationFrame(() => bar.current?.focus()); } }
    else if ((event.key === 'Backspace' || event.key === 'Delete') && !readOnly) { event.preventDefault(); commit(''); }
    else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !readOnly) { event.preventDefault(); setEditing(event.key); requestAnimationFrame(() => bar.current?.focus()); }
  };
  const barKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      if (editing !== null) commit(editing);
      setEditing(null);
      move(selected.row + (event.key === 'Enter' ? (event.shiftKey ? -1 : 1) : 0), selected.col + (event.key === 'Tab' ? (event.shiftKey ? -1 : 1) : 0));
      grid.current?.focus();
    } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(null); grid.current?.focus(); }
  };
  const save = async () => {
    if (!xlsx || !book || busy) return;
    setBusy(true); setError(null);
    try { await props.onSave(encode(writeWorkbook(book, edits))); setEdits(new Map()); setReview(false); }
    catch (reason) { setError(String(reason).replace(/^Error:\s*/, '')); }
    finally { setBusy(false); }
  };

  if (xlsx && !book) return <div className="sheet-state"><p>No se pudo leer este libro. Ábrelo en Excel.</p><button type="button" onClick={props.onOpenExternal}>Abrir en Excel ↗</button></div>;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 5);
  const last = Math.min(rows, first + Math.ceil(viewport / ROW_HEIGHT) + 12);
  const ref = cellRef(selected.row, selected.col);
  const formulaCell = xlsx && !sheetEdits.has(ref) && sheet?.cells.get(ref)?.formula !== null && sheet?.cells.get(ref) !== undefined;
  return <div className="sheet-editor">
    {sheet?.editProblem ? <p className="sheet-note" role="status">{sheet.editProblem}</p> : null}
    <div className="sheet-toolbar">
      <span className="sheet-ref">{ref}</span>
      <input ref={bar} className="sheet-bar" value={editing ?? inputAt(selected.row, selected.col)} readOnly={readOnly} aria-label={`Contenido de ${ref}`} placeholder={readOnly ? '' : 'Escribe un valor o =FÓRMULA'}
        onChange={(event) => setEditing(event.target.value)} onFocus={() => { if (editing === null && !readOnly) setEditing(inputAt(selected.row, selected.col)); }} onBlur={() => { if (editing !== null) { commit(editing); setEditing(null); } }} onKeyDown={barKey} />
      {formulaCell ? <small className="sheet-hint">fórmula</small> : null}
      {xlsx && editCount ? <span className="sheet-dirty">{editCount} {editCount === 1 ? 'celda cambiada' : 'celdas cambiadas'}</span> : null}
      {xlsx && editCount ? <button type="button" onClick={() => setEdits(new Map())} disabled={busy}>Descartar</button> : null}
      {xlsx && !readOnly ? <button type="button" className="primary" disabled={!editCount || busy} onClick={() => setReview(true)}>Guardar…</button> : null}
      <button type="button" onClick={props.onOpenExternal} title="Abrir en Excel, Numbers o la app predeterminada">Abrir en Excel ↗</button>
    </div>
    <div className="sheet-grid" ref={grid} tabIndex={0} onKeyDown={gridKey} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} role="grid" aria-label={props.name} aria-rowcount={rows} aria-colcount={cols}>
      <div className="sheet-canvas" style={{ height: (rows + 1) * ROW_HEIGHT, gridTemplateRows: `${ROW_HEIGHT}px ${first * ROW_HEIGHT}px repeat(${last - first}, ${ROW_HEIGHT}px)`, gridTemplateColumns: `44px repeat(${cols}, minmax(96px, max-content))` }}>
        <div className="sheet-head sheet-corner" />
        {Array.from({ length: cols }, (_, col) => <div key={`h${col}`} className={`sheet-head${col === selected.col ? ' active' : ''}`}>{columnName(col)}</div>)}
        <div className="sheet-spacer" style={{ gridColumn: `1 / span ${cols + 1}`, height: first * ROW_HEIGHT }} />
        {Array.from({ length: last - first }, (_, offset) => {
          const row = first + offset;
          return [<div key={`r${row}`} className={`sheet-row-head${row === selected.row ? ' active' : ''}`}>{row + 1}</div>,
            ...Array.from({ length: cols }, (_, col) => {
              const edited = xlsx && sheetEdits.has(cellRef(row, col));
              const value = displayAt(row, col);
              const number = value !== '' && !Number.isNaN(Number(value));
              return <div key={`${row}:${col}`} role="gridcell" className={`sheet-cell${row === selected.row && col === selected.col ? ' selected' : ''}${edited ? ' edited' : ''}${number ? ' number' : ''}${!xlsx && row === 0 ? ' header' : ''}`} onMouseDown={() => { if (editing !== null) { commit(editing); setEditing(null); } move(row, col); }} onDoubleClick={() => { if (!readOnly) { setEditing(inputAt(row, col)); requestAnimationFrame(() => bar.current?.focus()); } }} title={value}>{value}</div>;
            })];
        })}
      </div>
    </div>
    {xlsx && book && book.sheets.length > 1 ? <nav className="sheet-tabs" aria-label="Hojas">{book.sheets.map((item, index) => <button type="button" key={item.name} aria-pressed={index === sheetIndex} onClick={() => { setSheetIndex(index); setSelected({ row: 0, col: 0 }); }}>{item.name}{edits.get(index)?.size ? ' ●' : ''}</button>)}</nav> : null}
    {sheet?.truncated ? <p className="sheet-note">Se muestran las primeras 2000 filas y 120 columnas; el resto se conserva intacto al guardar.</p> : null}
    {review ? <div className="project-modal-layer"><div className="project-save-review" role="dialog" aria-modal="true" aria-label="Guardar hoja de cálculo" onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); setReview(false); } }}>
      <span>REVISIÓN FINAL</span><h3>¿Guardar {editCount} {editCount === 1 ? 'celda' : 'celdas'} en {props.name}?</h3>
      <p>Esprit aplica los cambios y conserva las fórmulas dependientes; formatos, anchos, otras hojas y gráficos se conservan. Excel recalculará las fórmulas al abrir el libro. Si el archivo cambió en disco (por ejemplo, abierto en Excel), no se sobrescribe.</p>
      <ul className="sheet-review-list">{[...edits].flatMap(([index, map]) => [...map].slice(0, 12).map(([cell, value]) => <li key={`${index}${cell}`}><b>{book?.sheets[index]?.name} · {cell}</b> {value === '' ? <em>vacía</em> : value}</li>))}</ul>
      {error ? <div className="project-create-error" role="alert">{error}</div> : null}
      <div><button type="button" onClick={() => setReview(false)} disabled={busy} autoFocus>Cancelar</button><button type="button" className="primary" onClick={() => void save()} disabled={busy}>{busy ? 'Guardando…' : 'Confirmar y guardar'}</button></div>
    </div></div> : null}
  </div>;
}
