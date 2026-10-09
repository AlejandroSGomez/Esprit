/* eslint-disable @typescript-eslint/no-require-imports */
const fs=require('node:fs'),assert=require('node:assert/strict'),ts=require('typescript');
for(const ext of ['.ts','.tsx'])require.extensions[ext]=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,f);
require.extensions['.css']=()=>{};
const {JSDOM}=require('jsdom'),dom=new JSDOM('<div id="root"></div>',{url:'https://esprit.test',pretendToBeVisual:true});
for(const n of ['window','document','navigator','HTMLElement','Element','Node','localStorage','MutationObserver','requestAnimationFrame','cancelAnimationFrame'])Object.defineProperty(global,n,{value:['requestAnimationFrame','cancelAnimationFrame'].includes(n)?dom.window[n].bind(dom.window):dom.window[n],configurable:true});
global.IS_REACT_ACT_ENVIRONMENT=true;const React=require('react'),{act}=React,{createRoot}=require('react-dom/client');
const {newSession,addPaper,paperUrl}=require('../app/journalClub.ts');
const session={...newSession(),id:'session-1',presenter:'Persona invitada',start:'2026-11-20T12:00:00+01:00',end:'2026-11-20T13:00:00+01:00',status:'confirmed',source:'Old long provenance is preserved but collapsed',papers:['p1','p2'],ai:'Historical generated text',discussion:'Older session notes'};
session.preparation.question='Una pregunta conservada';
let stored={version:1,revision:0,sessions:[session],papers:[{id:'p1',title:'First paper',url:'https://doi.org/10.1103/test',library_uid:null,read:false,reason:''},{id:'p2',title:'Second paper',url:'',library_uid:null,read:false,reason:''}]},calls=[];
const core=require.resolve('@tauri-apps/api/core');require.cache[core]={id:core,filename:core,loaded:true,exports:{invoke:async(cmd,args)=>{calls.push(cmd);if(cmd==='journal_load')return structuredClone(stored);if(cmd==='journal_save'){assert.equal(args.expectedRevision,stored.revision);stored={...args.register,revision:stored.revision+1};return structuredClone(stored);}if(cmd==='journal_export')return '/synthetic/export.md';throw Error('Unexpected '+cmd)}}};
for(const name of ['PdfViewer','SplitDivider']){const id=require.resolve('../app/components/'+name+'.tsx');require.cache[id]={id,filename:id,loaded:true,exports:{__esModule:true,default:()=>null}};}
const {default:Space}=require('../app/components/JournalClubSpace.tsx');
const tick=()=>new Promise(r=>setTimeout(r,30));const props={active:true,userName:"Persona local",libraryEnabled:false,notesEnabled:false,projects:[],recordings:[],onRecordings(){},onConclusions(){},onOpenLink(){},onStatus(){}};
const button=t=>[...document.querySelectorAll('button')].find(b=>b.textContent===t);
const field=label=>document.querySelector(`textarea[aria-label="${label}"]`);
const type=async(label,value)=>act(async()=>{const el=field(label);Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value').set.call(el,value);el.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await tick();});
(async()=>{
 assert.equal(paperUrl('10.1103/test'),'https://doi.org/10.1103/test');assert.equal(paperUrl('javascript:alert(1)'),'');assert.equal(paperUrl('2609.12345'),'https://arxiv.org/abs/2609.12345');
 let r=addPaper(stored,{id:'duplicate',title:'same',url:'https://doi.org/10.1103/test',library_uid:'stable1',read:false,reason:''},'session-1');assert.equal(r.papers.length,2);assert.equal(r.sessions[0].papers.length,2);assert.equal(r.papers[0].library_uid,'stable1');
 let root=createRoot(document.getElementById('root'));await act(async()=>{root.render(React.createElement(Space,props));await tick()});
 assert.match(document.body.textContent,/Persona invitada/);assert.equal(calls.filter(c=>c==='journal_save').length,0,'opening performs no write');assert.equal(calls.includes('chat_catalog'),false,'no model catalogue is loaded for Journal Club');
 assert.doesNotMatch(document.body.textContent,/Ayuda de IA|Preparar ficha|Confirmada ·|Old long provenance/);assert.equal(document.querySelector('.journal-pdf'),null,'no empty PDF column without an assigned PDF');assert.equal(field('Notas del paper').value,'','legacy paper records default to empty notes');
 await type('Notas del paper','Notes for paper one');await type('Preguntas del paper','Question for paper one');
 await act(async()=>{button('Second paper').click();await tick()});assert.equal(field('Notas del paper').value,'','notes belong to the selected paper');await type('Notas del paper','Notes for paper two');
 await act(async()=>{button('First paper').click();await tick()});assert.equal(field('Notas del paper').value,'Notes for paper one');assert.equal(field('Preguntas del paper').value,'Question for paper one');
 assert.equal(JSON.parse(localStorage.getItem('esprit-journal-draft-v1')).papers[1].notes,'Notes for paper two','all paper drafts persist');
 await act(async()=>root.unmount());root=createRoot(document.getElementById('root'));await act(async()=>{root.render(React.createElement(Space,props));await tick()});
 assert.equal(field('Notas del paper').value,'Notes for paper one','draft survives restart');assert.equal(field('Preguntas del paper').value,'Question for paper one');
 await act(async()=>{button('Guardar cambios').click();await tick()});assert.equal(stored.sessions[0].preparation.question,'Una pregunta conservada');assert.equal(stored.sessions[0].ai,'Historical generated text');assert.equal(stored.sessions[0].discussion,'Older session notes');assert.equal(stored.papers[1].notes,'Notes for paper two');assert.equal(localStorage.getItem('esprit-journal-draft-v1'),null);
 await act(async()=>{button('Exportar notas…').click();await tick()});assert.equal(calls.includes('journal_export'),false,'export waits for review');await act(async()=>{button('Confirmar').click();await tick()});assert.equal(calls.includes('journal_export'),true);
 assert.equal(calls.includes('journal_assist'),false,'no AI invocation');await act(async()=>root.unmount());dom.window.close();console.log('PASS: Journal Club per-paper notes/questions, legacy preservation, draft recovery, reviewed export and no AI calls.');
})().catch(e=>{console.error(e);process.exit(1)});
