/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs'), assert = require('node:assert/strict'), ts = require('typescript');
for (const ext of ['.ts','.tsx']) require.extensions[ext] = (m,f) => m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,f);
require.extensions['.css'] = () => {};
const {JSDOM} = require('jsdom');
const dom = new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'https://esprit.test'});
for(const name of ['window','document','navigator','HTMLElement','HTMLTextAreaElement','HTMLInputElement','Element','Node','MutationObserver','localStorage','getComputedStyle','requestAnimationFrame','cancelAnimationFrame']) Object.defineProperty(global,name,{value:typeof dom.window[name]==='function' && ['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(name)?dom.window[name].bind(dom.window):dom.window[name],configurable:true});
global.IS_REACT_ACT_ENVIRONMENT=true;
global.ResizeObserver=class {observe(){} disconnect(){}};
window.__TAURI_INTERNALS__={};
window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
HTMLElement.prototype.scrollTo=function(){};
HTMLElement.prototype.scrollIntoView=function(){};
const React=require('react'),{act}=React,{createRoot}=require('react-dom/client');
function mock(file,exports){const id=require.resolve(file);require.cache[id]={id,filename:id,loaded:true,exports};}
const Editor=React.forwardRef(function Editor(props,ref){React.useImperativeHandle(ref,()=>({undo(){props.onChange('one original');}}));return React.createElement('textarea',{'aria-label':props.ariaLabel,value:props.value,onChange:e=>props.onChange(e.target.value)});});
mock('../app/components/ScientificEditor.tsx',{__esModule:true,default:Editor,editorLanguageForFileName:()=> 'text'});
mock('../app/components/MarkdownEditor.tsx',{__esModule:true,default:Editor});
mock('../app/components/LatexEditor.tsx',{__esModule:true,default:Editor});
mock('../app/components/PdfViewer.tsx',{__esModule:true,default:()=>null});
const calls=[],content={'one.txt':'one original','two.txt':'two original','three.txt':'three original'};
let serial=0;
const directory=(session,folder='root')=>({session_id:session,directory_id:folder,parent_id:folder==='root'?null:'root',display_path:folder==='root'?'Fixture':'Fixture/docs',entries:folder==='root'?[...Object.keys(content).map(name=>({id:name,name,kind:'file',size:20,modified:1,sensitive:false})),{id:'docs',name:'docs',kind:'directory',size:0,sensitive:false}]:[],truncated:false});
mock('@tauri-apps/api/core',{invoke:async(command,payload)=>{
  calls.push({command,payload});
  if(command==='project_browser_start') return directory(`session${++serial}`);
  if(command==='project_list')return directory(payload.sessionId,payload.directoryId);
  if(command==='project_read_file')return {id:payload.entryId,name:payload.entryId,kind:'text',display_path:`Fixture/${payload.entryId}`,content:content[payload.entryId],modified:1,size:20};
  if(command==='project_save_file'){content[payload.request.entry_id]=payload.request.content;return{id:payload.request.entry_id,name:payload.request.entry_id,kind:'text',display_path:`Fixture/${payload.request.entry_id}`,content:payload.request.content,modified:2,size:20};}
  if(command==='mattermost_download_to_project')return{name:payload.request.name,relative_path:`docs/${payload.request.name}`,display_path:`Fixture/docs/${payload.request.name}`,size:8};
  return null;
}});
const {default:Space}=require('../app/components/ProjectSpace.tsx'),{default:Download}=require('../app/components/ProjectAttachmentDownload.tsx');
const root=createRoot(document.getElementById('root'));
const tick=()=>new Promise(r=>setTimeout(r,20));
async function settle(){await act(async()=>{await tick();await tick();});}
async function click(node){assert.ok(node,'control exists');assert.ok(!node.disabled,'control enabled');await act(async()=>{node.click();await tick();});await settle();}
const visibleButtons=()=>[...document.querySelectorAll('button')].filter(b=>!b.closest('[hidden]'));
const button=(text)=>visibleButtons().find(b=>b.textContent.trim()===text);
const entry=name=>visibleButtons().find(b=>b.title===name);
async function type(node,value){await act(async()=>{Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new window.Event('input',{bubbles:true}));await tick();});}
let status;const props={projects:[{slug:'fixture',name:'Fixture'}],initialProject:'fixture',showHiddenFiles:false,onOpenFolder(){},onAskCodex(){},onSelectProject(){},onNotice(){},onEditorStatusChange:s=>{status=s;},onClose(){}};
(async()=>{
 await act(async()=>root.render(React.createElement(Space,props)));await settle();
 await click(entry('one.txt'));
 const editor=document.querySelector('textarea');assert.ok(editor);
 await type(editor,'unsaved one');assert.ok(status.unsaved);
 await click(button('⌂ Explorador'));await click(entry('two.txt'));
 assert.equal(document.querySelectorAll('[role=tab]').length,3);
 assert.equal(editor.value,'unsaved one');assert.ok(status.unsaved,'Background drafts count toward native close protection');
 await click(button('one.txt ●'));assert.equal(document.querySelector('textarea'),editor,'Editor instance and undo survive switching');
 await click(button('Deshacer'));assert.equal(editor.value,'one original');assert.equal(status.unsaved,false);
 await type(editor,'reviewed one');await click(button('Guardar'));assert.equal(calls.filter(c=>c.command==='project_save_file').length,0);
 await click(button('Confirmar y guardar'));assert.equal(content['one.txt'],'reviewed one');assert.equal(status.unsaved,false);
 await click(button('⌂ Explorador'));await click(entry('one.txt'));assert.equal(document.querySelectorAll('[role=tab]').length,3,'Same file is not duplicated');
 await type(editor,'keep this draft');
 await click(document.querySelector('[aria-label="Cerrar one.txt"]'));assert.ok(document.querySelector('[role=dialog]'));
 await click(button('Seguir editando'));assert.equal(editor.value,'keep this draft');
 await click(document.querySelector('[aria-label="Cerrar one.txt"]'));await click(button('Descartar y cerrar'));assert.equal(status.unsaved,false);assert.equal(document.querySelectorAll('[role=tab]').length,2);
 await act(async()=>root.render(React.createElement(Space,{...props,openRequest:{project:'fixture',relativePath:'three.txt',nonce:1}})));await settle();
 assert.ok(button('three.txt'));assert.equal(document.querySelector('[role=tab][aria-selected=true]').textContent,'three.txt');
 await act(async()=>root.unmount());
 const otherRoot=createRoot(document.getElementById('root'));let opened;
 await act(async()=>otherRoot.render(React.createElement(Download,{file:{id:'fileone',name:'paper.pdf',size:8},projects:props.projects,onClose(){},onOpen:(...args)=>{opened=args;}})));await settle();
 assert.equal(calls.filter(c=>c.command==='mattermost_download_to_project').length,0,'Opening folder picker never downloads');
 await click(button('▸ docs'));await type(document.querySelector('input'),'saved-paper.pdf');
 assert.ok(document.body.textContent.includes('Fixture/docs/saved-paper.pdf'));
 await click(button('Confirmar y descargar'));
 const request=calls.find(c=>c.command==='mattermost_download_to_project').payload.request;
 assert.equal(request.directory_id,'docs');assert.equal(request.name,'saved-paper.pdf');assert.equal(request.confirmed,true);
 assert.ok(!('path' in request),'Only native handles and a basename go to native');
 await click(button('Abrir en Proyectos'));assert.deepEqual(opened,['fixture','docs/saved-paper.pdf']);
 await act(async()=>otherRoot.unmount());dom.window.close();
 console.log('PASS: independent tabs/drafts/undo, explorer, deduplication, reviewed saves, protected closing, downloaded-file handoff and download only after destination review.');
})().catch(e=>{console.error(e);process.exitCode=1;dom.window.close();});
