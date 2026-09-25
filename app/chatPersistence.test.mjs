import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatHistoryWriter, mergeConcurrentHistory, mergeRunText } from './chatPersistence.ts';
import { normalizeHistory, reconcileHistory } from './chatHistory.ts';
const conversation = (id='conv-1') => ({ id, context:'general',engine:'codex',model:'gpt-6-astra',effort:'high',created_at:1,updated_at:2,status:'ready',legacy_key:null,title:'Original',draft:'',messages:[] });
const history = (item=conversation()) => ({version:2,selected_id:item.id,conversations:[item]});
const deferred = () => { let resolve; const promise = new Promise((done) => {resolve=done;}); return {promise,resolve}; };

test('autosave queues the newest rename/draft while an earlier revision is saving', async () => {
  const gate=deferred();const writes=[];
  const writer=new ChatHistoryWriter({save:async(value,revision)=>{writes.push({value,revision}); if(writes.length===1)await gate.promise;return {revision:revision+1};},load:async()=>{throw Error('unexpected reload');},conflict:()=>{}},history(),0);
  writer.queue(history()); const pending=writer.flush(); await Promise.resolve();
  writer.queue(history({...conversation(),title:'Renamed',draft:'Último borrador'}));
  gate.resolve(); await pending;
  assert.equal(writes.length,2);assert.deepEqual(writes.map(w=>w.revision),[0,1]);
  assert.equal(writes[1].value.conversations[0].draft,'Último borrador');
  assert.equal(writes[1].value.conversations[0].title,'Renamed');
});

test('CAS conflicts preserve local rename and remote messages before retrying', async () => {
  const base=history();const remote=history({...conversation(),messages:[{id:'message-remote',created_at:3,text:'Remote answer'}]});
  let current;let calls=0;
  const writer=new ChatHistoryWriter({save:async(value,revision)=>{if(calls++===0)throw {code:'HISTORY_CONFLICT'};assert.equal(revision,5);current=value;return{revision:6};},load:async()=>({history:remote,revision:5}),conflict:()=>{}},base,0);
  writer.queue(history({...conversation(),title:'Local title',draft:'Draft'}));await writer.flush();
  assert.equal(current.conversations[0].title,'Local title');assert.equal(current.conversations[0].draft,'Draft');assert.equal(current.conversations[0].messages[0].id,'message-remote');
});

test('a failed write keeps the latest draft for a subsequent flush',async()=>{
  let fails=true;let saved;
  const writer=new ChatHistoryWriter({save:async(value)=>{if(fails)throw {code:'HISTORY_UNAVAILABLE'};saved=value;return{revision:1};},load:async()=>{throw Error('no load');},conflict:()=>{}},history(),0);
  writer.queue(history({...conversation(),draft:'Keep me'}));await assert.rejects(writer.flush());fails=false;await writer.flush();assert.equal(saved.conversations[0].draft,'Keep me');
});

test('reconciliation keeps UI title/model/draft and never discards the 61st transcript',()=>{
  const local=history({...conversation(),title:'Renamed',draft:'Unsaved',model:'gpt-6-sol',effort:'ultra'});
  const restored=reconcileHistory(local,[conversation()],null);assert.equal(restored.conversations[0].title,'Renamed');assert.equal(restored.conversations[0].draft,'Unsaved');assert.equal(restored.conversations[0].model,'gpt-6-sol');
  const many={version:2,selected_id:null,conversations:Array.from({length:121},(_,i)=>({...conversation(`conv-${i}`),archived:i>59}))};
  assert.equal(normalizeHistory(many).conversations.length,121);assert.equal(reconcileHistory(many,[],null).conversations.length,121);
});

test('restore marks unfinished activity cancelled and preserves profile attribution',()=>{
  const item=conversation();item.messages=[{...item,id:'message',role:'assistant',text:'Answer',activities:[{id:'activity',label:'Read',state:'running'}]}];
  assert.equal(normalizeHistory(history(item)).conversations[0].messages[0].activities[0].state,'cancelled');
});

test('loading native history cannot replace a draft edited during loading',()=>{
  const base=history();const remote=history({...conversation(),draft:'Older on disk',title:'Saved title'});const local=history({...conversation(),draft:'Typing now'});
  const merged=mergeConcurrentHistory(base,remote,local);assert.equal(merged.conversations[0].draft,'Typing now');assert.equal(merged.conversations[0].title,'Saved title');
});

test('flush also drains an edit queued as an empty flush is resolving',async()=>{
  let saved;
  const writer=new ChatHistoryWriter({save:async(value)=>{saved=value;return{revision:1};},load:async()=>{throw Error('no load');},conflict:()=>{}},history(),0);
  const idle=writer.flush();writer.queue(history({...conversation(),draft:'Last edit before close'}));await writer.flush();await idle;
  assert.equal(saved.conversations[0].draft,'Last edit before close');
});


test('legacy transcripts with an evicted CLI session stay readable and isolated by exact profile',()=>{
  const messages=[
    {...conversation(),id:'old-1',role:'user',text:'First profile'},
    {...conversation(),id:'old-2',role:'assistant',text:'Second profile',effort:'medium'},
    {...conversation(),id:'old-3',role:'assistant',text:'Another project',context:'articulo-1'},
  ];
  const restored=reconcileHistory({version:2,selected_id:null,conversations:[]},[],messages);
  assert.equal(restored.conversations.length,3);assert.equal(restored.conversations.flatMap(c=>c.messages).length,3);
  assert.ok(restored.conversations.every(c=>c.status==='expired'));
  assert.equal(reconcileHistory(restored,[],messages).conversations.length,3);
});

test('stream snapshots replace one item and preserve independent messages without duplicating Claude final',()=>{
  let current=mergeRunText({},'comment','Context consulted');
  current=mergeRunText(current.items,'answer','Partial');
  current=mergeRunText(current.items,'answer','Final answer');
  current=mergeRunText(current.items,'final','Final answer');
  assert.equal(current.text,'Context consulted\n\nFinal answer');
});


test('new drafts persist without a native conversation and stay separate by engine/context',async()=>{
  const draftHistory={version:2,selected_id:null,conversations:[],drafts:{'codex::general':'Unsent Codex','claude::general':'Unsent Claude','codex::articulo-1':'Project text'}};
  const normalized=normalizeHistory(draftHistory);
  assert.deepEqual(normalized.drafts,draftHistory.drafts);
  assert.deepEqual(reconcileHistory(normalized,[],null).drafts,draftHistory.drafts);
  let saved;
  const writer=new ChatHistoryWriter({save:async(value)=>{saved=value;return{revision:1};},load:async()=>{throw Error('unexpected');},conflict:()=>{}},{version:2,selected_id:null,conversations:[]},0);
  writer.queue(normalized);await writer.flush();
  assert.equal(saved.conversations.length,0);assert.equal(saved.drafts['codex::general'],'Unsent Codex');
});

test('native loading/CAS merges new drafts without overwriting typing or other profiles',()=>{
  const base={version:2,selected_id:null,conversations:[],drafts:{'codex::general':'Before'}};
  const remote={...base,drafts:{'codex::general':'On disk','claude::general':'Remote Claude'}};
  const local={...base,drafts:{'codex::general':'Typed while loading'}};
  const merged=mergeConcurrentHistory(base,remote,local);
  assert.deepEqual(merged.drafts,{'codex::general':'Typed while loading','claude::general':'Remote Claude'});
  const clear={...merged,drafts:{...merged.drafts,'codex::general':''}};
  assert.equal(mergeConcurrentHistory(merged,merged,clear).drafts['codex::general'],'');
});

test('retired Codex models keep their history and continue on the successor', () => {
  const message=(id,model)=>({id,role:'assistant',text:'Respuesta',context:'general',engine:'codex',model,effort:'medium',created_at:3});
  const stored=history({...conversation(),model:'gpt-5.6-terra',effort:'medium',messages:[message('m-1','gpt-5.6-luna'),message('m-2','gpt-6-astra')]});
  const normalized=normalizeHistory(stored);
  assert.equal(normalized.conversations.length,1);
  assert.equal(normalized.conversations[0].model,'gpt-6-sol');
  assert.deepEqual(normalized.conversations[0].messages.map((item)=>item.model),['gpt-5.6-luna','gpt-6-astra']);
  assert.equal(normalizeHistory(history({...conversation(),model:'gpt-6-terra'})).conversations.length,0);
});
