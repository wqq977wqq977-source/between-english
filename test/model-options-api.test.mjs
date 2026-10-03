import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const pause = ms => new Promise(r => setTimeout(r, ms));

test('model options persist, reach the correct Codex tasks and remain fixed for queued jobs', { timeout: 25000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'between-options-http-'));
  const data = join(directory, 'data'), binary = join(directory, 'fake-codex');
  const trace = join(directory, 'invocations.jsonl'), release = join(directory, 'release');
  const articleText = 'Earth follows an orbit. An orbit is a curved path around another object. People can study this path to learn how objects move in space.';
  writeFileSync(binary, `#!${process.execPath}
import {appendFileSync,existsSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('codex fixture');process.exit(0);}
if(process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}
if(process.argv.includes('app-server')){
 const {createInterface}=await import('node:readline');
 createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);let result;
  if(m.method==='initialize')result={};
  else if(m.method==='account/read')result={account:{type:'chatgpt'}};
  else if(m.method==='model/list')result={data:[
   {model:'search',displayName:'Search',isDefault:true,supportedReasoningEfforts:['low','medium','high'].map(reasoningEffort=>({reasoningEffort})),defaultReasoningEffort:'medium',serviceTiers:[{id:'priority',name:'Fast'}]},
   {model:'tutor',displayName:'Tutor',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low',serviceTiers:[]}
  ],nextCursor:null};
  if(result)console.log(JSON.stringify({id:m.id,result}));
 });
 await new Promise(()=>{});
}
let input='';for await(const c of process.stdin)input+=c;
const p=JSON.parse(input.split('TASK DATA (JSON):\\n')[1]);
appendFileSync(${JSON.stringify(trace)},JSON.stringify({args:process.argv.slice(2),question:p.question,task:p.task})+'\\n');
if(p.question==='hold')while(!existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,10));
const emit=item=>console.log(JSON.stringify({type:'item.completed',item}));
let value;
if(p.task.startsWith('Search')){
 const url='https://example.org/orbit';
 emit({type:'web_search',action:{type:'search',query:'orbit'},results:[{url,title:'Orbit'}]});
 value=p.task.includes('dictionaries')?{words:[{word:'orbit',phonetic:'',partOfSpeech:'noun',meaning:'轨道',definition:'A path around a body.',example:'Earth follows an orbit.',exampleTranslation:'地球沿轨道运行。',level:'B1',sourceUrl:url,sourceTitle:'Orbit'}],note:''}:{articles:[{title:'Orbit',url,source:'Fixture',publishedAt:'',summary:'轨道',level:'B1',estimatedWords:400,reason:'Matches'}],note:''};
}else value={answer:'A curved path.',vocabulary:[],evidence:'Earth follows an orbit.'};
emit({type:'agent_message',text:JSON.stringify(value)});
`, { mode: 0o700 });
  const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const base = `http://127.0.0.1:${port}/api`;
  let child, closed, token, output = '';
  async function request(path, body, expected = 200) {
    const response = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Study-Token': token }, body: JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  }
  async function start() {
    output = '';
    child = spawn(process.execPath, ['server/index.mjs'], { cwd: resolve('.'), env: { ...process.env, PORT: String(port), STUDY_DATA_DIR: data, CODEX_BINARY: binary, STUDY_OPEN: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    closed = once(child, 'close'); child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
    for (let i = 0; i < 150 && !output.includes('Between ·'); i++) await pause(20);
    assert.ok(output.includes('Between ·'), output); token = (await request('/bootstrap')).token;
  }
  async function stop() { if (child?.exitCode === null) { child.kill('SIGTERM'); await closed; } }
  async function finish(id) {
    for (let i = 0; i < 250; i++) { const j = await request('/jobs/' + id); if (j.status === 'completed') return j; if (j.status === 'failed') assert.fail(j.error); await pause(10); }
    assert.fail('Job timed out');
  }
  const calls = () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const configArgs = call => call.args.filter((_, i, all) => i > 0 && all[i - 1] === '-c');
  const prefs = { model: 'search', tutorModel: 'tutor', reasoningEffort: 'high', fastMode: true, tutorReasoningEffort: 'low', tutorFastMode: false };
  try {
    await start();
    const initial = (await request('/state')).settings;
    assert.equal(initial.reasoningEffort, ''); assert.equal(initial.fastMode, false);
    await request('/settings', { reasoningEffort: 'high' }, 400);
    const catalog = await request('/models', {});
    assert.deepEqual(catalog.models[0].reasoningEfforts, ['low', 'medium', 'high']);
    assert.equal(catalog.models[0].supportsFast, true); assert.equal(catalog.models[1].supportsFast, false);
    await request('/settings', { ...prefs, tutorFastMode: true }, 400);
    await request('/settings', { ...prefs, tutorReasoningEffort: 'high' }, 400);
    await request('/settings', { ...prefs, fastMode: 'false' }, 400);
    await request('/settings', { ...prefs, reasoningEffort: null }, 400);
    assert.equal((await request('/state')).settings.model, '', 'Invalid options must not partially save settings');
    await request('/settings', prefs);
    const article = await request('/articles/import', { title: 'Model options fixture', text: articleText });
    for (const type of ['words', 'articles']) {
      const params = { count: 1, level: 'B1', topic: 'space', minWords: 100, maxWords: 800 };
      await finish((await request('/jobs', { type, params }, 202)).id);
      const call = calls().at(-1), configs = configArgs(call);
      assert.equal(call.args[call.args.indexOf('-m') + 1], 'search');
      assert.ok(configs.includes('model_reasoning_effort="high"')); assert.ok(configs.includes('service_tier="fast"'));
    }
    const hold = await request('/jobs', { type: 'explain', params: { articleId: article.id, question: 'hold' } }, 202);
    for (let i = 0; i < 150 && !calls().some(c => c.question === 'hold'); i++) await pause(10);
    assert.ok(calls().some(c => c.question === 'hold'));
    const queued = await request('/jobs', { type: 'explain', params: { articleId: article.id, question: 'queued' } }, 202);
    await request('/settings', { tutorModel: '', tutorReasoningEffort: 'medium', tutorFastMode: true });
    writeFileSync(release, 'continue'); await finish(hold.id); await finish(queued.id);
    const queuedCall = calls().find(c => c.question === 'queued');
    assert.equal(queuedCall.args[queuedCall.args.indexOf('-m') + 1], 'tutor');
    assert.ok(configArgs(queuedCall).includes('model_reasoning_effort="low"'));
    assert.ok(configArgs(queuedCall).includes('service_tier="default"'));
    await finish((await request('/jobs', { type: 'explain', params: { articleId: article.id, question: 'inherit model only' } }, 202)).id);
    assert.equal(calls().at(-1).args[calls().at(-1).args.indexOf('-m') + 1], 'search');
    assert.ok(configArgs(calls().at(-1)).includes('model_reasoning_effort="medium"'), 'Reading uses its own effort while inheriting the model');
    await stop(); await start();
    const restored = (await request('/state')).settings;
    assert.equal(restored.reasoningEffort, 'high'); assert.equal(restored.fastMode, true);
    assert.equal(restored.tutorReasoningEffort, 'medium'); assert.equal(restored.tutorFastMode, true);
    await request('/settings', { model: 'tutor' });
    const switched = (await request('/state')).settings;
    assert.equal(switched.reasoningEffort, ''); assert.equal(switched.fastMode, false);
    assert.equal(switched.tutorReasoningEffort, ''); assert.equal(switched.tutorFastMode, false);
  } finally { writeFileSync(release, 'continue'); await stop(); rmSync(directory, { recursive: true, force: true }); }
});
