/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs'), assert = require('node:assert/strict'), ts = require('typescript');
for (const ext of ['.ts','.tsx']) require.extensions[ext] = (m,f) => m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,f);
require.extensions['.css'] = () => {};
const {JSDOM} = require('jsdom');
const dom = new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'https://esprit.test'});
for(const name of ['window','document','navigator','HTMLElement','HTMLTextAreaElement','HTMLInputElement','HTMLSelectElement','Element','Node','MutationObserver','localStorage','getComputedStyle','requestAnimationFrame','cancelAnimationFrame']) Object.defineProperty(global,name,{value:typeof dom.window[name]==='function' && ['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(name)?dom.window[name].bind(dom.window):dom.window[name],configurable:true});
global.IS_REACT_ACT_ENVIRONMENT=true;
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
const names=['zeta.py','alpha.md','beta.pdf','gamma.tex','data.csv','Makefile','plot.png','notes.txt'];
const entries=[...names.map((name,i)=>({id:name,name,kind:'file',size:(i+1)*100,modified:i,sensitive:false})),{id:'src',name:'src',kind:'directory',size:0,modified:0,sensitive:false}];
const starts=[];
mock('@tauri-apps/api/core',{invoke:async(command,payload)=>{
  if(command==='project_browser_start'){starts.push(payload.project);return{session_id:`s-${payload.project}`,directory_id:'root',parent_id:null,display_path:'Fixture',entries,truncated:false};}
  if(command==='project_read_file')return{id:payload.entryId,name:payload.entryId,kind:'text',display_path:`Fixture/${payload.entryId}`,content:'x',modified:1,size:1};
  return null;
}});
const {default:Space}=require('../app/components/ProjectSpace.tsx');
const {fileVisualType,fileTypeLabel}=require('../app/components/FileTypeIcon.tsx');
const root=createRoot(document.getElementById('root'));
const tick=()=>new Promise(r=>setTimeout(r,20));
async function settle(){await act(async()=>{await tick();await tick();});}
const visible=()=>[...document.querySelectorAll('button')].filter(b=>!b.closest('[hidden]'));
const order=()=>[...document.querySelectorAll('.project-entry-list > button')].filter(b=>!b.closest('[hidden]')).map(b=>b.title);
async function choose(select,value){await act(async()=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,value);select.dispatchEvent(new window.Event('change',{bubbles:true}));await tick();});await settle();}
const props={projects:[{slug:'one',name:'Project One',shortName:'One'},{slug:'two',name:'Project Two',shortName:'Two'}],initialProject:'one',showHiddenFiles:false,onOpenFolder(){},onAskCodex(){},onSelectProject(){},onNotice(){},onEditorStatusChange(){},onClose(){}};
(async()=>{
  assert.equal(fileVisualType('file','Makefile'),'code');assert.equal(fileTypeLabel('file','Makefile'),'MAKE');
  assert.equal(fileTypeLabel('file','run.ipynb'),'NB');assert.equal(fileVisualType('file','.gitignore'),'config');
  assert.notEqual(fileVisualType('file','a.pdf'),fileVisualType('file','a.tex'));
  await act(async()=>root.render(React.createElement(Space,props)));await settle();
  assert.equal(document.querySelector('.project-toolbar'),null,'The per-tab project toolbar is gone');
  assert.equal(document.querySelector('select[aria-label="Cambiar de proyecto"]'),null,'Projects are chosen from visible buttons, not a dropdown');
  const chips=[...document.querySelectorAll('.project-switcher > button')];
  assert.deepEqual(chips.map(b=>b.textContent),['One','Two']);assert.equal(chips[0].getAttribute('aria-pressed'),'true');
  assert.deepEqual(order(),['src','alpha.md','beta.pdf','data.csv','gamma.tex','Makefile','notes.txt','plot.png','zeta.py'],'Name sort keeps folders first');
  const sort=document.querySelector('select[aria-label="Ordenar archivos"]');
  await choose(sort,'type');
  assert.deepEqual(order(),['src','beta.pdf','gamma.tex','alpha.md','Makefile','zeta.py','data.csv','plot.png','notes.txt'],'Type sort groups families');
  assert.equal(localStorage.getItem('esprit-project-sort'),'type');
  await choose(sort,'size');assert.equal(order()[1],'notes.txt','Size sort puts the largest file first');
  await act(async()=>{visible().find(b=>b.title==='alpha.md').click();await tick();});await settle();
  const save=visible().find(b=>b.textContent==='Guardado');
  assert.ok(save&&save.closest('.project-document-bar'),'Document actions share the tab bar');
  assert.equal(document.querySelectorAll('.project-document-actions .project-editor-actions').length,1,'Only the active tab portals its actions');
  assert.equal(visible().find(b=>b.textContent==='Explorador'),undefined,'Redundant viewer Explorer button removed');
  await act(async()=>{chips[1].click();await tick();});await settle();
  assert.equal(starts.at(-1),'two');assert.equal(starts.filter(s=>s==='two').length,1);assert.equal(chips[1].getAttribute('aria-pressed'),'true');
  assert.equal(document.querySelector('.project-document-actions .project-editor-actions'),null,'Hidden project keeps its actions out of the bar');
  await act(async()=>{chips[0].click();await tick();});await settle();
  assert.ok(document.querySelector('.project-document-actions .project-editor-actions'),'Returning restores the open document actions');
  root.unmount();dom.window.close();
  console.log('PASS: visible project switcher, compact document bar, type/size/name sorting and file-type labels.');
})().catch(error=>{console.error(error);process.exitCode=1;});
