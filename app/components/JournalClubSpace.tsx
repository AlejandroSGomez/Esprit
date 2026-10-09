'use client';
import { getAppTimeZone } from '../appConfig';
import { invoke } from '@tauri-apps/api/core';
import { CSSProperties, useEffect, useRef, useState } from 'react';
import PdfViewer from './PdfViewer';
import SplitDivider from './SplitDivider';
import { useResizableSplit } from './useResizableSplit';
import { zonedWallTimeIso } from '../timeZone';
const wallTimeIso = (date: string, time: string) => zonedWallTimeIso(date,time,getAppTimeZone());
import { registerScreen } from '../screenContext';
import { JOURNAL_ICON } from './NavIcon';
import { addPaper, newSession, paperUrl, preparationFields, sessionDate, type JournalPaper, type JournalRegister, type JournalSession } from '../journalClub';
import './JournalClubSpace.css';
const DRAFT = 'esprit-journal-draft-v1';
type LibraryPaper = { id: string; name: string; uid?: string; read: boolean };
type Preview = { name: string; data_base64: string };
export default function JournalClubSpace({ active, projects, userName, libraryEnabled, notesEnabled, onConclusions, onOpenLink, onStatus }: {
  userName: string; libraryEnabled: boolean; notesEnabled: boolean; active: boolean; projects: Array<{ slug: string; label: string }>;
 onConclusions: (title: string, body: string) => void; onOpenLink: (url: string) => void;
  onStatus: (status: { unsaved: boolean; busy: boolean }) => void;
}) {
  const [register, setRegister] = useState<JournalRegister | null>(null), [saved, setSaved] = useState('');
  const [selected, setSelected] = useState(''), [paperId, setPaperId] = useState('');
  const [now, setNow] = useState(0);
  const [query, setQuery] = useState(''), [scope, setScope] = useState<'upcoming'|'history'|'candidates'>('upcoming');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [library, setLibrary] = useState<LibraryPaper[] | null>(null), [addToSession, setAddToSession] = useState(false), [libraryQuery, setLibraryQuery] = useState('');
  const [paperTitle, setPaperTitle] = useState(''), [paperLink, setPaperLink] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null), [pdfBusy, setPdfBusy] = useState(false);
  const [review, setReview] = useState<'export'|'reload'|null>(null);
  const split = useResizableSplit({ storageKey: 'esprit-journal-split', defaultValue: 58, min: 30, max: 78 });
  const linkTarget = useRef<string | null>(null);
  const dirty = !!register && JSON.stringify(register) !== saved;
  const session = register?.sessions.find(s => s.id === selected);
  const paper = register?.papers.find(p => p.id === paperId);
  const load = async (restore: boolean) => {
    setBusy(true); setError('');
    try {
      const r = await invoke<JournalRegister>('journal_load'); setSaved(JSON.stringify(r));
      let next = r;
      if (restore) { try { const draft = JSON.parse(localStorage.getItem(DRAFT) || 'null') as JournalRegister | null; if (draft?.version === 1 && Array.isArray(draft.sessions) && Array.isArray(draft.papers)) { next = draft; if (draft.revision !== r.revision) setError('El registro cambió mientras había un borrador. Se ha recuperado tu borrador; revisa antes de recargar.'); else setNotice('Borrador recuperado.'); } } catch { setError('No se pudo recuperar el borrador local.'); } }
      // Open on the next session still to come, not the oldest one on record.
      const at = Date.now(), sorted = next.sessions.filter(s => s.status !== 'cancelled').sort((a,b) => a.start.localeCompare(b.start));
      const first = sorted.find(s => s.status !== 'held' && (!s.end || Date.parse(s.end) >= at)) ?? sorted.at(-1);
      setRegister(next); setPaperId(current=>next.papers.some(p=>p.id===current)?current:first?.papers[0]??''); setSelected(current => next.sessions.some(s => s.id === current) ? current : first?.id ?? '');
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  useEffect(() => { queueMicrotask(() => void load(true)); }, []);
  useEffect(() => { onStatus({ unsaved: dirty, busy }); }, [dirty, busy, onStatus]);
  useEffect(() => { if (!register) return; try { if (dirty) localStorage.setItem(DRAFT, JSON.stringify(register)); else localStorage.removeItem(DRAFT); } catch { queueMicrotask(() => setError('El borrador no cabe en el almacenamiento local. Pulsa Guardar antes de cerrar.')); } }, [register, dirty]);
  useEffect(() => { if (!active) return; return registerScreen('journal', () => ({ space: 'Journal Club', title: paper?.title ?? session?.title ?? 'Sesiones', text: JSON.stringify({ session: scope === 'candidates' ? undefined : session ? { ...session, ai: undefined } : undefined, paper }) })); }, [active, session, paper, scope]);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (!cancelled) { setPreview(null); setPdfBusy(libraryEnabled && Boolean(paper?.library_uid)); } }); if (!libraryEnabled || !paper?.library_uid) return;
     void invoke<Preview>('journal_read_pdf', { uid: paper.library_uid }).then(p => { if (!cancelled) setPreview(p); }).catch(e => { if (!cancelled) setError(String(e)); }).finally(() => { if (!cancelled) setPdfBusy(false); }); return () => { cancelled = true; };
  }, [libraryEnabled, paper?.library_uid]);
  useEffect(() => { queueMicrotask(() => setNow(Date.now())); const timer = setInterval(() => setNow(Date.now()),60000); return () => clearInterval(timer); }, [active]);
  const patch = (change: Partial<JournalSession>) => setRegister(r => r ? { ...r, sessions: r.sessions.map(s => s.id === selected ? { ...s, ...change } : s) } : r);
  const patchPaper = (change: Partial<JournalPaper>) => setRegister(r => r ? { ...r, papers: r.papers.map(p => p.id === paperId ? { ...p, ...change } : p) } : r);
  const choose = (s: JournalSession) => { setSelected(s.id); setPaperId(s.papers[0] ?? ''); };
  const save = async () => {
    if (!register || busy) return; setBusy(true); setError('');
    try { const r = await invoke<JournalRegister>('journal_save', { register, expectedRevision: register.revision }); setRegister(current => current === register ? r : current ? { ...current, revision: r.revision } : r); setSaved(JSON.stringify(r)); setNotice('Guardado en este equipo.'); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const add = (p: JournalPaper, toSession: boolean) => { if (!register) return; const next=addPaper(register,p,toSession ? selected : undefined); const resolved=next.papers.find(item=>(p.library_uid && item.library_uid===p.library_uid)||(p.url && item.url.toLowerCase().replace(/\/$/,'')===p.url.toLowerCase().replace(/\/$/,'')))??p; setRegister(next); setPaperId(resolved.id); };
  const linkLibrary = async (p: LibraryPaper) => { try { const uid = await invoke<string>('journal_link_library', { paperId: p.id }); if (linkTarget.current) { const target=linkTarget.current; setRegister(r=>r?{...r,papers:r.papers.map(p=>p.id===target?{...p,library_uid:uid}:p)}:r); linkTarget.current=null; } else add({ id: crypto.randomUUID(), title: p.name.replace(/\.pdf$/i,''), url: '', library_uid: uid, read: p.read, reason: '' },addToSession); setLibrary(null); } catch (e) {setError(String(e));} };
  const openLibrary = async (toSession: boolean, target?: string) => { if (!libraryEnabled) { setError('Activa Biblioteca en la configuración para vincular PDFs; puedes añadir papers por DOI o enlace.'); return; } linkTarget.current=target??null; setAddToSession(toSession); try { setLibrary((await invoke<{papers:LibraryPaper[]}>('library_overview')).papers); } catch(e) {setError(String(e));} };
  const addLink = () => { const url = paperUrl(paperLink); if (!url || !paperTitle.trim()) {setError('Indica un título y un DOI, arXiv o enlace web válido.');return;} add({id:crypto.randomUUID(),title:paperTitle.trim(),url,library_uid:null,read:false,reason:''},scope!=='candidates' && !!session);setPaperTitle('');setPaperLink(''); };
  const finishReview = async () => {
    if (review === 'reload') { setReview(null); await load(false); return; }
    if (!session || !register || dirty) return;
    setBusy(true);setError('');
    try { if (review === 'export') {const path=await invoke<string>('journal_export',{id:session.id,expectedRevision:register.revision,confirmed:true});setNotice(`Exportado: ${path}`);}

      setReview(null);
    }catch(e){setError(String(e));}finally{setBusy(false);}
  };
  const dateChange = (value: string) => { try { patch(value ? { start: wallTimeIso(value,'12:00'), end: wallTimeIso(value,'13:00') } : {start:'',end:''}); } catch (e) {setError(String(e));} };
  const inScope = (s: JournalSession, which: typeof scope) => which === 'history' ? s.status === 'held' || s.status === 'cancelled' || (!!s.end && Date.parse(s.end) < now) : s.status !== 'held' && s.status !== 'cancelled' && (!s.end || Date.parse(s.end) >= now);
  const matches = (s: JournalSession) => `${s.title} ${s.presenter} ${s.projects.join(' ')} ${s.papers.map(id => register?.papers.find(p => p.id===id)?.title).join(' ')}`.toLowerCase().includes(query.toLowerCase());
  const shown = register?.sessions.filter(s => inScope(s, scope) && matches(s)).sort((a,b) => scope === 'history' ? b.start.localeCompare(a.start) : a.start.localeCompare(b.start)) ?? [];
  const candidates = register?.papers.filter(p=>`${p.title} ${p.reason}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  const counts = { upcoming: register?.sessions.filter(s => inScope(s,'upcoming')).length ?? 0, history: register?.sessions.filter(s => inScope(s,'history')).length ?? 0, candidates: register?.papers.length ?? 0 };
  const groups = shown.reduce<Array<[string, JournalSession[]]>>((all, s) => { const key = s.start ? madrid(s.start,{month:'long',year:'numeric'}) : 'Sin fecha'; const last = all.at(-1); if (last && last[0] === key) last[1].push(s); else all.push([key,[s]]); return all; }, []);
  const next = register?.sessions.filter(s=>s.status==='confirmed' && Date.parse(s.end)>now).sort((a,b)=>a.start.localeCompare(b.start))[0];
  const mine = (s: JournalSession) => !!userName.trim() && s.presenter.trim().toLocaleLowerCase() === userName.trim().toLocaleLowerCase();
  const time = (value: string) => value ? madrid(value,{hour:'2-digit',minute:'2-digit'}) : '';
  const scopeLabels = { upcoming: 'Próximas', history: 'Historial', candidates: 'Papers' } as const;
  const shownSession = scope === 'candidates' ? undefined : session;
  const legacyFields = shownSession ? preparationFields.filter(([key]) => key !== 'questions' && shownSession.preparation[key].trim()) : [];
  const hasLegacy = !!shownSession && (legacyFields.length > 0 || !!shownSession.conclusions.trim() || !!shownSession.tasks.trim() || (!!paper && (!!shownSession.discussion.trim() || !!shownSession.preparation.questions.trim())));
  const showPdf = !!paper?.library_uid;
  return <section className="journal-space">
    <header className="journal-bar">
      <div className="journal-next">{next ? <><span className="journal-kicker">Próxima</span><strong>{madrid(next.start,{day:'numeric',month:'short'})}</strong><span>{next.presenter || next.title}</span>{mine(next) ? <em className="mine">Tu turno</em> : null}</> : <strong>Journal Club</strong>}</div>
      <div className="journal-actions">
        <button className="journal-quiet" disabled={!register || busy} onClick={()=>dirty ? setReview('reload') : void load(false)}>Recargar</button>
        <button className={`primary journal-save${dirty ? ' dirty' : ''}`} disabled={!dirty || busy} onClick={()=>void save()}>{busy ? 'Guardando…' : dirty ? 'Guardar cambios' : 'Guardado'}</button>
      </div>
    </header>
    {error ? <p role="alert" className="journal-error">{error}<button onClick={()=>setError('')} aria-label="Cerrar aviso">×</button></p> : null}
    {notice ? <p role="status" className="journal-notice">{notice}<button onClick={()=>setNotice('')} aria-label="Cerrar aviso">×</button></p> : null}
    {!register ? <div className="journal-loading"><JournalGlyph/><p>Cargando Journal Club…</p></div> : <div className="journal-layout">
      <aside className="journal-rail">
        <div className="journal-scopes" role="group" aria-label="Vista">{(['upcoming','history','candidates'] as const).map(v=><button key={v} aria-pressed={scope===v} onClick={()=>{setScope(v);if(v!=='candidates')setPaperId(session?.papers[0]??'');}}>{scopeLabels[v]}<b>{counts[v]}</b></button>)}</div>
        <input className="journal-search" type="search" aria-label="Buscar sesiones o papers" placeholder="Buscar ponente o paper…" value={query} onChange={e=>setQuery(e.target.value)}/>
        <div className="journal-list">
          {scope==='candidates' ? (candidates.length ? candidates.map(p=><button className="journal-item journal-candidate" key={p.id} aria-pressed={paperId===p.id} onClick={()=>setPaperId(p.id)}><strong>{p.title}</strong><small><i className={`journal-dot${p.read?' read':''}`}/>{p.read?'Leído':'Por leer'}</small></button>) : <p className="journal-list-empty">{query?'Nada coincide con la búsqueda.':'Añade un paper desde Biblioteca o con un enlace.'}</p>)
          : groups.length ? groups.map(([month,items])=><section key={month} className="journal-month"><h4>{month}</h4>{items.map(s=><button className={`journal-item${mine(s)?' mine':''}${s.status==='cancelled'?' cancelled':''}`} key={s.id} aria-pressed={selected===s.id} onClick={()=>choose(s)}>
            <span className="journal-date"><b>{s.start?madrid(s.start,{day:'numeric'}):'—'}</b><small>{s.start?madrid(s.start,{weekday:'short'}).replace('.',''):''}</small></span>
            <span className="journal-item-body"><strong>{s.presenter||s.title}</strong><small>{s.papers.length ? register.papers.find(p=>p.id===s.papers[0])?.title : 'Paper pendiente'}</small>{mine(s)?<span className="journal-status mine">Tu turno</span>:s.status==='cancelled'?<span className="journal-status cancelled">Cancelada</span>:null}</span>
          </button>)}</section>) : <p className="journal-list-empty">{query?'Nada coincide con la búsqueda.':scope==='history'?'Todavía no hay sesiones pasadas.':'No hay sesiones próximas.'}</p>}
        </div>
        <div className="journal-rail-foot"><button onClick={()=>{if(scope==='candidates'){void openLibrary(false);return;}const s=newSession();setRegister(r=>r?{...r,sessions:[...r.sessions,s]}:r);choose(s);setScope('upcoming');setQuery('');}}>{scope==='candidates'?'＋ Paper de Biblioteca':'＋ Sesión'}</button></div>
      </aside>
      <main className="journal-main">
        {shownSession || scope==='candidates' ? <>
          <div className="journal-head">
            <div><h3>{shownSession ? shownSession.presenter || shownSession.title : paper?.title || 'Papers'}</h3>{shownSession ? <p>{sessionDate(shownSession.start)}{shownSession.end?`–${time(shownSession.end)}`:''}{shownSession.status==='cancelled'?' · Cancelada':''}</p> : <p>Tus notas y preguntas de lectura</p>}</div>
            <div className="journal-actions">{shownSession?.source_url?<button className="journal-quiet" onClick={()=>onOpenLink(shownSession.source_url)}>Sesión ↗</button>:null}</div>
          </div>
          <div className="journal-papers" aria-label="Papers de la sesión">
            {shownSession?.papers.map(id=>{const p=register.papers.find(p=>p.id===id);return p?<button key={id} className="journal-paper" aria-pressed={paperId===id} title={p.title} onClick={()=>setPaperId(id)}><i className={`journal-dot${p.read?' read':''}`}/>{p.title}</button>:null;})}
            <button className="journal-quiet" onClick={()=>void openLibrary(!!shownSession)}>＋ Biblioteca</button>
            {shownSession && register.papers.some(p=>!shownSession.papers.includes(p.id)) ? <select className="journal-quiet" aria-label="Añadir paper guardado" value="" onChange={e=>{const p=register.papers.find(p=>p.id===e.target.value);if(p)add(p,true);}}><option value="">＋ Paper guardado</option>{register.papers.filter(p=>!shownSession.papers.includes(p.id)).map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select>:null}
          </div>
          <details className="journal-add-link"><summary>Añadir enlace o DOI</summary><div className="journal-ask"><label className="journal-field"><span>Título</span><input value={paperTitle} onChange={e=>setPaperTitle(e.target.value)}/></label><label className="journal-field"><span>Referencia</span><input value={paperLink} onChange={e=>setPaperLink(e.target.value)} placeholder="DOI, arXiv o enlace web"/></label><button onClick={addLink}>Añadir referencia</button></div></details>
          <div className={`journal-reading${showPdf?'':' journal-reading-notes'}`} style={{'--journal-pdf':`${split.value}%`} as CSSProperties}>
            {showPdf ? <><div className="journal-pdf">{preview?<PdfViewer dataBase64={preview.data_base64} name={preview.name} active={active} documentKey={`journal:${paper?.library_uid}`}/>:<div className="journal-empty"><JournalGlyph/><p>{pdfBusy?'Abriendo PDF…':'El PDF no está disponible. Puedes volver a vincularlo.'}</p>{!pdfBusy?<button onClick={()=>void openLibrary(!!shownSession,paper?.id)}>Vincular PDF</button>:null}</div>}</div><SplitDivider split={split} className="journal-divider" label="Ajustar PDF y notas"/></>:null}
            <div className="journal-notes">
              {paper ? <div className="journal-paper-heading"><strong>{paper.title}</strong><div className="journal-actions"><label className="journal-check"><input type="checkbox" checked={paper.read} onChange={e=>patchPaper({read:e.target.checked})}/> Leído</label>{paper.url?<button className="journal-quiet" onClick={()=>onOpenLink(paper.url)}>Abrir paper ↗</button>:null}{!paper.library_uid?<button className="journal-quiet" onClick={()=>void openLibrary(!!shownSession,paper.id)}>Vincular PDF</button>:null}</div></div> : shownSession ? <p className="journal-hint">Paper pendiente. Puedes ir anotando ideas para la sesión.</p> : null}
              {paper || shownSession ? <>
                <label className="journal-field journal-note-field"><span>Notas</span><textarea aria-label={paper?'Notas del paper':'Notas de la sesión'} maxLength={20000} rows={10} placeholder="Ideas, resultados, figuras que quieres recordar…" value={paper ? paper.notes ?? '' : shownSession?.discussion ?? ''} onChange={e=>paper ? patchPaper({notes:e.target.value}) : patch({discussion:e.target.value})}/></label>
                <label className="journal-field"><span>Preguntas</span><textarea aria-label={paper?'Preguntas del paper':'Preguntas de la sesión'} maxLength={20000} rows={5} placeholder="Lo que te gustaría preguntar o discutir…" value={paper ? paper.questions ?? '' : shownSession?.preparation.questions ?? ''} onChange={e=>paper ? patchPaper({questions:e.target.value}) : shownSession && patch({preparation:{...shownSession.preparation,questions:e.target.value}})}/></label>
              </> : <div className="journal-empty"><JournalGlyph/><p>Selecciona un paper o añade uno para empezar tus notas.</p></div>}
              {hasLegacy && shownSession ? <details className="journal-previous"><summary>Apuntes de la sesión</summary>
                {paper && shownSession.discussion.trim()?<label className="journal-field"><span>Notas generales</span><textarea rows={5} value={shownSession.discussion} maxLength={20000} onChange={e=>patch({discussion:e.target.value})}/></label>:null}
                {paper && shownSession.preparation.questions.trim()?<label className="journal-field"><span>Preguntas generales</span><textarea rows={4} value={shownSession.preparation.questions} maxLength={20000} onChange={e=>patch({preparation:{...shownSession.preparation,questions:e.target.value}})}/></label>:null}
                {legacyFields.map(([key,label])=><label key={key} className="journal-field"><span>{label}</span><textarea rows={4} value={shownSession.preparation[key]} maxLength={20000} onChange={e=>patch({preparation:{...shownSession.preparation,[key]:e.target.value}})}/></label>)}
                {shownSession.conclusions.trim()?<label className="journal-field"><span>Conclusiones</span><textarea rows={4} value={shownSession.conclusions} maxLength={20000} onChange={e=>patch({conclusions:e.target.value})}/></label>:null}
                {shownSession.tasks.trim()?<label className="journal-field"><span>Tareas</span><textarea rows={4} value={shownSession.tasks} maxLength={20000} onChange={e=>patch({tasks:e.target.value})}/></label>:null}
              </details>:null}
            </div>
          </div>
          {shownSession ? <details className="journal-details"><summary>Editar sesión</summary><div className="journal-fields">
            <label>Título<input value={shownSession.title} maxLength={600} onChange={e=>patch({title:e.target.value})}/></label>
            <label>Ponente<input value={shownSession.presenter} maxLength={200} onChange={e=>patch({presenter:e.target.value})}/></label>
            <label>Fecha · zona configurada<input type="date" value={shownSession.start.slice(0,10)} onChange={e=>dateChange(e.target.value)}/></label>
            <label>Inicio<input type="time" value={shownSession.start.slice(11,16)} onChange={e=>{try{patch({start:wallTimeIso(shownSession.start.slice(0,10),e.target.value)})}catch(e){setError(String(e))}}}/></label>
            <label>Fin<input type="time" value={shownSession.end.slice(11,16)} onChange={e=>{try{patch({end:wallTimeIso(shownSession.end.slice(0,10),e.target.value)})}catch(e){setError(String(e))}}}/></label>
            <label>Estado<select value={shownSession.status} onChange={e=>patch({status:e.target.value as JournalSession['status']})}><option value="proposed">Propuesta</option><option value="confirmed">Confirmada</option><option value="held">Celebrada</option><option value="cancelled">Cancelada</option></select></label>
            <label>Procedencia<input value={shownSession.source} maxLength={2000} onChange={e=>patch({source:e.target.value})}/></label>
            <label>Enlace de la sesión<input value={shownSession.source_url} onChange={e=>patch({source_url:e.target.value})}/></label>
          </div><p className="journal-hint">Estas fechas pertenecen a la ficha; los eventos se gestionan desde Calendario.</p>
            {projects.length?<fieldset className="journal-projects"><legend>Proyectos relacionados</legend>{projects.map(p=><label className={`journal-chip${shownSession.projects.includes(p.slug)?' on':''}`} key={p.slug}><input type="checkbox" checked={shownSession.projects.includes(p.slug)} onChange={e=>patch({projects:e.target.checked?[...shownSession.projects,p.slug]:shownSession.projects.filter(x=>x!==p.slug)})}/>{p.label}</label>)}</fieldset>:null}
            <div className="journal-actions"><button disabled={dirty} title={dirty?'Guarda antes de exportar':undefined} onClick={()=>setReview('export')}>Exportar notas…</button>{notesEnabled && (shownSession.conclusions.trim()||shownSession.tasks.trim())?<button onClick={()=>onConclusions(shownSession.title,`Journal Club · ${sessionDate(shownSession.start)}\n\n${shownSession.conclusions}\n\n${shownSession.tasks}`)}>Llevar conclusiones al Logout</button>:null}</div>
          </details>:null}
        </> : <div className="journal-empty journal-empty-main"><JournalGlyph/><h3>Selecciona una sesión</h3><p>El calendario, tus papers y tus notas, juntos.</p></div>}
      </main>
    </div>}
    {library?<div className="journal-modal" role="dialog" aria-modal="true" aria-label="Elegir paper de Biblioteca" onMouseDown={e=>{if(e.target===e.currentTarget)setLibrary(null);}}><div><header><h3>Vincular un PDF</h3><button onClick={()=>setLibrary(null)} aria-label="Cerrar">×</button></header><input className="journal-search" type="search" placeholder="Buscar en Biblioteca…" value={libraryQuery} onChange={e=>setLibraryQuery(e.target.value)} autoFocus/><div className="journal-library-list">{library.filter(p=>p.name.toLowerCase().includes(libraryQuery.toLowerCase())).map(p=><button key={p.id} onClick={()=>void linkLibrary(p)}><i className={`journal-dot${p.read?' read':''}`}/>{p.name.replace(/\.pdf$/i,'')}</button>)}</div></div></div>:null}
    {review?<div className="journal-modal" role="dialog" aria-modal="true" aria-label="Revisar acción de Journal Club"><div><header><h3>{review==='reload'?'Recargar el registro':'Exportar notas'}</h3></header>{review==='reload'?<p>Se descartará el borrador local sin guardar.</p>:<p>Se creará una copia de las notas de la sesión y de sus papers en Esprit/JournalClubExports.</p>}<div className="journal-actions journal-modal-foot"><button onClick={()=>setReview(null)}>Volver</button><button className="primary" disabled={busy} onClick={()=>void finishReview()}>{review==='reload'?'Descartar borrador y recargar':'Confirmar'}</button></div></div></div>:null}
  </section>;
}

const madrid = (value: string, options: Intl.DateTimeFormatOptions) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('es-ES', { timeZone: getAppTimeZone(), ...options }).format(date); };
function JournalGlyph() {
  return <svg className="journal-glyph" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{JOURNAL_ICON}</svg>;
}
