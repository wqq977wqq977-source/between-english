import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../server/db.mjs';

test('real HTTP routes record behavior and send memory through the Codex CLI boundary', { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'between-memory-api-'));
  const data = join(directory, 'data'), log = join(directory, 'prompts.jsonl'), binary = join(directory, 'fake-codex');
  const initial = openStore(data);
  initial.put('word', { id: 'word:legacy', word: 'legacy', review: { rating: 'known', reviewedAt: '2025-01-01T00:00:00Z' } });
  initial.close();
  // This fixture replaces only the model process. HTTP routes, prompts, validation,
  // persistence and Markdown generation run as production code in an isolated store.
  writeFileSync(binary, `#!${process.execPath}
import {appendFileSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('codex fixture');process.exit(0);}
if(process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}
if(process.argv.includes('app-server')){
 const {createInterface}=await import('node:readline');
 createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);let result;
  if(m.method==='initialize')result={};
  else if(m.method==='account/read')result={account:{type:'chatgpt'}};
  else if(m.method==='model/list')result={data:[{model:'fixture-model',displayName:'Fixture model',isDefault:true}],nextCursor:null};
  if(result)console.log(JSON.stringify({id:m.id,result}));
 });
 await new Promise(()=>{});
}
let input='';for await(const c of process.stdin)input+=c;
const p=JSON.parse(input.split('TASK DATA (JSON):\\n')[1]);appendFileSync(${JSON.stringify(log)},JSON.stringify(p)+'\\n');
let value;
const word={word:'orbit',phonetic:'',partOfSpeech:'noun',meaning:'轨道',definition:'A path around a body.',example:'Earth follows an orbit.',exampleTranslation:'地球沿着轨道运行。',level:'B1'};
const sourceUrl='https://example.org/orbit';
const emit=item=>console.log(JSON.stringify({type:'item.completed',item}));
if(p.task.startsWith('Search')){
 emit({type:'web_search',action:{type:'search',query:'orbit'},results:[{url:sourceUrl,title:'Orbit'}]});
 value=p.task.includes('dictionaries')?{words:[{...word,sourceUrl,sourceTitle:'Fixture source'}],note:''}:{articles:[{title:'Orbit',url:sourceUrl,source:'Fixture',publishedAt:'',summary:'轨道',level:'B1',estimatedWords:400,reason:'Test'}],note:''};
}else if(p.task.startsWith('Create exactly'))value={questions:[{question:'What does Earth follow?',type:'choice',options:['An orbit','A road','A river','A train'],answer:'An orbit',explanation:'Find the exact sentence.',evidence:'Earth follows an orbit.'}]};
else if(p.task.startsWith('Grade'))value={results:p.questions.map(q=>({questionId:q.id,score:0,feedback:'请回顾轨道的含义。',referenceAnswer:q.answer,evidence:q.evidence}))};
else if(p.task.startsWith('Explain the selected'))value={...word,word:p.selection};
else value={answer:'Fixture answer: '+(p.learningMemory?.userNotes||'no memory'),vocabulary:[],evidence:'Earth follows an orbit.'};
emit({type:'agent_message',text:JSON.stringify(value)});
`, { mode: 0o700 });
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: resolve('.'), env: { ...process.env, PORT: String(port), STUDY_DATA_DIR: data, CODEX_BINARY: binary, STUDY_OPEN: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let output = ''; child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
  const base = `http://127.0.0.1:${port}`;
  let token;
  const request = async (path, body, expected = 200) => {
    const response = await fetch(base + '/api' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Study-Token': token }, body: JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  const job = async (type, params) => {
    const started = await request('/jobs', { type, params }, 202);
    for (let i = 0; i < 200; i++) { const value = await request('/jobs/' + started.id); if (value.status === 'completed') return value.result; if (value.status === 'failed') assert.fail(value.error); await new Promise(r => setTimeout(r, 10)); }
    assert.fail('Job did not finish');
  };
  const configure = async patch => { const m = await request('/memory'); return request('/memory', { notes: m.notes, recording: m.recording, personalize: m.personalize, revision: m.revision, ...patch }); };
  try {
    // The full suite starts several fixture servers and CLI processes together.
    const readyDeadline = Date.now() + 6000;
    while (!output.includes('Between ·') && child.exitCode === null && Date.now() < readyDeadline) await new Promise(r => setTimeout(r, 20));
    assert.ok(output.includes('Between ·'), output);
    const bootstrap = await request('/bootstrap'); token = bootstrap.token;
    assert.equal(bootstrap.memory.summary.stats.events, 0);
    await request('/settings', { model: 'not-discovered', tutorModel: '', defaultLevel: 'B1' }, 400);
    const catalog = await request('/models', {});
    assert.equal(catalog.models[0].id, 'fixture-model');
    await request('/settings', { model: 'fixture-model', tutorModel: 'fixture-model', defaultLevel: 'B1' });
    const withSettings = await request('/state');
    assert.equal(withSettings.settings.model, 'fixture-model');
    assert.equal(withSettings.settings.tutorModel, 'fixture-model');
    assert.equal(withSettings.modelCatalog.fetchedAt, catalog.fetchedAt);
    await configure({ notes: '先拆句子主干，举一个旅行例子。' });
    await job('words', { count: 1, level: 'B1', topic: 'space', excludeKnown: true });
    let prompts = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(prompts[0].criteria.exclude, []);
    assert.equal(prompts[0].learningMemory.userNotes, '先拆句子主干，举一个旅行例子。');
    await request('/words/word%3Aorbit', { rating: 'fuzzy', mode: 'spelling' });
    await job('articles', { count: 1, level: 'B1', topic: 'space', minWords: 100, maxWords: 800 });
    const candidate = (await request('/state')).articles.find(item => !item.hasText);
    assert.ok(candidate);
    assert.equal((await request(`/articles/${candidate.id}`, { paragraph: 0 })).startedAt, undefined, 'A candidate without its original text cannot be marked started by a position save');
    const article = await request('/articles/import', { title: 'Fixture reading', text: 'Earth follows an orbit. An orbit is a curved path around another object. People can study this path to learn how objects move in space. This is a test article.' });
    const articleId = article.id;
    assert.equal(article.startedAt, undefined, 'Importing text does not mean it has been read');
    const before = (await request('/memory')).summary.stats.events;
    assert.equal((await request(`/articles/${articleId}`)).startedAt, undefined, 'Reading GETs must not mark an article started');
    const progress = await request(`/articles/${articleId}`, { paragraph: 0 });
    assert.ok(Number.isFinite(Date.parse(progress.startedAt)), 'Saving the visible first paragraph marks a direct reader visit as started');
    assert.equal(progress.paragraph, 0);
    assert.equal(progress.text, undefined, 'Position saves return metadata only');
    assert.equal((await request(`/articles/${articleId}`, { paragraph: 0 })).startedAt, progress.startedAt, 'Repeated position saves keep the original start time');
    assert.equal((await request('/memory')).summary.stats.events, before, 'GET and automatic position saves must not count as learning');
    const visited = await request(`/articles/${articleId}/visit`, {});
    assert.equal(visited.startedAt, progress.startedAt, 'An explicit visit preserves an already recorded reading start');
    assert.equal(visited.text, undefined, 'The visit response returns only article metadata');
    assert.equal((await request('/state')).articles.find(item => item.id === articleId).startedAt, visited.startedAt);
    await request(`/articles/${articleId}`, { completed: true });
    await request(`/articles/${articleId}`, { completed: true });
    await job('explain', { articleId, selection: 'Earth follows an orbit.', question: 'Why this sentence?' });
    await job('word', { articleId, selection: 'orbit', context: 'Earth follows an orbit.' });
    const quiz = await job('quiz', { articleId, count: 1, questionType: '选择题' });
    let m = await request('/memory');
    assert.ok(!m.markdown.includes('What does Earth follow?'), 'unanswered quiz must not leak answers or question-derived weaknesses');
    const detail = await request(`/articles/${articleId}`), q = detail.quizzes[0].questions[0];
    await job('grade', { articleId, quizId: quiz.quizId, answers: { [q.id]: 'A road' } });
    m = await request('/memory');
    assert.equal(m.summary.stats.reviews, 1); assert.equal(m.summary.stats.questions, 1);
    assert.equal(m.summary.stats.articleOpens, 1); assert.equal(m.summary.stats.articlesCompleted, 1);
    assert.equal(m.summary.stats.quizzes, 1); assert.equal(m.summary.stats.score, 0);
    assert.equal(m.summary.reviewWords[0].word, 'orbit');
    assert.ok(m.markdown.includes('拼写练习')); assert.ok(m.markdown.includes('What does Earth follow?'));
    assert.equal(m.summary.stats.events, 12);
    prompts = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(prompts.length, 6);
    assert.ok(prompts.every(p => p.learningMemory && p.personalization));
    await configure({ recording: false, personalize: false });
    const revisited = await request(`/articles/${articleId}/visit`, {});
    assert.equal(revisited.startedAt, visited.startedAt, 'Reading again keeps the original start time even when memory recording is off');
    await request('/words/word%3Aorbit', { rating: 'known' });
    await job('explain', { articleId, question: 'With memory off' });
    m = await request('/memory'); assert.equal(m.summary.stats.events, 12);
    prompts = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(prompts.at(-1).learningMemory, undefined);
    await configure({ recording: true, personalize: true });
    assert.equal((await request('/memory')).summary.stats.events, 12);
    const download = await fetch(base + '/api/memory?download=1');
    assert.equal(download.headers.get('content-disposition'), 'attachment; filename="memroy.md"');
    assert.equal(await download.text(), readFileSync(join(data, 'memroy.md'), 'utf8'));
  } finally {
    child.kill('SIGTERM'); await closed;
    rmSync(directory, { recursive: true, force: true });
  }
});
