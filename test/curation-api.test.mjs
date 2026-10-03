import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../server/db.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('unified curation distributes verified material, honors scope and memory, and survives a restart', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'between-curation-http-'));
  const data = join(directory, 'data'), binary = join(directory, 'fake-codex'), log = join(directory, 'prompts.jsonl');
  const legacyStore = openStore(data);
  legacyStore.put('settings', { id: 'settings', defaultLevel: 'C2' });
  legacyStore.close();
  const apiRequests = [];
  // Only the model process is replaced. Real HTTP routes, prompt construction,
  // source checks, memory, material distribution and SQLite persistence run here.
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
  else if(m.method==='model/list')result={data:[{model:'fixture-search',displayName:'Search',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'high'}],serviceTiers:[{id:'priority'}]},{model:'fixture-tutor',displayName:'Tutor',isDefault:false}],nextCursor:null};
  if(result)console.log(JSON.stringify({id:m.id,result}));
 });
 await new Promise(()=>{});
}
let input='';for await(const c of process.stdin)input+=c;
const p=JSON.parse(input.split('TASK DATA (JSON):\\n')[1]);
const marker=String(p.learnerRequest||'').match(/\\[([a-z-]+)\\]/)?.[1]||'both-valid';
appendFileSync(${JSON.stringify(log)},JSON.stringify({prompt:p,args:process.argv.slice(2),marker})+'\\n');
if(marker==='cancel')await new Promise(r=>setTimeout(r,1200));
const wordSource='https://example.org/'+marker+'/dictionary';
const articleSource='https://example.org/'+marker+'/article';
const word=name=>({word:name,phonetic:'',partOfSpeech:'noun',meaning:'测试词义',definition:'An English learning word.',example:'We learn this word today.',exampleTranslation:'我们今天学习这个词。',level:'B1',sourceUrl:wordSource,sourceTitle:'Fixture dictionary'});
const words=marker==='both-valid'?[word('orbit'),word('planet')]:marker==='exclude-known'?[word('orbit'),word('comet')]:[word('lex-'+marker)];
const articles=[{title:'Space '+marker,url:articleSource,source:'Fixture reading',publishedAt:'2026-09-01',summary:'关于太空的短文',level:'B1',estimatedWords:400,reason:'Matches the requested topic.'}];
if(['partial','invalid-both'].includes(marker))words.forEach(w=>w.sourceUrl='https://unverified.example/word');
if(marker==='invalid-both')articles[0].url='https://unverified.example/article';
const value={title:'Space · '+marker,wordsRequested:marker==='wrong-scope'||(p.target!=='articles'&&marker!=='auto-articles'),articlesRequested:marker==='wrong-scope'||p.target!=='words',
 wordFilters:{count:2,level:'B1',topic:'太空',range:'主题词汇',extra:'',excludeKnown:true},
 articleFilters:{count:1,level:'B1',topic:'太空',extra:'',minWords:100,maxWords:800,type:'不限',domain:'',since:''},
 words,articles,note:''};
const emit=item=>console.log(JSON.stringify({type:'item.completed',item}));
emit({type:'web_search',action:{type:'search',query:'space learning '+marker},results:[{url:wordSource,title:'Dictionary'},{url:articleSource,title:'Reading'}]});
emit({type:'agent_message',text:JSON.stringify(value)});
`, { mode: 0o700 });

  const upstream = http.createServer((req, res) => {
    apiRequests.push(req.url);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Curation must use Codex.' } }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const endpoint = `http://127.0.0.1:${upstream.address().port}/v1`;
  const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}/api`;
  let child, closed, token, output = '';

  async function request(path, body, expected = 200) {
    const response = await fetch(base + path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Study-Token': token }, body: JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  }
  async function start() {
    output = '';
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: resolve('.'),
      env: { ...process.env, PORT: String(port), STUDY_DATA_DIR: data, CODEX_BINARY: binary, STUDY_OPEN: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    closed = once(child, 'close');
    child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
    for (let i = 0; i < 150 && !output.includes('Between ·'); i++) await pause(20);
    assert.ok(output.includes('Between ·'), output);
    token = (await request('/bootstrap')).token;
  }
  async function stop() {
    if (child?.exitCode === null) { child.kill('SIGTERM'); await closed; }
  }
  async function finish(id, expected = 'completed') {
    for (let i = 0; i < 250; i++) {
      const job = await request('/jobs/' + id);
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        assert.equal(job.status, expected, job.error || JSON.stringify(job)); return job;
      }
      await pause(10);
    }
    assert.fail('Curation job did not finish');
  }
  const params = (marker, target = 'both') => ({ prompt: `帮我筛选太空主题的学习材料 [${marker}]`, target, defaultWordCount: 2, defaultArticleCount: 1, defaultLevel: 'B1' });
  const curate = async (marker, target = 'both', expected = 'completed') => finish((await request('/jobs', { type: 'curate', params: params(marker, target) }, 202)).id, expected);
  const prompts = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const configureMemory = async patch => {
    const memory = await request('/memory');
    return request('/memory', { notes: memory.notes, recording: memory.recording, personalize: memory.personalize, revision: memory.revision, ...patch });
  };
  const materialIds = state => ({ words: state.words.map(w => w.id).sort(), decks: state.decks.map(d => d.id).sort(), articles: state.articles.map(a => a.id).sort(), selections: state.selections.map(s => s.id).sort() });

  try {
    await start();
    const initial = await request('/state');
    assert.ok(Array.isArray(initial.selections)); assert.equal(initial.selections.length, 0);
    assert.ok(Array.isArray(initial.directions.items)); assert.ok(initial.directions.items.length > 0);
    assert.equal(initial.settings.defaultLevel, 'C2', 'Legacy difficulty remains readable for page preference migration');
    assert.doesNotMatch(initial.directions.items.map(item => item.prompt).join('\n'), /\b(?:A1|A2|B1|B2|C1|C2)\b/, 'Direction prompts must not override the selection page difficulty');
    const initialEvents = initial.memory.summary.stats.events;
    await request('/state'); await request('/bootstrap');
    assert.equal((await request('/memory')).summary.stats.events, initialEvents, 'Viewing recommendations must not create learning events');
    await request('/jobs', { type: 'curate', params: { prompt: '', target: 'both' } }, 400);

    await request('/models', {});
    await request('/settings', { model: 'fixture-search', tutorModel: 'fixture-tutor', reasoningEffort: 'high', fastMode: true, defaultLevel: 'B1', tutorProvider: 'api', api: { baseUrl: endpoint, model: 'fixture-api', apiKey: 'fixture-only-secret' } });
    assert.equal((await request('/state')).settings.defaultLevel, 'C2', 'Saving model settings ignores difficulty sent by an older client');
    await configureMemory({ notes: '喜欢太空主题；先拆句子主干，再给例子。' });
    const firstJob = await curate('both-valid'), both = firstJob.result;
    assert.equal(firstJob.diagnostics.outcome, 'completed');
    assert.equal(firstJob.diagnostics.model, 'fixture-search');
    assert.equal(firstJob.diagnostics.reasoningEffort, 'high');
    assert.equal(firstJob.diagnostics.searches, 1);
    assert.ok(!JSON.stringify(firstJob.diagnostics).includes('fixture-only-secret'));
    assert.equal(both.target, 'both'); assert.match(both.prompt, /both-valid/);
    assert.equal(both.words.status, 'ready'); assert.equal(both.words.count, 2);
    assert.equal(both.articles.status, 'ready'); assert.equal(both.articles.count, 1);
    let state = await request('/state');
    const deck = state.decks.find(d => d.id === both.words.deckId);
    assert.ok(deck); assert.deepEqual(deck.wordIds.map(id => state.words.find(w => w.id === id).word).sort(), ['orbit', 'planet']);
    assert.equal(deck.filters.count, 2); assert.equal(deck.filters.level, 'B1');
    assert.equal(state.articles.find(a => a.id === both.articles.articleIds[0]).title, 'Space both-valid');
    assert.equal(state.selections[0].id, both.id);
    assert.equal(state.memory.summary.stats.events, initialEvents + 4, 'A combined selection records request and completion for each category');
    assert.equal(state.directions.personalized, true);
    assert.ok(state.directions.items.some(item => item.reason.includes('太空')), 'Recommendations use the recorded topic');
    assert.equal(prompts().length, 1, 'A combined request should make one Codex call');
    const invocation = prompts()[0];
    assert.equal(invocation.args[invocation.args.indexOf('-m') + 1], 'fixture-search', 'Curation uses the search model');
    assert.ok(invocation.args.includes('web_search="live"'));
    assert.ok(invocation.args.includes('model_reasoning_effort="high"'), 'Curation uses the search effort');
    assert.ok(invocation.args.includes('service_tier="fast"'), 'Curation uses the search Fast preference');
    assert.equal(invocation.prompt.learnerRequest, params('both-valid').prompt);
    assert.equal(invocation.prompt.defaults.wordFilters.count, 2);
    assert.equal(invocation.prompt.defaults.articleFilters.count, 1);
    assert.equal(invocation.prompt.defaults.wordFilters.level, 'B1');
    assert.equal(invocation.prompt.defaults.articleFilters.level, 'B1', 'Explicit selection difficulty is independent of model settings');
    assert.equal(invocation.prompt.learningMemory.userNotes, '喜欢太空主题；先拆句子主干，再给例子。');
    assert.equal(apiRequests.length, 0, 'Choosing an API tutor must not reroute material search');

    await request('/words/word%3Aorbit', { rating: 'known', mode: 'meaning' });
    const beforeWordsOnly = await request('/state');
    const wordsOnly = (await curate('exclude-known', 'words')).result;
    assert.equal(wordsOnly.words.status, 'ready'); assert.equal(wordsOnly.words.count, 1, 'Known words are excluded even if returned by the model');
    assert.equal(wordsOnly.articles.requested, false); assert.equal(wordsOnly.articles.status, 'skipped');
    state = await request('/state');
    assert.deepEqual(state.articles.map(a => a.id).sort(), beforeWordsOnly.articles.map(a => a.id).sort());
    const newDeck = state.decks.find(d => d.id === wordsOnly.words.deckId);
    assert.deepEqual(newDeck.wordIds, ['word:comet']);
    assert.ok(prompts().at(-1).prompt.excludedKnownWords.includes('orbit'), 'The model receives the known-word exclusion');

    const beforeArticlesOnly = await request('/state');
    const articlesOnly = (await curate('articles-only', 'articles')).result;
    assert.equal(articlesOnly.words.requested, false); assert.equal(articlesOnly.words.status, 'skipped');
    assert.equal(articlesOnly.articles.status, 'ready');
    state = await request('/state');
    assert.deepEqual(state.words.map(w => w.id).sort(), beforeArticlesOnly.words.map(w => w.id).sort());
    assert.deepEqual(state.decks.map(d => d.id).sort(), beforeArticlesOnly.decks.map(d => d.id).sort());

    const automatic = (await curate('auto-articles', 'auto')).result;
    assert.equal(automatic.words.status, 'skipped'); assert.equal(automatic.articles.status, 'ready');

    const beforePartial = await request('/state');
    const partial = (await curate('partial')).result;
    assert.equal(partial.words.requested, true); assert.equal(partial.words.status, 'empty'); assert.equal(partial.words.count, 0);
    assert.equal(partial.articles.status, 'ready'); assert.ok(partial.words.note);
    state = await request('/state');
    assert.deepEqual(state.words.map(w => w.id).sort(), beforePartial.words.map(w => w.id).sort(), 'Unverified word citations cannot be saved');
    assert.ok(state.articles.some(a => a.id === partial.articles.articleIds[0]));
    assert.ok(state.selections.some(s => s.id === partial.id), 'The successful category remains accessible from selection history');

    const beforeInvalid = materialIds(state);
    const invalid = await curate('invalid-both', 'both', 'failed');
    assert.ok(invalid.error);
    assert.deepEqual(materialIds(await request('/state')), beforeInvalid, 'If neither category has verified matches, no selection or material is saved');
    await curate('wrong-scope', 'words', 'failed');
    assert.deepEqual(materialIds(await request('/state')), beforeInvalid, 'A response that changes the requested scope cannot be saved');

    await configureMemory({ personalize: false });
    const disabledBefore = await request('/state');
    assert.equal(disabledBefore.directions.personalized, false);
    await request('/state'); await request('/bootstrap');
    assert.equal((await request('/memory')).summary.stats.events, disabledBefore.memory.summary.stats.events);
    await curate('memory-off', 'words');
    assert.equal(prompts().at(-1).prompt.learningMemory, undefined, 'Turning personalization off prevents memory from being sent to Codex');

    const beforeCancel = materialIds(await request('/state'));
    const cancellation = await request('/jobs', { type: 'curate', params: params('cancel') }, 202);
    for (let i = 0; i < 150 && !prompts().some(p => p.marker === 'cancel'); i++) await pause(10);
    assert.ok(prompts().some(p => p.marker === 'cancel'), 'Wait until Codex is running before cancellation');
    assert.equal((await request('/jobs/' + cancellation.id + '/cancel', {})).status, 'cancelled');
    await pause(1300);
    await finish(cancellation.id, 'cancelled');
    assert.deepEqual(materialIds(await request('/state')), beforeCancel, 'Cancelling a running selection cannot save a late result');

    for (const suffix of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) await curate('history-' + suffix, 'words');
    const latest = await request('/state');
    assert.equal(latest.selections.length, 12, 'The workspace returns the 12 latest selections');
    assert.ok(!latest.selections.some(selection => selection.id === both.id));
    assert.ok(latest.decks.some(saved => saved.id === both.words.deckId), 'Older material remains available after its selection leaves the recent list');

    await finish((await request('/jobs', { type: 'curate', params: { prompt: '太空主题 [no-level]', target: 'words' } }, 202)).id);
    assert.equal(prompts().at(-1).prompt.defaults.wordFilters.level, 'B2', 'An omitted selection difficulty uses the request default, not the legacy model preference');
    assert.equal(prompts().at(-1).prompt.defaults.articleFilters.level, 'B2');

    const persisted = await request('/state');
    const ids = materialIds(persisted);
    await stop(); await start();
    const restored = await request('/state');
    assert.deepEqual(materialIds(restored), ids);
    assert.deepEqual(restored.selections, persisted.selections, 'Selection destinations and history survive a process restart');
    assert.equal(restored.settings.defaultLevel, 'C2', 'Model settings preserve the legacy migration value across restart');
    assert.deepEqual((await request('/jobs/' + firstJob.id)).diagnostics, firstJob.diagnostics, 'Safe request diagnostics survive a process restart');
    assert.equal(restored.memory.summary.stats.events, persisted.memory.summary.stats.events);
    assert.equal(apiRequests.length, 0);
  } finally {
    await stop();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
