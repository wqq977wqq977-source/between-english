import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const zsh = '/bin/zsh';
const skip = !existsSync(zsh) ? 'The macOS launcher requires zsh' : false;

async function fixture(platform, run) {
  const root = await mkdtemp(join(tmpdir(), 'between launcher #'));
  const bin = join(root, 'bin');
  const calls = join(root, 'node-calls');
  await mkdir(bin);
  await copyFile(resolve('start.command'), join(root, 'start.command'));
  await writeFile(join(bin, 'uname'), `#!/bin/sh\nprintf '%s\\n' '${platform}'\n`, { mode: 0o700 });
  // This fake Node only records selection. It never starts the application,
  // probes the user's port, installs packages or touches personal data.
  await writeFile(join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LAUNCHER_TEST_CALLS"\n', { mode: 0o700 });
  try {
    await run({ root, calls, launch: () => exec(zsh, [join(root, 'start.command'), '--no-open'], {
      cwd: root, timeout: 10000,
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, LAUNCHER_TEST_CALLS: calls },
    }) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('macOS launcher preserves the caller-selected Node and handles a path with spaces and #', { skip }, async () => {
  await fixture('Darwin', async ({ root, calls, launch }) => {
    const { stdout } = await launch();
    assert.equal(stdout, '');
    const invocations = (await readFile(calls, 'utf8')).trim().split('\n');
    assert.equal(invocations.length, 3, 'Use the same caller-selected Node for version, dependencies and launcher');
    assert.match(invocations[0], /^-e /);
    assert.match(invocations[1], /^--input-type=module -e /);
    assert.equal(invocations[2], 'scripts/launch.mjs --no-open');
    assert.equal(existsSync(join(root, 'data')), false, 'The fixture must not start a real backend');
  });
});

test('non-macOS launcher exits before creating runtime files or starting a process', { skip }, async () => {
  await fixture('Linux', async ({ root, calls, launch }) => {
    await assert.rejects(launch(), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /仅支持 macOS/);
      assert.match(error.stderr, /npm start/);
      return true;
    });
    assert.equal(existsSync(join(root, 'work')), false);
    assert.equal(existsSync(calls), false);
  });
});
