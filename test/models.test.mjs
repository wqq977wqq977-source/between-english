import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listCodexModels, normalizeModels } from '../server/models.mjs';

function fixture(mode = 'normal') {
  const root = mkdtempSync(join(tmpdir(), 'between-models-')), executable = join(root, 'fake-codex'), trace = join(root, 'requests.jsonl');
  writeFileSync(executable, `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const mode=${JSON.stringify(mode)};
function send(value){
 const buffer=Buffer.from(JSON.stringify(value)+'\\n');const split=buffer.indexOf(Buffer.from('示'));
 if(split>=0){process.stdout.write(buffer.subarray(0,split+1));setImmediate(()=>process.stdout.write(buffer.subarray(split+1)));}
 else process.stdout.write(buffer);
}
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);appendFileSync(${JSON.stringify(trace)},JSON.stringify(m)+'\\n');
 if(mode==='timeout')return;
 if(m.method==='initialize')return send({id:m.id,result:{userAgent:'fixture'}});
 if(m.method==='initialized')return;
 if(m.method==='account/read')return send({id:m.id,result:{account:mode==='signed-out'?null:{type:'chatgpt',email:'private-fixture@example.org'}}});
 if(m.method!=='model/list')return;
 if(mode==='rpc-error')return send({id:m.id,error:{code:-1,message:'SECRET-FIXTURE'}});
 if(mode==='malformed')return process.stdout.write('not json\\n');
 if(mode==='null')return process.stdout.write('null\\n');
 if(mode==='primitive')return process.stdout.write('42\\n');
 if(mode==='empty')return send({id:m.id,result:{data:[],nextCursor:null}});
 if(mode==='cycle')return send({id:m.id,result:{data:[],nextCursor:'same'}});
 if(!m.params.cursor)return send({id:m.id,result:{data:[{model:'model-a',displayName:'示例模型',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],defaultReasoningEffort:'low',serviceTiers:[{id:'priority',name:'Fast',description:'2x speed'}]},{model:'hidden',hidden:true}],nextCursor:'page-2'}});
 return send({id:m.id,result:{data:[{model:'model-b',displayName:'Second',inputModalities:['text']},{model:'model-a'},{model:'image-only',inputModalities:['image']}],nextCursor:null}});
});
`, { mode: 0o700 });
  return { root, executable, trace, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('discovery initializes authentication, follows pagination and returns only safe picker fields', async () => {
  const f = fixture();
  try {
    const result = await listCodexModels({ workRoot: join(f.root, 'runs'), binaryPath: f.executable });
    assert.deepEqual(result.models, [
      { id: 'model-a', name: '示例模型', isDefault: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low', supportsFast: true },
      { id: 'model-b', name: 'Second', isDefault: false, reasoningEfforts: [], defaultReasoningEffort: '', supportsFast: null }
    ]);
    assert.ok(!JSON.stringify(result).includes('private-fixture'));
    const requests = readFileSync(f.trace, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(requests.map(r => r.method), ['initialize', 'initialized', 'account/read', 'model/list', 'model/list']);
    assert.equal(requests[3].params.includeHidden, false);
    assert.equal(requests[4].params.cursor, 'page-2');
    assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
  } finally { f.close(); }
});

test('capabilities preserve advertised efforts and distinguish Fast support from unknown metadata', () => {
  const models = normalizeModels([
    { model: 'current', supportedReasoningEfforts: [{ reasoningEffort: 'none' }, { reasoningEffort: 'ultra' }, { reasoningEffort: 'ultra' }, null, { reasoningEffort: 'high"\nservice_tier="fast' }], defaultReasoningEffort: 'ultra', serviceTiers: [{ id: 'priority', name: 'Fast' }] },
    { model: 'old', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], defaultReasoningEffort: 'high', additionalSpeedTiers: ['fast'] },
    { model: 'standard-only', serviceTiers: [], additionalSpeedTiers: ['fast'] },
    { model: 'other-tier', serviceTiers: [{ id: 'flex' }] },
    { model: 'older-standard-only', additionalSpeedTiers: [] },
    { model: 'unknown' }
  ]);
  assert.deepEqual(models[0].reasoningEfforts, ['none', 'ultra']);
  assert.equal(models[0].defaultReasoningEffort, 'ultra');
  assert.equal(models[1].defaultReasoningEffort, '');
  assert.deepEqual(models.map(model => model.supportsFast), [true, true, false, false, false, null]);
});

test('discovery rejects signed-out accounts, broken lists, RPC failures and pagination loops', async () => {
  for (const mode of ['signed-out', 'rpc-error', 'malformed', 'null', 'primitive', 'empty', 'cycle']) {
    const f = fixture(mode);
    try {
      await assert.rejects(listCodexModels({ workRoot: join(f.root, 'runs'), binaryPath: f.executable }), error => {
        assert.ok(!error.message.includes('SECRET-FIXTURE'));
        assert.ok([401, 404, 502].includes(error.status)); return true;
      });
      if (mode === 'signed-out') assert.ok(!readFileSync(f.trace, 'utf8').includes('model/list'));
    } finally { f.close(); }
  }
});

test('discovery has bounded timeout and handles cancellation and missing CLI', async () => {
  const f = fixture('timeout');
  try {
    await assert.rejects(listCodexModels({ workRoot: join(f.root, 'runs'), binaryPath: f.executable, timeoutMs: 80 }), { status: 504 });
    await assert.rejects(listCodexModels({ workRoot: join(f.root, 'runs'), binaryPath: f.executable, signal: AbortSignal.abort() }), { status: 409 });
    const controller = new AbortController();
    const pending = listCodexModels({ workRoot: join(f.root, 'runs'), binaryPath: f.executable, signal: controller.signal });
    setTimeout(() => controller.abort(), 40);
    await assert.rejects(pending, { status: 409 });
    await assert.rejects(listCodexModels({ workRoot: join(f.root, 'runs'), binaryPath: join(f.root, 'missing') }), { status: 503 });
  } finally { f.close(); }
});
