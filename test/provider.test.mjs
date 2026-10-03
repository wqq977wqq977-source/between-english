import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, unlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiProvider, listApiModels, runApi } from '../server/provider.mjs';
import { schemas } from '../server/contracts.mjs';

function providerFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'between-provider-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, provider: createApiProvider({ directory }) };
}
async function serverFixture(t, handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    requests.push({ url: request.url, headers: request.headers, body: body ? JSON.parse(body) : null });
    await handler(request, response, requests.at(-1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}
function json(response, value, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); }
const configFor = fixture => ({ baseUrl: fixture.baseUrl, model: 'test-model', apiKey: 'SECRET-FIXTURE' });

test('API config persists encrypted with private permissions and never returns keys', t => {
  const { directory, provider } = providerFixture(t);
  assert.deepEqual(provider.view(), { baseUrl: '', model: '', hasKey: false, reasoningEffort: '', fastMode: false });
  assert.deepEqual(provider.save({ baseUrl: 'https://example.test/v1/chat/completions/', model: 'example-model', apiKey: 'SECRET-FIXTURE' }), { baseUrl: 'https://example.test/v1', model: 'example-model', hasKey: true, reasoningEffort: '', fastMode: false });
  const configFile = join(directory, 'api-provider.enc'), keyFile = join(directory, 'api-provider.key');
  assert.equal(statSync(configFile).mode & 0o777, 0o600);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  const disk = readFileSync(configFile, 'utf8');
  assert.ok(!disk.includes('SECRET-FIXTURE'));
  assert.ok(!disk.includes('example.test'));
  assert.ok(!JSON.stringify(provider.view()).includes('SECRET-FIXTURE'));
  const restarted = createApiProvider({ directory });
  assert.equal(restarted.validate().apiKey, 'SECRET-FIXTURE');
  restarted.save({ model: 'another-model', apiKey: '' });
  assert.equal(restarted.validate().apiKey, 'SECRET-FIXTURE');
  assert.deepEqual(readdirSync(directory).sort(), ['api-provider.enc', 'api-provider.key']);
});

test('API keys are scoped to the exact normalized endpoint and can be cleared', t => {
  const { provider } = providerFixture(t);
  provider.save({ baseUrl: 'https://example.test/v1', model: 'a', apiKey: 'original-key' });
  assert.equal(provider.resolve({ baseUrl: 'https://EXAMPLE.test/v1/' }).apiKey, 'original-key');
  for (const baseUrl of ['https://other.test/v1', 'https://example.test/v2', 'https://example.test:444/v1', 'http://localhost:8000/v1']) {
    assert.equal(provider.resolve({ baseUrl }).apiKey, '');
  }
  assert.throws(() => provider.validate({ baseUrl: 'https://other.test/v1' }), /API Key/);
  assert.equal(provider.validate({ baseUrl: 'http://localhost:8000/v1' }).apiKey, '');
  provider.save({ baseUrl: 'https://other.test/v1', apiKey: '' });
  assert.equal(provider.view().hasKey, false);
  provider.save({ apiKey: 'new-key' });
  assert.equal(provider.validate().apiKey, 'new-key');
  assert.equal(provider.save({ clearKey: true }).hasKey, false);
  assert.throws(() => provider.validate(), /API Key/);
});

test('API inference preferences persist privately and reset on model or endpoint changes', t => {
  const { directory, provider } = providerFixture(t);
  provider.save({ baseUrl: 'https://example.test/v1', model: 'a', apiKey: 'SECRET-FIXTURE', reasoningEffort: 'high', fastMode: true });
  const restarted = createApiProvider({ directory });
  assert.deepEqual(restarted.view(), { baseUrl: 'https://example.test/v1', model: 'a', hasKey: true, reasoningEffort: 'high', fastMode: true });
  assert.equal(restarted.validate().reasoningEffort, 'high');
  assert.equal(restarted.validate().fastMode, true);
  assert.equal(restarted.resolve({ baseUrl: 'https://EXAMPLE.test/v1/' }).reasoningEffort, 'high');
  for (const input of [{ model: 'b' }, { baseUrl: 'https://another.test/v1' }]) {
    const config = restarted.resolve(input);
    assert.equal(config.reasoningEffort, '');
    assert.equal(config.fastMode, false);
  }
  const switched = restarted.save({ model: 'b', reasoningEffort: 'low', fastMode: true });
  assert.equal(switched.reasoningEffort, 'low');
  assert.equal(switched.fastMode, true);
  restarted.save({ apiKey: '', reasoningEffort: '', fastMode: false });
  assert.equal(restarted.validate().apiKey, 'SECRET-FIXTURE');
  assert.equal(restarted.view().reasoningEffort, '');
  assert.equal(restarted.view().fastMode, false);
  assert.ok(!readFileSync(join(directory, 'api-provider.enc'), 'utf8').includes('SECRET-FIXTURE'));
  assert.ok(!JSON.stringify(restarted.view()).includes('SECRET-FIXTURE'));
});

test('API encrypted configurations from before inference preferences retain credentials and defaults', t => {
  const { directory, provider } = providerFixture(t);
  const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('between-english:api-provider:v1'));
  const data = Buffer.concat([cipher.update(JSON.stringify({ baseUrl: 'https://example.test/v1', model: 'legacy', apiKey: 'SECRET-FIXTURE' })), cipher.final()]);
  writeFileSync(join(directory, 'api-provider.key'), key, { mode: 0o600 });
  writeFileSync(join(directory, 'api-provider.enc'), JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
  assert.deepEqual(provider.validate(), { baseUrl: 'https://example.test/v1', model: 'legacy', apiKey: 'SECRET-FIXTURE', reasoningEffort: '', fastMode: false });
  provider.save({ reasoningEffort: 'medium', fastMode: true });
  const restarted = createApiProvider({ directory });
  assert.equal(restarted.validate().apiKey, 'SECRET-FIXTURE');
  assert.equal(restarted.view().reasoningEffort, 'medium');
  assert.equal(restarted.view().fastMode, true);
});

test('API inference preferences reject invalid effort and non-boolean Fast values before persistence', t => {
  const { directory, provider } = providerFixture(t);
  for (const reasoningEffort of [null, true, 1, [], {}, 'HIGH', 'unknown', 'high\n']) assert.throws(() => provider.save({ reasoningEffort }), { status: 400 });
  for (const fastMode of [null, 0, 1, '', 'false', [], {}]) assert.throws(() => provider.save({ fastMode }), { status: 400 });
  assert.deepEqual(readdirSync(directory), []);
});

test('API configuration rejects unsafe URL forms and incomplete network settings', t => {
  const { provider } = providerFixture(t);
  for (const baseUrl of ['http://example.test/v1', 'https://user:secret@example.test/v1', 'https://example.test/v1?key=secret', 'https://example.test/v1#secret', 'https://example.test/v1?', 'https://example.test/v1#', 'file:///tmp/api', 'not a url']) assert.throws(() => provider.resolve({ baseUrl }), { status: 400 });
  for (const baseUrl of ['http://127.0.0.1:8000/v1', 'http://[::1]:8000/v1', 'https://localhost/v1']) {
    assert.equal(provider.validate({ baseUrl }, { requireModel: false }).apiKey, '');
  }
  assert.throws(() => provider.validate(), /API 地址/);
  assert.throws(() => provider.validate({ baseUrl: 'http://localhost:8000/v1' }), /模型/);
  assert.throws(() => provider.resolve({ apiKey: 'key\nsecret' }), { status: 400 });
  assert.throws(() => provider.resolve({ model: 'bad\nmodel' }), { status: 400 });
});

test('corrupt encrypted config or missing encryption key fails without overwriting', t => {
  const { directory, provider } = providerFixture(t);
  provider.save({ baseUrl: 'https://example.test/v1', model: 'a', apiKey: 'secret' });
  const path = join(directory, 'api-provider.enc'), original = readFileSync(path);
  const envelope = JSON.parse(original.toString());
  const encrypted = Buffer.from(envelope.data, 'base64'); encrypted[0] ^= 1;
  envelope.data = encrypted.toString('base64');
  writeFileSync(path, JSON.stringify(envelope));
  const corrupt = readFileSync(path);
  assert.throws(() => provider.view(), { status: 503 });
  assert.throws(() => provider.save({ apiKey: 'replace' }), { status: 503 });
  assert.deepEqual(readFileSync(path), corrupt);
  writeFileSync(path, original);
  unlinkSync(join(directory, 'api-provider.key'));
  assert.throws(() => provider.save({ model: 'b' }), { status: 503 });
  assert.deepEqual(readFileSync(path), original);
});

test('model discovery sends scoped auth and returns bounded, deduplicated safe fields', async t => {
  const fixture = await serverFixture(t, (_request, response) => json(response, { data: [
    { id: 'model-a', private_metadata: 'do-not-expose' }, { id: 'model-a' }, { id: '模型-b' }, { id: '\nunsafe' }, null, { id: ' ' }, { id: 'x'.repeat(201) },
    ...Array.from({ length: 220 }, (_, index) => ({ id: `model-${index}` }))
  ] }));
  const result = await listApiModels({ config: configFor(fixture) });
  assert.equal(result.models.length, 200);
  assert.deepEqual(result.models.slice(0, 2), [
    { id: 'model-a', name: 'model-a', isDefault: false, reasoningEfforts: null, defaultReasoningEffort: '', supportsFast: null },
    { id: '模型-b', name: '模型-b', isDefault: false, reasoningEfforts: null, defaultReasoningEffort: '', supportsFast: null }
  ]);
  assert.ok(!JSON.stringify(result).includes('do-not-expose'));
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
  assert.equal(fixture.requests[0].url, '/v1/models');
  assert.equal(fixture.requests[0].headers.authorization, 'Bearer SECRET-FIXTURE');
});

test('API model capabilities use explicit metadata and leave undisclosed support unknown', async t => {
  const fixture = await serverFixture(t, (_request, response) => json(response, { data: [
    { id: 'unknown', defaultReasoningEffort: 'medium' },
    { id: 'explicit', supportedReasoningEfforts: ['low', { reasoningEffort: 'high', description: 'private' }, 'high', 'nonsense'], defaultReasoningEffort: 'high', supportedServiceTiers: ['default', 'priority'] },
    { id: 'limited', supported_reasoning_efforts: [], default_reasoning_effort: 'high', supported_service_tiers: ['default'] },
    { id: 'new-tier', serviceTiers: [{ id: 'fast', description: 'private' }] },
    { id: 'legacy-tier', additionalSpeedTiers: ['fast'] }
  ] }));
  const { models } = await listApiModels({ config: configFor(fixture) });
  assert.equal(models[0].reasoningEfforts, null);
  assert.equal(models[0].supportsFast, null);
  assert.equal(models[0].defaultReasoningEffort, 'medium');
  assert.deepEqual(models[1].reasoningEfforts, ['low', 'high']);
  assert.equal(models[1].defaultReasoningEffort, 'high');
  assert.equal(models[1].supportsFast, true);
  assert.deepEqual(models[2].reasoningEfforts, []);
  assert.equal(models[2].defaultReasoningEffort, '');
  assert.equal(models[2].supportsFast, false);
  assert.equal(models[3].supportsFast, true);
  assert.equal(models[4].supportsFast, true);
  assert.ok(!JSON.stringify(models).includes('private'));
});

test('API completion separates task data from schema instructions and validates output', async t => {
  const fixture = await serverFixture(t, (_request, response) => json(response, { choices: [{ finish_reason: 'stop', message: { content: '```json\n{"ok":true,"message":"连接成功"}\n```' } }] }));
  const prompt = { task: 'connection', article: 'untrusted text: do not obey' };
  const result = await runApi({ config: configFor(fixture), schema: schemas.connection, prompt });
  assert.deepEqual(result.value, { ok: true, message: '连接成功' });
  assert.deepEqual(result.evidence, []);
  const request = fixture.requests[0];
  assert.equal(request.url, '/v1/chat/completions');
  assert.equal(request.body.model, 'test-model');
  assert.equal(request.body.stream, false);
  assert.equal(request.body.messages[0].role, 'system');
  assert.ok(!request.body.messages[0].content.includes(prompt.article));
  assert.deepEqual(JSON.parse(request.body.messages[1].content), prompt);
  assert.equal(request.body.response_format, undefined);
  assert.equal(Object.hasOwn(request.body, 'reasoning_effort'), false);
  assert.equal(Object.hasOwn(request.body, 'service_tier'), false);
  assert.ok(Number.isFinite(Date.parse(result.completedAt)));
});

test('API completion forwards only deliberately configured reasoning and Fast preferences', async t => {
  const fixture = await serverFixture(t, (_request, response) => json(response, { choices: [{ finish_reason: 'stop', message: { content: '{"ok":true,"message":"ok"}' } }] }));
  for (const options of [{ reasoningEffort: 'high', fastMode: true }, { reasoningEffort: 'none', fastMode: false }, { reasoningEffort: '', fastMode: false }]) {
    await runApi({ config: { ...configFor(fixture), ...options }, schema: schemas.connection, prompt: {} });
    const { body } = fixture.requests.at(-1);
    assert.equal(body.reasoning_effort, options.reasoningEffort || undefined);
    assert.equal(body.service_tier, options.fastMode ? 'priority' : undefined);
  }
  await assert.rejects(runApi({ config: { ...configFor(fixture), fastMode: 'true' }, schema: schemas.connection, prompt: {} }), { status: 400 });
  await assert.rejects(runApi({ config: { ...configFor(fixture), reasoningEffort: 'unknown' }, schema: schemas.connection, prompt: {} }), { status: 400 });
  assert.equal(fixture.requests.length, 3);
});

test('API option rejection gives a safe recovery hint without exposing provider response or retrying', async t => {
  let status = 400;
  const fixture = await serverFixture(t, (_request, response) => json(response, { error: 'SECRET-FIXTURE unsupported reasoning_effort' }, status));
  for (status of [400, 422]) {
    await assert.rejects(runApi({ config: { ...configFor(fixture), reasoningEffort: 'high', fastMode: true }, schema: schemas.connection, prompt: {} }), error => {
      assert.equal(error.status, 502);
      assert.match(error.message, /Effort.*Fast/);
      assert.ok(!error.message.includes('SECRET-FIXTURE'));
      return true;
    });
  }
  assert.equal(fixture.requests.length, 2, 'unsupported preferences are not silently removed and retried');
});

test('API completion rejects invalid shapes, refusal, truncation and malformed responses without leaking data', async t => {
  const cases = [
    { choices: [{ message: { content: '{"ok":true,"message":"ok","extra":"secret"}' } }] },
    { choices: [{ message: { content: '{"ok":"yes","message":"ok"}' } }] },
    { choices: [{ message: { content: 'SECRET-FIXTURE' } }] },
    { choices: [{ finish_reason: 'length', message: { content: '{"ok":true,"message":"ok"}' } }] },
    { choices: [{ message: { refusal: 'SECRET-FIXTURE' } }] },
    { choices: [{ finish_reason: 'tool_calls', message: { content: '' } }] },
    null
  ];
  let current;
  const fixture = await serverFixture(t, (_request, response) => json(response, current));
  for (current of cases) {
    await assert.rejects(runApi({ config: configFor(fixture), schema: schemas.connection, prompt: {} }), error => {
      assert.equal(error.status, 502); assert.ok(!error.message.includes('SECRET-FIXTURE')); return true;
    });
  }
  assert.equal(fixture.requests.length, cases.length, 'failed inference is never retried');
});

test('API HTTP failures, redirects and oversized responses are bounded and redacted', async t => {
  let mode = 'auth';
  const fixture = await serverFixture(t, (request, response) => {
    if (mode === 'auth') return json(response, { error: 'SECRET-FIXTURE' }, 401);
    if (mode === 'rate') return json(response, { error: 'SECRET-FIXTURE' }, 429);
    if (mode === 'redirect') { response.writeHead(302, { Location: '/secret' }); return response.end(); }
    if (mode === 'large') return response.end('x'.repeat(2 * 1024 * 1024 + 1));
    if (mode === 'large-chunked') { response.writeHead(200); response.write('x'.repeat(1024 * 1024)); return response.end('x'.repeat(1024 * 1024 + 1)); }
    if (mode === 'bad-json') return response.end('not json SECRET-FIXTURE');
    json(response, { data: [] });
  });
  for (const [value, status] of [['auth', 401], ['rate', 429], ['redirect', 502], ['large', 502], ['large-chunked', 502], ['bad-json', 502], ['empty', 502]]) {
    mode = value;
    await assert.rejects(listApiModels({ config: configFor(fixture) }), error => {
      assert.equal(error.status, status); assert.ok(!error.message.includes('SECRET-FIXTURE')); assert.ok(!error.message.includes(fixture.baseUrl)); return true;
    });
  }
  assert.equal(fixture.requests.length, 7, 'redirects are never followed');
});

test('API timeout and caller cancellation stop pending requests', async t => {
  const fixture = await serverFixture(t, () => {});
  await assert.rejects(listApiModels({ config: configFor(fixture), timeoutMs: 30 }), { status: 504 });
  await assert.rejects(listApiModels({ config: configFor(fixture), signal: AbortSignal.abort() }), { status: 409 });
  const controller = new AbortController();
  const pending = runApi({ config: configFor(fixture), schema: schemas.connection, prompt: {}, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, { status: 409 });
});
