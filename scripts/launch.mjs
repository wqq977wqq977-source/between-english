import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = 'http://127.0.0.1:4318';
const logPath = resolve(root, 'data/launcher.log');
// start.command holds the OS file lock until this helper exits.
if (process.env.STUDY_LAUNCH_LOCKED !== '1') {
  console.error('请通过 start.command 启动网站。');
  process.exit(1);
}

function probe() {
  return new Promise(resolveProbe => {
    let finished = false;
    const done = value => { if (!finished) { finished = true; resolveProbe(value); } };
    const request = http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 65536) { done('occupied'); request.destroy(); }
      });
      response.on('end', () => done(response.statusCode === 200 && /<title>句[。]?间 Between · 英语学习<\/title>/.test(body) ? 'ready' : 'occupied'));
      response.on('error', () => done('occupied'));
    });
    request.setTimeout(1500, () => { done('occupied'); request.destroy(); });
    request.on('error', error => done(error.code === 'ECONNREFUSED' ? 'offline' : 'occupied'));
  });
}

function assertAvailable(state) {
  if (state === 'occupied') throw new Error('端口 4318 正被其他程序使用，或网站暂时没有响应。请稍后重试。');
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise(accept => child.once('exit', accept));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && !child.signalCode) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function ensureRunning() {
  const initial = await probe();
  if (initial === 'ready') return;
  assertAvailable(initial);
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  const log = await open(logPath, 'a', 0o600);
  await log.chmod(0o600);
  const env = { ...process.env, PORT: '4318', STUDY_OPEN: '0' };
  // The desktop launcher always uses the user's main learning space.
  delete env.STUDY_DATA_DIR;
  delete env.STUDY_MEMORY_FILE;
  let child;
  try {
    child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
    await new Promise((accept, reject) => { child.once('spawn', accept); child.once('error', reject); });
  } finally { await log.close(); }
  child.unref();
  try {
    const readyDeadline = Date.now() + 45000;
    while (Date.now() < readyDeadline) {
      const status = await probe();
      if (status === 'ready') return;
      assertAvailable(status);
      if (child.exitCode !== null || child.signalCode) throw new Error(`网站启动失败。详情见 ${logPath}`);
      await delay(300);
    }
    throw new Error(`启动超时，请重新打开。详情见 ${logPath}`);
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

try {
  await ensureRunning();
  if (!process.argv.includes('--no-open')) {
    await new Promise((accept, reject) => execFile('/usr/bin/open', [`${url}/#curate`], error => error ? reject(error) : accept()));
  }
  console.log(`句。间已就绪：${url}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
