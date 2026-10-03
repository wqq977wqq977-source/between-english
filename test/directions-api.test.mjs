import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// These tests replace only the CLI process. They exercise real routes, model
// discovery, task scheduling, memory checks and database persistence.
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'between-directions-http-'));
  const data = join(directory, 'data'), binary = join(directory, 'fake-codex');
  const log = join(directory, 'invocations.jsonl'), control = join(directory, 'control.json'), release = join(directory, 'release');
  writeFileSync(control, JSON.stringify({ mode: 'success' }));
  writeFileSync(binary, `#!${process.execPath}
import {appendFileSync,readFileSync,existsSync} from 'node:fs';
const log=${JSON.stringify(log)}, control=${JSON.stringify(control)}, release=${JSON.stringify(release)};
const readLog=()=>existsSync(log)?readFileSync(log,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];
const record=value=>appendFileSync(log,JSON.stringify(value)+'\\n');
if(process.argv.includes('--version')){console.log('codex directions fixture');process.exit(0);}
if(process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}
if(process.argv.includes('app-server')){
 const {createInterface}=await import('node:readline');
 createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);let result;
  if(m.method==='initialize')result={};
  else if(m.method==='account/read')result={account:{type:'chatgpt'}};
  else if(m.method==='model/list'){
   record({kind:'discovery'});
   result={data:[
    {model:'fixture-search',displayName:'Search',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'high'}],serviceTiers:[{id:'priority'}]},
    {model:'fixture-tutor',displayName:'Tutor',supportedReasoningEfforts:[{reasoningEffort:'medium'}],serviceTiers:[{id:'priority'}]},
    {model:'gpt-6-luna',displayName:'Luna',supportedReasoningEfforts:['high','low','medium'].map(reasoningEffort=>({reasoningEffort})),defaultReasoningEffort:'medium',serviceTiers:[{id:'priority'}]}
   ],nextCursor:null};
  }
  if(result)console.log(JSON.stringify({id:m.id,result}));
 });
 await new Promise(()=>{});
}
let input='';for await(const c of process.stdin)input+=c;
const prompt=JSON.parse(input.split('TASK DATA (JSON):\\n')[1]);
const args=process.argv.slice(2), isDirection=Array.isArray(prompt.signals);
const current=JSON.parse(readFileSync(control,'utf8'));
const sequence=readLog().filter(e=>e.kind==='directions').length;
record({kind:isDirection?'directions':'curate',args,prompt,mode:current.mode,sequence});
console.log(JSON.stringify({type:'turn.started'}));
if(!isDirection||current.mode==='gate')while(!existsSync(release))await new Promise(r=>setTimeout(r,20));
if(current.mode==='fail'){console.error('HTTP 503: fixture service temporarily unavailable');process.exit(1);}
if(!isDirection){console.error('Long curation fixture must be cancelled');process.exit(1);}
const topics=[['烹饪中的变化','城市的声音','树木如何交流','海洋里的旅程'],['设计一座桥','咖啡的一生','地图的故事','摄影与光线'],['睡眠的节奏','建筑里的数学','电池的未来','语言的起源'],['香料的旅行','天空的颜色','河流的形状','材料的秘密'],['交通与城市','种子的旅行','身边的艺术','水循环故事'],['云朵观察','日常发明','古老的港口','动物的合作']];
const titles=topics[sequence%topics.length];
const basis=prompt.signals.find(s=>!s.id.startsWith('general-'))||prompt.signals.find(s=>s.id==='general-science')||prompt.signals[0];
const value=current.mode==='repeat'?readLog().find(e=>e.kind==='result').value:{items:titles.map((title,i)=>({basisId:basis.id,title,prompt:'围绕「'+title+'」寻找英文入门阅读材料，并积累相关常用词汇。',target:i===0?'articles':'both'}))};
record({kind:'result',sequence,value});
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}}));
console.log(JSON.stringify({type:'turn.completed'}));
`, { mode: 0o700 });

  const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}/api`;
  let child, closed, token;
  const entries = kind => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []).filter(entry => !kind || entry.kind === kind);
  async function request(path, body, expected = 200) {
    const response = await fetch(base + path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Study-Token': token }, body: JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  }
  async function start() {
    let output = '';
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: resolve('.'), env: { ...process.env, PORT: String(port), STUDY_DATA_DIR: data, CODEX_BINARY: binary, STUDY_OPEN: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    closed = once(child, 'close');
    child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
    for (let i = 0; i < 150 && !output.includes('Between ·'); i++) await pause(20);
    assert.ok(output.includes('Between ·'), output);
    token = (await request('/bootstrap')).token;
  }
  async function stop() { if (child?.exitCode === null) { child.kill('SIGTERM'); await closed; } }
  async function finish(id, expected = 'completed') {
    for (let i = 0; i < 400; i++) {
      const job = await request('/jobs/' + id);
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        assert.equal(job.status, expected, job.error || JSON.stringify(job)); return job;
      }
      await pause(10);
    }
    assert.fail('Direction job did not finish');
  }
  async function waitInvocation(count, kind = 'directions') {
    for (let i = 0; i < 300 && entries(kind).length < count; i++) await pause(10);
    assert.ok(entries(kind).length >= count, `Expected ${count} ${kind} invocations`);
    return entries(kind).at(-1);
  }
  const mode = value => { rmSync(release, { force: true }); writeFileSync(control, JSON.stringify({ mode: value })); };
  const memory = async patch => {
    const old = await request('/memory');
    return request('/memory', { notes: old.notes, recording: old.recording, personalize: old.personalize, revision: old.revision, ...patch });
  };
  await start();
  return { request, start, stop, finish, entries, waitInvocation, mode, memory,
    release: () => writeFileSync(release, 'ready'),
    recommend: () => request('/jobs', { type: 'directions', params: { level: 'B1' } }, 202),
    close: async () => { await stop(); rmSync(directory, { recursive: true, force: true }); },
  };
}

const learningState = state => ({ words: state.words, decks: state.decks, articles: state.articles, selections: state.selections, events: state.memory.summary.stats.events });
const selectionFields = state => Object.fromEntries(['model', 'tutorModel', 'reasoningEffort', 'fastMode', 'tutorReasoningEffort', 'tutorFastMode', 'tutorProvider'].map(key => [key, state.settings[key]]));

test('directions use Luna Fast, replace the batch, avoid past cards, and persist without changing study data or model choices', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const initial = await f.request('/state');
    assert.equal(initial.modelCatalog.models.length, 0);
    await f.request('/state'); await f.request('/bootstrap');
    assert.equal(f.entries().length, 0, 'Opening the page must not invoke inference or model discovery');
    const first = await f.finish((await f.recommend()).id);
    assert.equal(f.entries('discovery').length, 1, 'An empty model catalog is discovered automatically');
    const one = await f.request('/state');
    assert.equal(one.directions.items.length, 4);
    assert.deepEqual(learningState(one), learningState(initial), 'Generating directions is not a learning event or material search');
    assert.deepEqual(selectionFields(one), selectionFields(initial));
    const invocation = f.entries('directions')[0];
    assert.equal(invocation.args[invocation.args.indexOf('-m') + 1], 'gpt-6-luna');
    assert.ok(invocation.args.includes('model_reasoning_effort="low"'), 'Use the lowest supported effort, regardless of catalog order');
    assert.ok(invocation.args.includes('service_tier="fast"'));
    assert.ok(!invocation.args.includes('web_search="live"'), 'Direction ideas do not require slow material retrieval');
    assert.equal(first.diagnostics.model, 'gpt-6-luna');
    assert.equal(first.diagnostics.fastMode, true);
    assert.equal(first.diagnostics.searches, 0);
    assert.equal(invocation.prompt.currentLevel, 'B1');
    for (const card of initial.directions.items) assert.ok(invocation.prompt.avoid.some(old => old.title === card.title), 'Avoid showing the current local starter cards again');

    await f.request('/settings', { model: 'fixture-search', tutorModel: 'fixture-tutor', reasoningEffort: 'high', fastMode: false, tutorReasoningEffort: 'medium', tutorFastMode: true });
    const configured = await f.request('/state');
    await f.finish((await f.recommend()).id);
    const two = await f.request('/state');
    assert.notDeepEqual(two.directions.items.map(c => c.title), one.directions.items.map(c => c.title), 'A new request yields another batch');
    assert.deepEqual(learningState(two), learningState(initial));
    assert.deepEqual(selectionFields(two), selectionFields(configured), 'Dedicated recommendation settings do not overwrite either selected model');
    for (const card of one.directions.items) assert.ok(f.entries('directions')[1].prompt.avoid.some(old => old.title === card.title));
    await f.finish((await f.recommend()).id);
    const history = f.entries('directions')[2].prompt.avoid;
    for (const card of [...one.directions.items, ...two.directions.items]) assert.ok(history.some(old => old.title === card.title), 'Recent generated batches stay in the exclusion context');
    const persisted = await f.request('/state');
    await f.stop(); await f.start();
    const restored = await f.request('/state');
    assert.deepEqual(restored.directions, persisted.directions, 'The successful batch survives a server restart');
    assert.deepEqual(learningState(restored), learningState(initial));
    assert.equal(f.entries('directions').length, 3, 'Reading a saved batch never regenerates it automatically');
  } finally { await f.close(); }
});

test('repeated clicks share one task; failures and cancellation retain the last successful directions', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await f.finish((await f.recommend()).id);
    const saved = (await f.request('/state')).directions;
    f.mode('gate');
    const pending = await f.recommend();
    await f.waitInvocation(2);
    const duplicate = await f.recommend();
    assert.equal(duplicate.id, pending.id);
    assert.equal(f.entries('directions').length, 2);
    await f.request('/jobs/' + pending.id + '/cancel', {});
    f.release();
    await f.finish(pending.id, 'cancelled');
    await pause(100);
    assert.deepEqual((await f.request('/state')).directions, saved, 'A cancelled task cannot replace existing cards');
    f.mode('fail');
    await f.finish((await f.recommend()).id, 'failed');
    assert.deepEqual((await f.request('/state')).directions, saved, 'A failed request cannot erase existing cards');
    assert.equal(f.entries('directions').length, 3);
    f.mode('repeat');
    await f.finish((await f.recommend()).id, 'failed');
    assert.deepEqual((await f.request('/state')).directions, saved, 'A model response repeating previous cards is rejected without erasing the successful batch');
  } finally { await f.close(); }
});

test('memory changes invalidate directions, late results cannot overwrite them, and disabled memory is omitted from future prompts', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await f.memory({ notes: '- 感兴趣的主题：私有兴趣标记 private-interest-marker 天文学。' });
    await f.finish((await f.recommend()).id);
    assert.ok(JSON.stringify(f.entries('directions')[0].prompt).includes('private-interest-marker'));
    const saved = (await f.request('/state')).directions;
    f.mode('gate');
    const pending = await f.recommend();
    await f.waitInvocation(2);
    await f.memory({ notes: '- 感兴趣的主题：园艺和生态。' });
    const invalidated = (await f.request('/state')).directions;
    assert.notDeepEqual(invalidated.items, saved.items, 'Saving memory immediately invalidates generated recommendations');
    assert.ok(JSON.stringify(invalidated).includes('园艺'));
    f.release();
    await f.finish(pending.id, 'failed');
    assert.deepEqual((await f.request('/state')).directions, invalidated, 'A result based on old memory must not publish after preferences change');
    await f.memory({ personalize: false });
    const disabled = await f.request('/state');
    assert.equal(disabled.directions.personalized, false);
    assert.ok(!JSON.stringify(disabled.directions).includes('园艺'));
    const count = f.entries('directions').length;
    await f.request('/state'); await f.request('/bootstrap');
    assert.equal(f.entries('directions').length, count, 'Memory synchronization never starts inference');
    f.mode('success');
    await f.finish((await f.recommend()).id);
    const prompt = JSON.stringify(f.entries('directions').at(-1).prompt);
    assert.ok(!prompt.includes('private-interest-marker'));
    assert.ok(!prompt.includes('园艺'));
    for (const card of saved.items) assert.ok(!prompt.includes(card.title), 'Personalized history must not leak through exclusions after sharing is disabled');
    assert.equal((await f.request('/state')).directions.personalized, false);
  } finally { await f.close(); }
});

test('directions finish while a normal curation task is still running and preserve that task model', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await f.request('/models', {});
    await f.request('/settings', { model: 'fixture-search', reasoningEffort: 'high', fastMode: false });
    const curation = await f.request('/jobs', { type: 'curate', params: { prompt: '筛选关于太空的材料', target: 'both', defaultLevel: 'B1', defaultWordCount: 10, defaultArticleCount: 1 } }, 202);
    const running = await f.waitInvocation(1, 'curate');
    assert.equal(running.args[running.args.indexOf('-m') + 1], 'fixture-search');
    assert.ok(running.args.includes('model_reasoning_effort="high"'));
    const before = await f.request('/state');
    await f.finish((await f.recommend()).id);
    assert.equal((await f.request('/jobs/' + curation.id)).status, 'running', 'The material task remains in flight during recommendation completion');
    assert.deepEqual(learningState(await f.request('/state')), learningState(before));
    await f.request('/jobs/' + curation.id + '/cancel', {});
    await f.finish(curation.id, 'cancelled');
  } finally { await f.close(); }
});
