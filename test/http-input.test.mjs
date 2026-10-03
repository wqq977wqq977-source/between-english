import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, cp, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

test('HTTP JSON input preserves streamed Unicode and rejects invalid or oversized bodies', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'between-http-input-'));
  let child, closed, output = '';
  try {
    await cp(resolve('server'), join(directory, 'server'), { recursive: true });
    await symlink(resolve('node_modules'), join(directory, 'node_modules'), 'dir');
    const binary = join(directory, 'fake-codex');
    await writeFile(binary, `#!${process.execPath}\nif(process.argv.includes('--version')) console.log('codex fixture'); else if(process.argv.includes('status')) console.log('Logged in using ChatGPT'); else process.exitCode=1;\n`, { mode: 0o700 });
    const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: directory,
      env: { ...process.env, PORT: String(port), STUDY_DATA_DIR: join(directory, 'data'), STUDY_MEMORY_FILE: join(directory, 'memroy.md'), CODEX_BINARY: binary, STUDY_OPEN: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    closed = once(child, 'close');
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const deadline = Date.now() + 6000;
    while (!output.includes('Between ·') && child.exitCode === null && Date.now() < deadline) await pause(20);
    assert.ok(output.includes('Between ·'), output);
    const base = `http://127.0.0.1:${port}/api`;
    const token = (await (await fetch(base + '/bootstrap')).json()).token;
    const state = async () => (await fetch(base + '/state')).json();
    async function post(body, split = body.length) {
      return new Promise((resolveResponse, reject) => {
        const request = http.request(base + '/articles/import', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Study-Token': token, 'Content-Length': String(body.length) },
        }, response => {
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () => resolveResponse({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        });
        request.on('error', reject);
        request.setNoDelay(true);
        if (split >= body.length) request.end(body);
        else {
          request.write(body.subarray(0, split));
          setTimeout(() => request.end(body.subarray(split)), 20);
        }
      });
    }
    const text = 'Language grows through reading, questions and practice. '.repeat(3);
    await t.test('network boundaries within Chinese and emoji bytes do not corrupt stored text', async () => {
      const title = '句。间 🌱';
      const body = Buffer.from(JSON.stringify({ title, text }));
      for (const split of [body.indexOf(Buffer.from('句')) + 1, body.indexOf(Buffer.from('句')) + 2, body.indexOf(Buffer.from('🌱')) + 2]) {
        const result = await post(body, split);
        assert.equal(result.status, 200);
        assert.equal(result.value.title, title);
        const stored = await (await fetch(base + '/articles/' + result.value.id)).json();
        assert.equal(stored.title, title);
        assert.equal(stored.text, text.trim());
      }
    });
    await t.test('invalid UTF-8 is rejected without storing replacement characters', async () => {
      const before = (await state()).articles.length;
      const body = Buffer.concat([Buffer.from('{"title":"'), Buffer.from([0xc3, 0x28]), Buffer.from('","text":' + JSON.stringify(text) + '}')]);
      const result = await post(body);
      assert.equal(result.status, 400);
      assert.equal((await state()).articles.length, before);
    });
    await t.test('JSON root must be an object', async () => {
      const before = (await state()).articles.length;
      for (const input of [null, [], true, 0, 'article']) {
        assert.equal((await post(Buffer.from(JSON.stringify(input)))).status, 400);
      }
      assert.equal((await state()).articles.length, before);
    });
    await t.test('malformed JSON has a controlled error', async () => {
      assert.equal((await post(Buffer.from('{"title":'))).status, 400);
    });
    await t.test('the byte limit accepts the boundary and returns 413 above it', async () => {
      const baseBody = { text, padding: '' };
      const paddingLength = 350000 - Buffer.byteLength(JSON.stringify(baseBody));
      const exact = Buffer.from(JSON.stringify({ ...baseBody, padding: 'x'.repeat(paddingLength) }));
      assert.equal(exact.length, 350000);
      assert.equal((await post(exact, 175000)).status, 200);
      const before = (await state()).articles.length;
      const oversized = Buffer.from(JSON.stringify({ ...baseBody, padding: 'x'.repeat(paddingLength + 1) }));
      assert.equal((await post(oversized, 175000)).status, 413);
      assert.equal((await state()).articles.length, before);
    });
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    if (closed) await closed;
    await rm(directory, { recursive: true, force: true });
  }
});
