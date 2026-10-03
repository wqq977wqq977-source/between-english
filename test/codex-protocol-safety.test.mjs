import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEvent } from '../server/codex.mjs';

test('Codex error events validate message types before diagnostics inspect them', () => {
  for (const type of ['error', 'turn.failed']) {
    for (const message of [1, true, [], {}, { toString: null, valueOf: null }]) {
      for (const fields of [{ message }, { error: { message } }]) {
        assert.throws(() => parseEvent({ type, ...fields }, []), { status: 502 });
      }
    }
    for (const fields of [{}, { message: null }, { error: null }, { error: {} }, { message: 'Reconnecting...' }, { error: { message: 'Connection failed' } }]) {
      assert.equal(parseEvent({ type, ...fields }, []), null);
    }
  }
});

for (const type of ['error', 'turn.failed']) {
  test(`malformed ${type} data rejects only its request without terminating the application process`, { timeout: 10000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'between-protocol-safety-'));
    try {
      const executable = join(directory, 'fake-codex');
      const event = { type, error: { message: { toString: null, valueOf: null, private: 'fixture-private-error' } } };
      await writeFile(executable, `#!${process.execPath}
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(event)}) + '\\n');
});
`, { mode: 0o700 });
      const runner = join(directory, 'runner.mjs');
      const workRoot = join(directory, 'runs');
      await writeFile(runner, `import { runCodex } from ${JSON.stringify(new URL('../server/codex.mjs', import.meta.url).href)};
try {
  await runCodex({ id: 'request', prompt: {}, schema: { type: 'object', properties: {}, required: [] }, workRoot: ${JSON.stringify(workRoot)}, binaryPath: ${JSON.stringify(executable)}, timeoutMs: 2000, maxDurationMs: 4000 });
  process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ status: error.status, message: error.message, code: error.diagnostics?.code }));
}
`);
      const child = spawn(process.execPath, [runner], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      }).finally(() => clearTimeout(timer));
      assert.equal(code, 0, stderr);
      const failure = JSON.parse(stdout);
      assert.equal(failure.status, 502);
      assert.equal(failure.code, 'invalid_event');
      assert.doesNotMatch(stdout + stderr, /fixture-private-error|TypeError/);
      assert.deepEqual(await readdir(workRoot), []);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
