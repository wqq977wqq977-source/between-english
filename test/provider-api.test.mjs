import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('API settings, reading tasks, Codex search and destination snapshots work through real HTTP routes', { timeout: 25000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'between-provider-http-'));
  const data = join(directory, 'data'), binary = join(directory, 'fake-codex');
  const key = 'fixture-secret-for-http-only', requests = [];
  const articleText = 'Earth follows an orbit. An orbit is a curved path around another object. People can study this path to learn how objects move in space.';
  const word = { word:'orbit', phonetic:'', partOfSpeech:'noun', meaning:'轨道', definition:'A path around a body.', example:'Earth follows an orbit.', exampleTranslation:'地球沿轨道运行。', level:'B1' };
  writeFileSync(binary, `#!${process.execPath}
if(process.argv.includes('--version')){console.log('codex fixture');process.exit(0);}
if(process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}
let input='';for await(const c of process.stdin)input+=c;
const p=JSON.parse(input.split('TASK DATA (JSON):\\n')[1]);
const emit=item=>console.log(JSON.stringify({type:'item.completed',item}));
if(p.task.startsWith('Search')){
 const url='https://example.org/orbit';
 emit({type:'web_search',action:{type:'search',query:'orbit'},results:[{url,title:'Orbit'}]});
 emit({type:'agent_message',text:JSON.stringify(p.task.includes('dictionaries')?{words:[{...${JSON.stringify(word)},sourceUrl:url,sourceTitle:'Fixture'}],note:''}:{articles:[{title:'Orbit',url,source:'Fixture',publishedAt:'',summary:'轨道',level:'B1',estimatedWords:400,reason:'Test'}],note:''})});
}else emit({type:'agent_message',text:JSON.stringify({answer:'Codex answer',vocabulary:[],evidence:'Earth follows an orbit.'})});
`, { mode:0o700 });

  let releaseSlow;
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ path:req.url, authorization:req.headers.authorization, body });
    const send = value => { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(value)); };
    if (req.url.endsWith('/models')) return send({ data:[{id:'fixture/tutor'}, {id:'fixture/tutor'}, {id:'second-model'}] });
    const p = JSON.parse(body.messages.find(m=>m.role==='user').content);
    if (p.question === 'hold first') await new Promise(resolve => { releaseSlow = resolve; });
    let value;
    if(p.task.startsWith('Connectivity')) value={ok:true,message:'连接正常。'};
    else if(p.task.startsWith('Create exactly')) value={questions:[{question:'What does Earth follow?',type:'choice',options:['An orbit','A road','A river','A train'],answer:'An orbit',explanation:'Read the first sentence.',evidence:'Earth follows an orbit.'}]};
    else if(p.task.startsWith('Grade')) value={results:p.questions.map(q=>({questionId:q.id,score:0,feedback:'Check the first sentence.',referenceAnswer:q.answer,evidence:q.evidence}))};
    else if(p.task.startsWith('Explain the selected')) value=word;
    else value={answer:'API answer: '+p.question,vocabulary:[],evidence:'Earth follows an orbit.'};
    send({choices:[{message:{content:JSON.stringify(value)},finish_reason:'stop'}]});
  });
  upstream.listen(0,'127.0.0.1'); await once(upstream,'listening');
  const endpoint = `http://127.0.0.1:${upstream.address().port}/v1`;
  const probe=http.createServer(); probe.listen(0,'127.0.0.1'); await once(probe,'listening');
  const port=probe.address().port; await new Promise(r=>probe.close(r));
  const base=`http://127.0.0.1:${port}/api`;
  let child,closed,token,output='';
  async function start() {
    output='';
    child=spawn(process.execPath,['server/index.mjs'],{cwd:resolve('.'),env:{...process.env,PORT:String(port),STUDY_DATA_DIR:data,CODEX_BINARY:binary,STUDY_OPEN:'0'},stdio:['ignore','pipe','pipe']});
    closed=once(child,'close');
    child.stdout.on('data',c=>{output+=c;});child.stderr.on('data',c=>{output+=c;});
    // The full suite starts several fixture servers and CLI processes together.
    const readyDeadline = Date.now() + 6000;
    while (!output.includes('Between ·') && child.exitCode === null && Date.now() < readyDeadline) await new Promise(r => setTimeout(r, 20));
    assert.ok(output.includes('Between ·'),output);
    token=(await request('/bootstrap')).token;
  }
  async function request(path,body,expected=200) {
    const response=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Study-Token':token},body:JSON.stringify(body)});
    const raw=await response.text(); assert.ok(!raw.includes(key),'Secrets must not be returned');
    const value=JSON.parse(raw);assert.equal(response.status,expected,JSON.stringify(value));return value;
  }
  async function finish(id) {
    for(let i=0;i<250;i++){const value=await request('/jobs/'+id);if(value.status==='completed')return value.result;if(value.status==='failed')assert.fail(value.error);await new Promise(r=>setTimeout(r,10));}
    assert.fail('Job timed out');
  }
  async function job(type,params){return finish((await request('/jobs',{type,params},202)).id);}
  const prefs={model:'',tutorModel:'',defaultLevel:'B1',tutorProvider:'api'};
  try {
    await start();
    assert.equal((await request('/state')).settings.tutorProvider,'codex');
    const blocked=await fetch(base+'/provider/models',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(blocked.status,403);
    const foreign=await fetch(base+'/provider/models',{method:'POST',headers:{'Content-Type':'application/json','X-Study-Token':token,Origin:'https://example.org'},body:'{}'});
    assert.equal(foreign.status,403);
    const catalog=await request('/provider/models',{baseUrl:endpoint,apiKey:key});
    assert.deepEqual(catalog.models.map(m=>m.id),['fixture/tutor','second-model']);
    assert.equal(requests.at(-1).authorization,`Bearer ${key}`);
    assert.equal((await request('/state')).settings.api.hasKey,false,'Discovery must not save a draft');
    await request('/settings',{...prefs,api:{baseUrl:endpoint,model:'fixture/tutor',apiKey:key,reasoningEffort:'high',fastMode:true}});
    assert.equal((await request('/state')).settings.api.hasKey,true);
    await request('/provider/test',{});
    assert.equal(requests.at(-1).body.reasoning_effort,'high');
    assert.equal(requests.at(-1).body.service_tier,'priority');
    assert.equal(requests.at(-1).body.messages.some(m=>m.content.includes('learningMemory')),false,'Connection test sends no memory');
    const article=await request('/articles/import',{title:'Provider fixture',text:articleText});
    await job('explain',{articleId:article.id,question:'Meaning?'});
    assert.match((await request('/articles/'+article.id)).messages.at(-1).text,/API answer/);
    assert.ok(requests.at(-1).body.messages.some(m=>m.content.includes('learningMemory')));
    await job('word',{articleId:article.id,selection:'orbit',context:'Earth follows an orbit.'});
    const quiz=await job('quiz',{articleId:article.id,count:1,questionType:'选择题'});
    const q=(await request('/articles/'+article.id)).quizzes[0].questions[0];
    assert.equal(q.answer,undefined);
    assert.equal((await job('grade',{articleId:article.id,quizId:quiz.quizId,answers:{[q.id]:'An orbit'}})).score,1);
    const count=requests.length;
    await job('words',{count:1,level:'B1',topic:'space',excludeKnown:true});
    await job('articles',{count:1,level:'B1',topic:'space',minWords:100,maxWords:800});
    assert.equal(requests.length,count,'Material search remains on Codex with verified search evidence');
    const first=await request('/jobs',{type:'explain',params:{articleId:article.id,question:'hold first'}},202);
    for(let i=0;i<100&&!releaseSlow;i++)await new Promise(r=>setTimeout(r,10));
    assert.ok(releaseSlow);
    const second=await request('/jobs',{type:'explain',params:{articleId:article.id,question:'queued on original endpoint'}},202);
    await request('/settings',{...prefs,api:{baseUrl:endpoint.replace('/v1','/different'),model:'second-model',apiKey:''}});
    releaseSlow();
    await finish(first.id);await finish(second.id);
    assert.equal(requests.at(-1).path,'/v1/chat/completions','Queued jobs retain their original destination');
    assert.equal(requests.at(-1).authorization,`Bearer ${key}`);
    assert.equal(requests.at(-1).body.reasoning_effort,'high','Queued jobs retain their effort');
    assert.equal(requests.at(-1).body.service_tier,'priority','Queued jobs retain their Fast preference');
    assert.equal((await request('/state')).settings.api.hasKey,false,'Changing the endpoint never carries the old key');
    assert.equal((await request('/state')).settings.api.reasoningEffort,'','Changing the endpoint clears omitted advanced options');
    assert.equal((await request('/state')).settings.api.fastMode,false);
    await request('/provider/models',{});assert.equal(requests.at(-1).authorization,undefined);
    await request('/settings',{...prefs,api:{baseUrl:endpoint,model:'fixture/tutor',apiKey:key}});
    await request('/settings',{...prefs,tutorProvider:'codex'});
    await job('explain',{articleId:article.id,question:'Use Codex now'});
    assert.equal((await request('/articles/'+article.id)).messages.at(-1).text,'Codex answer');
    assert.equal((await request('/state')).settings.api.hasKey,true,'Switching back to Codex retains API settings');
    assert.ok(!readFileSync(join(data,'study.sqlite')).includes(Buffer.from(key)));
    assert.ok(!readFileSync(join(data,'memroy.md'),'utf8').includes(key));
    assert.ok(!output.includes(key));
    child.kill('SIGTERM');await closed;await start();
    const restored=(await request('/state')).settings;
    assert.equal(restored.tutorProvider,'codex');assert.equal(restored.api.model,'fixture/tutor');assert.equal(restored.api.hasKey,true);
    await request('/settings',prefs);
    await request('/provider/test',{});assert.equal(requests.at(-1).authorization,`Bearer ${key}`);
    await request('/settings',{...prefs,tutorProvider:'codex',api:{baseUrl:endpoint,model:'fixture/tutor',clearKey:true}});
    assert.equal((await request('/state')).settings.api.hasKey,false);
    writeFileSync(join(data,'api-provider.enc'),'damaged-fixture');
    assert.match((await request('/bootstrap')).settings.api.warning,/Codex/);
    await request('/settings',{...prefs,tutorProvider:'codex'});
    await job('explain',{articleId:article.id,question:'Codex still works with damaged API config'});
    assert.equal((await request('/articles/'+article.id)).messages.at(-1).text,'Codex answer');
    await request('/provider/test',{},503);
    assert.equal(readFileSync(join(data,'api-provider.enc'),'utf8'),'damaged-fixture');
  } finally {
    releaseSlow?.();
    if(child?.exitCode===null){child.kill('SIGTERM');await closed;}
    upstream.closeAllConnections();await new Promise(r=>upstream.close(r));
    rmSync(directory,{recursive:true,force:true});
  }
});
