import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { binary } from './codex.mjs';
import { UserError } from './contracts.mjs';
import { normalizeCodexCapabilities } from './model-options.mjs';

export function normalizeModels(entries) {
  const seen = new Set();
  return entries.flatMap(entry => {
    if (!entry || typeof entry.model !== 'string' || !/^[a-zA-Z0-9._:/-]{1,100}$/.test(entry.model)) throw new UserError('模型列表格式异常，请重试。', 502);
    if (entry.hidden === true || (Array.isArray(entry.inputModalities) && !entry.inputModalities.includes('text')) || seen.has(entry.model)) return [];
    seen.add(entry.model);
    return [{ id: entry.model, name: typeof entry.displayName === 'string' ? entry.displayName.slice(0, 120) : entry.model, isDefault: entry.isDefault === true, ...normalizeCodexCapabilities(entry) }];
  });
}

// Use the authenticated CLI's discovery API. No thread, turn or inference is started.
export async function listCodexModels({ workRoot, binaryPath = binary, timeoutMs = 30000, signal } = {}) {
  if (signal?.aborted) throw new UserError('模型获取已取消。', 409);
  await mkdir(workRoot, { recursive: true });
  const cwd = await mkdtemp(join(workRoot, 'models-'));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(binaryPath, ['app-server', '--stdio', '-c', 'model_provider="openai"', '--disable', 'hooks', '--disable', 'plugins', '--disable', 'apps', '--disable', 'remote_plugin'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: { ...process.env, NO_COLOR: '1' } });
      let settled = false, buffer = '', bytes = 0, id = 0, phase = 'initialize', pages = 0;
      const entries = [], cursors = new Set();
      function stop() { try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch {} }
      function finish(error, value) {
        if (settled) return; settled = true;
        clearTimeout(timer); signal?.removeEventListener('abort', abort); stop();
        error ? reject(error) : resolve(value);
      }
      const abort = () => finish(new UserError('模型获取已取消。', 409));
      const timer = setTimeout(() => finish(new UserError('获取模型超时，请重试。', 504)), timeoutMs);
      const write = message => { if (!settled) child.stdin.write(JSON.stringify(message) + '\n'); };
      const request = (method, params) => { phase = method; write({ id: ++id, method, params }); };
      signal?.addEventListener('abort', abort, { once: true });
      child.on('error', () => finish(new UserError('无法启动 Codex，请检查安装。', 503)));
      child.on('close', () => finish(new UserError('模型列表获取失败，请检查 Codex 登录与网络。', 502)));
      child.stdin.on('error', () => finish(new UserError('Codex 连接中断，请重试。', 502)));
      // Discard runtime diagnostics; they may contain paths or account information.
      child.stderr.on('data', () => {});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 2 * 1024 * 1024) return finish(new UserError('模型列表过大，请重试。', 502));
        buffer += chunk;
        const lines = buffer.split('\n'); buffer = lines.pop();
        for (const line of lines) {
          if (settled || !line.trim()) continue;
          let message;
          try { message = JSON.parse(line); } catch { return finish(new UserError('Codex 返回格式异常，请更新 CLI 后重试。', 502)); }
          if (!message || typeof message !== 'object' || Array.isArray(message)) return finish(new UserError('Codex 返回格式异常，请更新 CLI 后重试。', 502));
          if (message.method) {
            // Never execute unsolicited server requests (including approvals).
            if (message.id !== undefined) write({ id: message.id, error: { code: -32601, message: 'This client only supports model discovery.' } });
            continue;
          }
          if (message.id !== id) continue;
          if (message.error) return finish(new UserError('无法获取模型，请检查 Codex 登录与网络后重试。', 502));
          const result = message.result;
          if (phase === 'initialize') {
            write({ method: 'initialized', params: {} });
            request('account/read', { refreshToken: false });
          } else if (phase === 'account/read') {
            if (!result?.account) return finish(new UserError('请先运行 codex login，再获取模型。', 401));
            request('model/list', { limit: 100, includeHidden: false });
          } else if (phase === 'model/list') {
            if (!Array.isArray(result?.data) || result.data.length > 1000) return finish(new UserError('模型列表格式异常，请重试。', 502));
            entries.push(...result.data); pages++;
            const cursor = result.nextCursor;
            if (cursor != null) {
              if (typeof cursor !== 'string' || !cursor || cursors.has(cursor) || pages >= 10) return finish(new UserError('模型列表不完整，请重新获取。', 502));
              cursors.add(cursor); request('model/list', { limit: 100, includeHidden: false, cursor });
            } else {
              try {
                const models = normalizeModels(entries);
                if (!models.length) throw new UserError('当前账户没有返回可选模型。', 404);
                finish(null, { models, fetchedAt: new Date().toISOString() });
              } catch (error) { finish(error); }
            }
          }
        }
      });
      if (signal?.aborted) abort();
      else request('initialize', { clientInfo: { name: 'between_english', title: 'Between English', version: '0.1.0' }, capabilities: { experimentalApi: false } });
    });
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
