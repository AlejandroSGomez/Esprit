'use client';
import { invoke } from '@tauri-apps/api/core';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { buildSearchIndex, searchEntries, type SearchEntry } from '../globalSearch';

export type PaperTarget = { name: string; folder: string; nonce: number };
type IndexPaper = { name: string; folder: string };
export default function GlobalSearch({ entries, papersEnabled = true, onSelect, onPaper, onClose }: { entries: SearchEntry[]; papersEnabled?: boolean; onSelect: (entry: SearchEntry) => void; onPaper: (paper: Omit<PaperTarget, 'nonce'>) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [papers, setPapers] = useState<IndexPaper[]>([]);
  const [loading, setLoading] = useState(papersEnabled);
  const [warning, setWarning] = useState('');
  const [selected, setSelected] = useState(0);
  const panel = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const resultList = useRef<HTMLDivElement>(null);
  const all = useMemo(() => [...entries, ...papers.map((paper,index) => ({ key: `paper-${index}`, kind: 'Paper', title: paper.name.replace(/\.pdf$/i, ''), detail: `Biblioteca · ${paper.folder}`, target: String(index) }))], [entries, papers]);
  const index = useMemo(() => buildSearchIndex(all), [all]);
  const results = useMemo(() => deferredQuery.trim() ? searchEntries(index, deferredQuery) : entries.filter(entry => entry.kind === 'Espacio' || entry.kind === 'Proyecto').slice(0,18), [index,deferredQuery,entries]);
  const active = Math.min(selected, Math.max(0, results.length - 1));
  const choose = (entry: SearchEntry) => { if (entry.kind === 'Paper') { const paper = papers[Number(entry.target)]; if (paper) onPaper(paper); } else onSelect(entry); onClose(); };
  useEffect(() => {
    let cancelled = false;
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    if (!papersEnabled) return () => { cancelled = true; previous?.focus(); };
    void invoke<IndexPaper[]>('research_library_index').then(value => { if (!cancelled) setPapers(value); }).catch(reason => { if (!cancelled) setWarning(`Biblioteca no disponible: ${String(reason)}`); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; previous?.focus(); };
  }, [papersEnabled]);
  useEffect(() => { resultList.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active,results]);
  return <div className="global-search-layer" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={panel} className="global-search" role="dialog" aria-modal="true" aria-label="Buscar en Esprit" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setSelected(value => Math.min(value + 1, results.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setSelected(value => Math.max(0,value - 1)); }
    else if (event.key === 'Enter' && document.activeElement === input.current && results[active]) { event.preventDefault(); choose(results[active]); }
    else if (event.key === 'Tab') {
      const elements = [...(panel.current?.querySelectorAll<HTMLElement>('input, button') ?? [])];
      if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus(); }
    }
  }}>
    <header><span>⌕</span><input ref={input} role="combobox" aria-expanded="true" aria-controls="global-search-results" aria-activedescendant={results[active] ? `search-result-${active}` : undefined} value={query} placeholder="Buscar en Esprit…" aria-label="Buscar en espacios, proyectos, papers, notas y chats" onChange={event => { setQuery(event.target.value); setSelected(0); }} /><button type="button" onClick={onClose}>Esc</button></header>
    <p className="global-search-scope">Espacios · Proyectos{papersEnabled ? ' · Papers' : ''} · Reuniones · Lecturas · Chats</p>
    <div ref={resultList} id="global-search-results" className="global-search-results" role="listbox" aria-label="Resultados">{results.map((entry,i) => <button id={`search-result-${i}`} key={entry.key} type="button" role="option" aria-selected={i === active} onMouseEnter={() => setSelected(i)} onClick={() => choose(entry)}><span>{entry.kind}</span><div><strong>{entry.title}</strong><small>{entry.detail}</small></div><i>↵</i></button>)}{!results.length ? <p>No hay coincidencias en el contenido disponible.</p> : null}</div>
    <footer>{loading ? 'Cargando títulos de Biblioteca…' : `${all.length} entradas locales · ↑↓ para elegir · Intro para abrir`}{warning ? <p role="status">{warning}</p> : null}</footer>
  </section></div>;
}
