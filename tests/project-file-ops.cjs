/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs'), assert = require('node:assert/strict'), ts = require('typescript');
for (const ext of ['.ts','.tsx']) require.extensions[ext] = (m,f) => m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,f);
require.extensions['.css'] = () => {};
const {JSDOM} = require('jsdom');
const dom = new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'https://esprit.test'});
for(const name of ['window','document','navigator','HTMLElement','HTMLTextAreaElement','HTMLInputElement','HTMLSelectElement','Element','Node','MutationObserver','localStorage','getComputedStyle','requestAnimationFrame','cancelAnimationFrame']) Object.defineProperty(global,name,{value:typeof dom.window[name]==='function' && ['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(name)?dom.window[name].bind(dom.window):dom.window[name],configurable:true});
global.IS_REACT_ACT_ENVIRONMENT=true;
global.FileReader=dom.window.FileReader;
global.ResizeObserver=class {observe(){} disconnect(){}};
window.__TAURI_INTERNALS__={};
window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
HTMLElement.prototype.scrollTo=function(){};
HTMLElement.prototype.scrollIntoView=function(){};
const React=require('react'),{act}=React,{createRoot}=require('react-dom/client');
function mock(file,exports){const id=require.resolve(file);require.cache[id]={id,filename:id,loaded:true,exports};}
const Editor=React.forwardRef(function Editor(props,ref){React.useImperativeHandle(ref,()=>({undo(){}}));return React.createElement('textarea',{'aria-label':props.ariaLabel,value:props.value,onChange:e=>props.onChange(e.target.value)});});
mock('../app/components/ScientificEditor.tsx',{__esModule:true,default:Editor,editorLanguageForFileName:()=> 'text'});
mock('../app/components/MarkdownEditor.tsx',{__esModule:true,default:Editor});
mock('../app/components/LatexEditor.tsx',{__esModule:true,default:Editor});
mock('../app/components/PdfViewer.tsx',{__esModule:true,default:()=>null});
let entries=[{id:'a',name:'alpha.md',kind:'file',size:100,modified:1,sensitive:false},{id:'g',name:'Guiones',kind:'directory',size:0,modified:1,sensitive:false}];
const calls=[];
mock('@tauri-apps/api/core',{invoke:async(command,payload)=>{
  calls.push([command,payload]);
  const listing={session_id:`s-${payload?.project ?? 'docencia'}`,directory_id:'root',parent_id:null,display_path:'Docencia',entries,truncated:false};
  if(command==='project_browser_start'||command==='project_list')return listing;
  if(command==='project_rename_entry'){entries=entries.map(e=>e.id===payload.request.entry_id?{...e,name:payload.request.name}:e);return entries.find(e=>e.id===payload.request.entry_id);}
  if(command==='project_trash_entry'){entries=entries.filter(e=>e.id!==payload.request.entry_id);return null;}
  if(command==='project_import_file'){const e={id:'n',name:payload.request.name,kind:'file',size:4,modified:2,sensitive:false};entries=[...entries,e];return e;}
  return null;
}});
const {default:Space}=require('../app/components/ProjectSpace.tsx');
const root=createRoot(document.getElementById('root'));
const tick=()=>new Promise(r=>setTimeout(r,20));
async function settle(){await act(async()=>{await tick();await tick();});}
const entryButton=(name)=>[...document.querySelectorAll('.project-entry-list > button')].find(b=>b.title===name);
const button=(text)=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
const notices=[];
const props={variant:'teaching',projects:[{slug:'docencia',name:'Docencia',shortName:'Docencia'}],initialProject:'docencia',showHiddenFiles:false,onOpenFolder(){},onAskCodex(){},onSelectProject(){},onNotice:(m)=>notices.push(m),onEditorStatusChange(){},onClose(){}};
(async()=>{
  await act(async()=>root.render(React.createElement(Space,props)));await settle();
  assert.equal(calls[0][1].project,'docencia','Docencia opens its fixed root');
  assert.equal(document.querySelector('.project-switcher'),null,'no project chips in Docencia');
  assert.equal(document.querySelector('.project-space-title').textContent,'Docencia');
  assert.equal(button('Codex ↗'),undefined,'no Codex shortcut for teaching');
  // Rename through the context menu.
  await act(async()=>{entryButton('alpha.md').dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,clientX:40,clientY:40}));await tick();});
  assert.ok(document.querySelector('.project-entry-menu'),'right click opens the entry menu');
  await act(async()=>{button('Renombrar…').click();await tick();});
  const input=document.querySelector('.project-modal-layer input');
  assert.equal(input.value,'alpha.md');
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Guion 1.md');input.dispatchEvent(new window.Event('input',{bubbles:true}));await tick();});
  await act(async()=>{document.querySelector('.project-modal-layer form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await tick();});await settle();
  const rename=calls.find(c=>c[0]==='project_rename_entry');
  assert.deepEqual(rename[1].request,{session_id:'s-docencia',entry_id:'a',name:'Guion 1.md',confirmed:true});
  assert.ok(entryButton('Guion 1.md'),'the list refreshes with the new name');
  // Trash asks first and says it is recoverable.
  await act(async()=>{entryButton('Guiones').dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,clientX:40,clientY:40}));await tick();});
  await act(async()=>{button('Mover a la Papelera…').click();await tick();});
  assert.match(document.querySelector('[role=alertdialog]').textContent,/Papelera del sistema con todo su contenido/);
  assert.ok(!calls.some(c=>c[0]==='project_trash_entry'),'nothing moves before confirming');
  await act(async()=>{button('Mover a la Papelera').click();await tick();});await settle();
  assert.equal(calls.find(c=>c[0]==='project_trash_entry')[1].request.entry_id,'g');
  assert.equal(entryButton('Guiones'),undefined);
  // Add files by dropping them from Finder.
  const file=new window.File(['%PDF'],'Calendario.pdf',{type:'application/pdf'});
  const list=document.querySelector('.project-entry-list');
  const drop=new window.Event('drop',{bubbles:true,cancelable:true});drop.dataTransfer={types:['Files'],files:[file]};
  await act(async()=>{list.dispatchEvent(drop);await tick();});
  assert.match(document.querySelector('.project-import-review').textContent,/Calendario\.pdf/);
  assert.match(document.querySelector('.project-import-review').textContent,/nombre \(2\)/,'the review explains that nothing is replaced');
  await act(async()=>{button('Añadir').click();await tick();await tick();await tick();});await settle();
  const imported=calls.find(c=>c[0]==='project_import_file');
  assert.equal(imported[1].request.name,'Calendario.pdf');assert.equal(imported[1].request.directory_id,'root');
  assert.equal(Buffer.from(imported[1].request.data_base64,'base64').toString(),'%PDF','the bytes travel, never a path');
  assert.ok(entryButton('Calendario.pdf'));
  root.unmount();dom.window.close();
  console.log('PASS: Docencia explorer on its own root; right-click rename, recoverable Trash after confirmation and drop-to-add without paths.');
})().catch(e=>{console.error(e);process.exit(1);});
