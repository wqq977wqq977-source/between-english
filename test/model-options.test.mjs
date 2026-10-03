import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCodexOptions } from '../server/model-options.mjs';
import { runCodex } from '../server/codex.mjs';

const catalog = { models: [
  { id: 'default-model', isDefault: true, reasoningEfforts: ['low', 'medium', 'ultra'], supportsFast: true },
  { id: 'standard-model', reasoningEfforts: ['none'], supportsFast: false },
  { id: 'unknown-model', reasoningEfforts: [], supportsFast: null }
] };

test('model option validation accepts legacy defaults and only advertised advanced options', () => {
  assert.deepEqual(validateCodexOptions({}, undefined), { reasoningEffort: '', fastMode: false });
  assert.deepEqual(validateCodexOptions({ model: 'manual-model' }, catalog), { reasoningEffort: '', fastMode: false });
  assert.deepEqual(validateCodexOptions({ reasoningEffort: 'ultra', fastMode: true }, catalog), { reasoningEffort: 'ultra', fastMode: true });
  assert.deepEqual(validateCodexOptions({ model: 'standard-model', reasoningEffort: 'none' }, catalog.models), { reasoningEffort: 'none', fastMode: false });
  for (const options of [
    { model: 'missing', reasoningEffort: 'high' },
    { model: 'default-model', reasoningEffort: 'high' },
    { model: 'standard-model', fastMode: true },
    { model: 'unknown-model', fastMode: true },
    { reasoningEffort: 'high"\nservice_tier="fast' },
    { reasoningEffort: null },
    { fastMode: 'false' }
  ]) assert.throws(() => validateCodexOptions(options, catalog), { status: 400 });
  assert.throws(() => validateCodexOptions({ reasoningEffort: 'low' }, { models: [] }), { status: 400 });
});

test('Codex invocation forwards effort and Fast independently and explicitly resets standard mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'between-codex-options-'));
  const executable = join(root, 'fake-codex'), trace = join(root, 'calls.jsonl'), workRoot = join(root, 'runs');
  await writeFile(executable, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(trace)},JSON.stringify(process.argv.slice(2))+'\\n');
process.stdin.resume();
process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}})+'\\n'));
`, { mode: 0o700 });
  const request = { prompt: { task: 'fixture' }, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, model: 'default-model', workRoot, binaryPath: executable };
  try {
    assert.deepEqual((await runCodex({ ...request, id: 'fast', reasoningEffort: 'ultra', fastMode: true })).value, { ok: true });
    await runCodex({ ...request, id: 'standard', reasoningEffort: 'low', fastMode: false });
    await runCodex({ ...request, id: 'legacy' });
    const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
    const configs = calls.map(args => args.flatMap((arg, index) => arg === '-c' ? [args[index + 1]] : []));
    assert.ok(configs[0].includes('model_reasoning_effort="ultra"'));
    assert.ok(configs[0].includes('service_tier="fast"'));
    assert.ok(configs[0].includes('features.fast_mode=true'));
    assert.ok(configs[1].includes('model_reasoning_effort="low"'));
    assert.ok(configs[1].includes('service_tier="default"'));
    assert.ok(configs[2].includes('service_tier="default"'));
    assert.ok(!configs[2].some(value => value.startsWith('model_reasoning_effort=')));
    assert.ok(calls.every(args => args.includes('--ignore-user-config')));
    assert.ok(calls.every(args => args[args.indexOf('-m') + 1] === 'default-model'));
    await assert.rejects(runCodex({ ...request, id: 'invalid', fastMode: 'false' }), { status: 400 });
    assert.deepEqual(await readdir(workRoot), []);
    assert.equal((await readFile(trace, 'utf8')).trim().split('\n').length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
