import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { parseHTML } from 'linkedom';

const [html, source] = await Promise.all([
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/app.js', import.meta.url), 'utf8')
]);
const clone = value => JSON.parse(JSON.stringify(value));
const direction = title => ({ id:title, title, reason:'适合当前学习目标', prompt:`围绕${title}选词与文章`, target:'both' });
const directions = (title, personalized=true) => ({ personalized, items:[direction(title)], note:'' });
const deferred = () => { let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve}; };

// Execute the shipped UI, events and polling. HTTP and browser timers are controlled fixtures.
async function browser({ hash='#curate', holdPost=false }={}) {
  const { window, document } = parseHTML(html);
  const calls=[], polling=[], location={hash}, postGate=deferred();
  const storage=new Map([['between.curationDraft',JSON.stringify({prompt:'Keep my Quant request',target:'articles',defaultLevel:'B1'})]]);
  const state={
    token:'fixture-token', words:[],decks:[],articles:[],jobs:[],selections:[],
    settings:{model:'unrelated-search-model',tutorProvider:'codex'},connection:{authenticated:true},
    modelCatalog:{models:[],fetchedAt:null},directions:directions('原有方向'),
    memory:{notes:'读懂量化文章',revision:'original',recording:true,personalize:true,markdown:'',summary:{stats:{reviews:0,questions:0,quizzes:0,events:0},reviewWords:[],needsReview:[]}}
  };
  const controls={postError:'',stateGate:null,savedDirections:directions('新偏好方向')};
  window.scrollTo=()=>{};
  window.HTMLElement.prototype.scrollIntoView=()=>{};
  const context=createContext({document,window,location,URL,AbortController,
    history:{replaceState(_state,_title,url){location.hash=url;}},
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value))},
    setTimeout:(callback,delay)=>{if(delay===1400)polling.push(callback);return 1;},clearTimeout:()=>{},
    requestAnimationFrame:callback=>callback(),
    fetch:async(url,options={})=>{
      const body=options.body?JSON.parse(options.body):undefined;calls.push({url,body});let value;
      if(url==='/api/bootstrap')value=state;
      else if(url==='/api/state'){
        value=clone(state);
        if(controls.stateGate){const gate=controls.stateGate;controls.stateGate=null;await gate.promise;}
      }else if(url==='/api/jobs'&&options.method==='POST'){
        if(holdPost)await postGate.promise;
        if(controls.postError)return {ok:false,json:async()=>({error:controls.postError})};
        const job={id:'recommendation-job',type:body.type,status:'running',progress:'正在推荐方向…'};
        state.jobs=[job];value=job;
      }else if(url==='/api/jobs/recommendation-job')value=state.jobs[0];
      else if(url==='/api/jobs/recommendation-job/cancel'){
        state.jobs[0]={...state.jobs[0],status:'cancelled'};value=state.jobs[0];
      }else if(url==='/api/memory'&&options.method==='POST'){
        state.memory={...state.memory,...body,revision:'updated'};
        state.directions=clone(controls.savedDirections);value=state.memory;
      }else throw new Error(`Unexpected request: ${url}`);
      return {ok:true,json:async()=>clone(value)};
    }
  });
  runInContext(source,context,{filename:'public/app.js'});await setImmediate();
  const query=selector=>{const el=document.querySelector(selector);assert.ok(el,`Missing ${selector}`);return el;};
  const event=(el,type)=>el.dispatchEvent(new window.Event(type,{bubbles:true,cancelable:true}));
  return {document,state,calls,location,storage,controls,postGate,query,
    async click(selector){event(query(selector),'click');await setImmediate();},
    async input(selector,value){const el=query(selector);if(el.type==='checkbox')el.checked=value;else el.value=value;event(el,'input');await setImmediate();},
    async submit(selector){event(query(selector),'submit');await setImmediate();},
    async poll(){assert.ok(polling.length,'Job polling is active');polling.shift()();await setImmediate();},
    titles(){return [...document.querySelectorAll('.direction-card h3')].map(el=>el.textContent);}
  };
}
const refreshButton='[data-action="refresh-directions"]';
const posts=app=>app.calls.filter(call=>call.url==='/api/jobs');
const assertDraft=app=>{
  const saved=JSON.parse(app.storage.get('between.curationDraft'));
  assert.equal(saved.prompt,'Keep my Quant request');assert.equal(saved.defaultLevel,'B1');assert.equal(saved.target,'articles');
};

test('re-recommend submits once, stays disabled through the job and only replaces cards on success',async()=>{
  const app=await browser({holdPost:true});
  assert.equal(app.query(refreshButton).textContent,'重新推荐');
  await app.click(refreshButton);await app.click(refreshButton);
  assert.equal(posts(app).length,1);assert.equal(app.query(refreshButton).disabled,true);
  assert.equal(app.query(refreshButton).textContent,'推荐中…');assert.deepEqual(app.titles(),['原有方向']);
  app.postGate.resolve();await setImmediate();
  assert.deepEqual(posts(app)[0].body,{type:'directions',params:{level:'B1'}});
  assert.equal(app.query('.job-label').textContent,'推荐方向');app.query('[data-action="cancel-job"]');
  await app.click(refreshButton);assert.equal(posts(app).length,1);
  app.state.jobs[0]={...app.state.jobs[0],status:'completed',result:{items:[direction('新推荐方向')]}};
  app.state.directions=directions('新推荐方向');await app.poll();
  assert.deepEqual(app.titles(),['新推荐方向']);assert.equal(app.query(refreshButton).disabled,false);
  assert.equal(app.location.hash,'#curate');assert.equal(app.query('#curation-prompt').value,'Keep my Quant request');
  assert.equal(app.query('#curation-level').value,'B1');assertDraft(app);
});

test('failed request and failed running recommendation both retain the current cards and draft',async t=>{
  for(const failure of ['submit','running'])await t.test(failure,async()=>{
    const app=await browser();
    if(failure==='submit')app.controls.postError='推荐暂时不可用';
    await app.click(refreshButton);
    if(failure==='running'){app.state.jobs[0]={...app.state.jobs[0],status:'failed',error:'推荐暂时不可用'};await app.poll();}
    assert.deepEqual(app.titles(),['原有方向']);assert.equal(app.query(refreshButton).disabled,false);
    assert.match(app.query('[role="alert"]').textContent,/推荐暂时不可用/);assertDraft(app);
  });
});

test('recommendations can be cancelled while keeping current directions',async()=>{
  const app=await browser();await app.click(refreshButton);await app.click('[data-action="cancel-job"]');
  assert.equal(app.state.jobs[0].status,'cancelled');assert.equal(app.query(refreshButton).disabled,false);
  assert.deepEqual(app.titles(),['原有方向']);await app.poll();assertDraft(app);
});

test('finishing a recommendation on another page never navigates back or overwrites its draft',async()=>{
  const app=await browser();await app.click(refreshButton);await app.click('[data-nav="settings"]');
  await app.input('#memory-notes','Unsaved personal note');
  app.state.jobs[0]={...app.state.jobs[0],status:'completed',result:{items:[direction('新方向')]}};
  app.state.directions=directions('新方向');await app.poll();
  assert.equal(app.location.hash,'#settings');assert.equal(app.query('#memory-notes').value,'Unsaved personal note');
  await app.click('[data-nav="curate"]');assert.deepEqual(app.titles(),['新方向']);assertDraft(app);
});

test('saving memory synchronizes recommendations immediately and disabling personalization removes old cards',async t=>{
  for(const personalize of [true,false])await t.test(String(personalize),async()=>{
    const app=await browser({hash:'#settings'});
    await app.input('#memory-notes','Updated preference');await app.input('#memory-personalize',personalize);
    app.controls.savedDirections=directions(personalize?'新偏好方向':'通用方向',personalize);
    await app.submit('#memory-form');
    const memoryIndex=app.calls.findIndex(call=>call.url==='/api/memory');
    assert.ok(memoryIndex>=0);assert.equal(app.calls[memoryIndex+1].url,'/api/state');
    assert.equal(posts(app).length,0,'Saving memory synchronizes without automatically spending a model call');
    await app.click('[data-nav="curate"]');
    assert.deepEqual(app.titles(),[personalize?'新偏好方向':'通用方向']);
    assert.equal(app.query('#directions-title').textContent,personalize?'为你推荐':'起步方向');assertDraft(app);
  });
});

test('entering curation gets current directions without model calls and a delayed response cannot revert navigation or submitted job state',async()=>{
  const app=await browser({hash:'#settings'});app.state.directions=directions('其他窗口的新方向');
  await app.click('[data-nav="curate"]');assert.deepEqual(app.titles(),['其他窗口的新方向']);assert.equal(posts(app).length,0);
  await app.click('[data-nav="settings"]');const stale=deferred();app.controls.stateGate=stale;
  await app.click('[data-nav="curate"]');await app.click(refreshButton);
  await app.click('[data-nav="reading"]');stale.resolve();await setImmediate();
  assert.equal(app.location.hash,'#reading');assert.equal(app.query('.job-label').textContent,'推荐方向');
  await app.click('[data-nav="curate"]');assert.equal(app.query(refreshButton).disabled,true);assertDraft(app);
});
