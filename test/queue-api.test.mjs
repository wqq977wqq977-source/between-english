import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, cp, symlink, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';

test('cancelling queued tasks releases capacity immediately and never executes cancelled requests', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'between-queue-http-'));
  const requests = [];
  let releaseFirst, child, closed, token, output = '';
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const prompt = JSON.parse(body.messages.find(message => message.role === 'user').content);
    requests.push(prompt.question);
    if (prompt.question === 'hold') await gate;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: prompt.question, vocabulary: [], evidence: '' }) }, finish_reason: 'stop' }] }));
  });
  try {
    // Copy only application files: all runtime and request files stay in this fixture.
    for (const name of ['server', 'public']) await cp(resolve(name), join(directory, name), { recursive: true });
    await symlink(resolve('node_modules'), join(directory, 'node_modules'), 'dir');
    const binary = join(directory, 'fake-codex');
    await writeFile(binary, `#!${process.execPath}\nif(process.argv.includes('--version')) console.log('codex fixture'); else if(process.argv.includes('status')) console.log('Logged in using ChatGPT'); else process.exitCode=1;\n`, { mode: 0o700 });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const base = `http://127.0.0.1:${port}/api`;
    async function api(path, body, expected = 200) {
      const response = await fetch(base + path, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Study-Token': token }, body: JSON.stringify(body),
      });
      const value = await response.json();
      assert.equal(response.status, expected, JSON.stringify(value));
      return value;
    }
    async function until(read, accept, description) {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const value = await read();
        if (accept(value)) return value;
        await pause(20);
      }
      assert.fail(description);
    }
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: directory,
      env: { ...process.env, PORT: String(port), STUDY_DATA_DIR: join(directory, 'data'), STUDY_MEMORY_FILE: join(directory, 'memroy.md'), CODEX_BINARY: binary, STUDY_OPEN: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    closed = once(child, 'close');
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    await until(() => output, value => value.includes('Between ·'), 'The fixture server must start');
    token = (await api('/bootstrap')).token;
    await api('/settings', { tutorProvider: 'api', api: { baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'fixture-tutor', apiKey: '' } });
    const article = await api('/articles/import', { title: 'Queue fixture', text: 'Earth follows an orbit. An orbit is a curved path around another object. People can study this path to learn how objects move in space.' });
    const submit = (question, expected = 202) => api('/jobs', { type: 'explain', params: { articleId: article.id, question } }, expected);
    const cancel = id => api(`/jobs/${id}/cancel`, {});
    const finish = id => until(() => api(`/jobs/${id}`), job => ['completed', 'failed'].includes(job.status), 'The accepted job must leave the queue');
    const running = await submit('hold');
    await until(() => requests, entries => entries.includes('hold'), 'The first task must be running');
    const queued = [];
    for (let index = 0; index < 4; index++) queued.push(await submit(`cancel-${index}`));
    await submit('overflow', 429);

    assert.equal((await cancel(queued[1].id)).status, 'cancelled');
    const replacement = await submit('cancel-replacement');
    assert.equal(replacement.status, 'queued', 'A freed slot must be usable while the first request is still running');
    assert.equal((await api(`/jobs/${running.id}`)).status, 'running');
    // Repeating cancellation must not free an unrelated task or bypass the cap.
    await cancel(queued[1].id);
    await submit('still-full', 429);
    for (const job of [queued[0], queued[2], queued[3], replacement]) await cancel(job.id);
    const first = await submit('fresh-a'), second = await submit('fresh-b');
    assert.deepEqual(requests, ['hold'], 'Queued and cancelled requests must not reach the provider');
    releaseFirst();
    for (const job of [running, first, second]) assert.equal((await finish(job.id)).status, 'completed');
    assert.deepEqual(requests, ['hold', 'fresh-a', 'fresh-b'], 'Surviving jobs retain FIFO order');
    for (const job of [...queued, replacement]) assert.equal((await api(`/jobs/${job.id}`)).status, 'cancelled');
  } finally {
    releaseFirst();
    if (child?.exitCode === null) { child.kill('SIGTERM'); await closed; }
    upstream.closeAllConnections();
    if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
