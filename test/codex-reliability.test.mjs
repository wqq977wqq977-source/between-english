import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runCodex } from '../server/codex.mjs';

const schema = {
  type: 'object', properties: { ok: { type: 'boolean' } },
  required: ['ok'], additionalProperties: false
};

// Captured with the installed CLI against a local reconnect fixture. The CLI
// can emit this intermediate error and subsequently finish the same turn.
const reconnect = `emit({type:'error',message:'Reconnecting... 1/1 (stream disconnected before completion: stream closed before response.completed)'});`;

async function fixture(script, run) {
  const root = await mkdtemp(join(tmpdir(), 'between-codex-reliability-'));
  const executable = join(root, 'fake-codex');
  const pidPath = join(root, 'child.pid');
  const workRoot = join(root, 'runs');
  await writeFile(executable, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
const search = () => emit({type:'item.completed',item:{type:'web_search',action:{type:'search',query:'English learning'},results:[{url:'https://example.org/learning',title:'Learning'}]}});
const complete = () => {
  emit({type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}});
  emit({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}});
};
process.stdin.resume();
process.stdin.on('end', () => { ${script} });
`, { mode: 0o700 });
  try {
    await run({
      request: { id: 'request', prompt: { task: 'fixture' }, schema, search: true, workRoot, binaryPath: executable },
      pidPath, workRoot
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function assertStopped(pidPath, workRoot) {
  const pid = Number(await readFile(pidPath, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the timed-out/cancelled child must exit');
  assert.deepEqual(await readdir(workRoot), [], 'private request files must be cleaned up');
}

test('ongoing Codex search progress refreshes the idle timeout until a valid result arrives', async t => {
  await fixture(`
    emit({type:'turn.started'});
    search();
    const heartbeat = setInterval(search, 150);
    setTimeout(() => { clearInterval(heartbeat); complete(); }, 3000);
  `, async ({ request, pidPath, workRoot }) => {
    const progress = [];
    const started = performance.now();
    const result = await runCodex({ ...request, timeoutMs: 1500, maxDurationMs: 7000, onProgress: message => progress.push(message) }).catch(error => {
      t.diagnostic(`Received ${progress.length} real protocol progress updates before failure at ${Math.round(performance.now() - started)} ms.`);
      throw error;
    });
    assert.deepEqual(result.value, { ok: true });
    assert.ok(result.evidence.length >= 6, 'the result must retain actual search evidence');
    assert.ok(progress.length >= 6, 'the child emitted progress throughout the old timeout window');
    assert.ok(performance.now() - started > 1500, 'the request must finish beyond its original absolute timeout');
    await assertStopped(pidPath, workRoot);
  });
});

test('a Codex child that stops producing protocol progress still times out', async () => {
  await fixture(`emit({type:'turn.started'}); setInterval(() => {}, 1000);`, async ({ request, pidPath, workRoot }) => {
    await assert.rejects(runCodex({ ...request, timeoutMs: 1500, maxDurationMs: 6000 }), { status: 504 });
    await assertStopped(pidPath, workRoot);
  });
});

test('continuous Codex progress cannot extend a request past its total duration limit', async () => {
  await fixture(`emit({type:'turn.started'}); search(); setInterval(search, 80);`, async ({ request, pidPath, workRoot }) => {
    const controller = new AbortController();
    const fallback = setTimeout(() => controller.abort(), 6500);
    const started = performance.now();
    try {
      await assert.rejects(runCodex({ ...request, timeoutMs: 1500, maxDurationMs: 3100, signal: controller.signal }), { status: 504 });
      const elapsed = performance.now() - started;
      assert.ok(elapsed >= 3000, `active progress should last until the total limit, elapsed=${Math.round(elapsed)}ms`);
      assert.ok(elapsed < 5500, `the total limit must terminate the active child, elapsed=${Math.round(elapsed)}ms`);
      await assertStopped(pidPath, workRoot);
    } finally { clearTimeout(fallback); }
  });
});

test('explicit cancellation still terminates an active Codex search promptly', async () => {
  await fixture(`emit({type:'turn.started'}); search(); setInterval(search, 80);`, async ({ request, pidPath, workRoot }) => {
    const controller = new AbortController();
    let cancellation;
    const started = performance.now();
    try {
      await assert.rejects(runCodex({
        ...request, timeoutMs: 1500, maxDurationMs: 6000, signal: controller.signal,
        onProgress: () => { cancellation ||= setTimeout(() => controller.abort(), 250); }
      }), { status: 409 });
      assert.ok(performance.now() - started < 3000, 'cancellation should not wait for the total duration limit');
      await assertStopped(pidPath, workRoot);
    } finally { clearTimeout(cancellation); }
  });
});

test('a transient reconnect followed by terminal completion retains the validated Codex result', async () => {
  await fixture(`emit({type:'turn.started'}); search(); ${reconnect} process.stderr.write('fixture-private-api-key'); complete();`, async ({ request, pidPath, workRoot }) => {
    const diagnostics = [];
    const result = await runCodex({
      ...request, prompt: { task: 'fixture-private-prompt-text' }, timeoutMs: 4000, maxDurationMs: 8000,
      onDiagnostics: record => diagnostics.push(record)
    });
    assert.deepEqual(result.value, { ok: true });
    assert.equal(result.evidence.length, 1);
    assert.ok(diagnostics.length > 0, 'request diagnostics must be available after completion');
    const latest = diagnostics.at(-1);
    assert.equal(typeof latest.outcome, 'string');
    assert.equal(latest.searches, 1);
    assert.equal(latest.reconnections, 1);
    assert.doesNotMatch(JSON.stringify(diagnostics), /fixture-private-api-key|fixture-private-prompt-text/);
    await assertStopped(pidPath, workRoot);
  });
});

test('reconnect recovery requires terminal completion, valid content, and a successful exit', async t => {
  const cases = [
    ['missing terminal completion', `emit({type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}});`],
    ['invalid result shape', `emit({type:'item.completed',item:{type:'agent_message',text:'{"ok":"wrong type"}'}}); emit({type:'turn.completed'});`],
    ['terminal failure', `complete(); emit({type:'turn.failed',error:{message:'stream disconnected permanently'}});`],
    ['nonzero process exit', `complete(); process.exitCode = 1;`]
  ];
  for (const [name, ending] of cases) {
    await t.test(name, async () => {
      await fixture(`emit({type:'turn.started'}); search(); ${reconnect} ${ending}`, async ({ request, pidPath, workRoot }) => {
        await assert.rejects(runCodex({ ...request, timeoutMs: 4000, maxDurationMs: 8000 }), { status: 502 });
        await assertStopped(pidPath, workRoot);
      });
    });
  }
});

test('a newer Codex error requires another completion event before recovery', async () => {
  await fixture(`emit({type:'turn.started'}); search(); complete(); ${reconnect}`, async ({ request, pidPath, workRoot }) => {
    await assert.rejects(runCodex({ ...request, timeoutMs: 4000, maxDurationMs: 8000 }), { status: 502 });
    await assertStopped(pidPath, workRoot);
  });
  await fixture(`emit({type:'turn.started'}); search(); complete(); ${reconnect} complete();`, async ({ request, pidPath, workRoot }) => {
    assert.deepEqual((await runCodex({ ...request, timeoutMs: 4000, maxDurationMs: 8000 })).value, { ok: true });
    await assertStopped(pidPath, workRoot);
  });
});

test('malformed Codex event fields reject safely with an invalid_event diagnostic', async t => {
  const cases = [
    ['non-array search results', { type: 'item.completed', item: { type: 'web_search', action: { type: 'search' }, results: 'fixture-private-result' } }],
    ['non-array search queries', { type: 'item.completed', item: { type: 'web_search', action: { type: 'search', queries: {} } } }],
    ['null search result entry', { type: 'item.completed', item: { type: 'web_search', action: { type: 'search' }, results: [null] } }],
    ['non-string agent message', { type: 'item.completed', item: { type: 'agent_message', text: { private: 'fixture-private-result' } } }]
  ];
  for (const [name, event] of cases) {
    await t.test(name, async () => {
      await fixture(`emit({type:'turn.started'}); emit(${JSON.stringify(event)}); setTimeout(complete,1000);`, async ({ request, pidPath, workRoot }) => {
        const diagnostics = [];
        await assert.rejects(runCodex({ ...request, timeoutMs: 4000, maxDurationMs: 8000, onDiagnostics: value => diagnostics.push(value) }), error => {
          assert.equal(error.status, 502);
          assert.equal(error.diagnostics.code, 'invalid_event');
          return true;
        });
        assert.equal(diagnostics.length, 1);
        assert.equal(diagnostics[0].code, 'invalid_event');
        assert.equal(diagnostics[0].outcome, 'failed');
        assert.doesNotMatch(JSON.stringify(diagnostics), /fixture-private-result/);
        await assertStopped(pidPath, workRoot);
      });
    });
  }
});

test('search events with missing or null optional fields remain compatible', async t => {
  for (const [name, item, expectedQuery] of [
    ['missing results', { type: 'web_search', action: { type: 'search', queries: ['English reading'] } }, 'English reading'],
    ['nullable fields', { type: 'web_search', query: null, action: { type: 'search', query: null, queries: null }, results: null }, '']
  ]) {
    await t.test(name, async () => {
      await fixture(`emit({type:'turn.started'}); emit({type:'item.completed',item:${JSON.stringify(item)}}); complete();`, async ({ request, pidPath, workRoot }) => {
        const result = await runCodex({ ...request, timeoutMs: 4000, maxDurationMs: 8000 });
        assert.deepEqual(result.value, { ok: true });
        assert.equal(result.evidence[0].query, expectedQuery);
        assert.deepEqual(result.evidence[0].sources, []);
        await assertStopped(pidPath, workRoot);
      });
    });
  }
});
