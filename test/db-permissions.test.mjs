import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/db.mjs';

const mode = path => statSync(path).mode & 0o777;
const files = directory => ['', '-wal', '-shm'].map(suffix => join(directory, `study.sqlite${suffix}`));
function assertPrivateDatabase(directory) {
  for (const file of files(directory)) { assert.ok(existsSync(file), `Expected live SQLite file: ${file}`); assert.equal(mode(file), 0o600, `${file} should be owner-only`); }
}
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'between-db-permissions-')), previousUmask = process.umask(0o022);
  try { run(root); } finally { process.umask(previousUmask); rmSync(root, { recursive: true, force: true }); }
}

test('new data directories and live SQLite files are private', { skip: process.platform === 'win32' }, () => fixture(root => {
  const directory = join(root, 'new-data'), store = openStore(directory);
  try { store.put('word', { id: 'fixture', word: 'orbit' }); assert.equal(mode(directory), 0o700); assertPrivateDatabase(directory); }
  finally { store.close(); }
}));

test('a pre-existing shared directory keeps its mode while SQLite files become private', { skip: process.platform === 'win32' }, () => fixture(root => {
  const directory = join(root, 'shared'); mkdirSync(directory); chmodSync(directory, 0o755);
  const store = openStore(directory);
  try { store.put('word', { id: 'fixture', word: 'orbit' }); assertPrivateDatabase(directory); assert.equal(mode(directory), 0o755); }
  finally { store.close(); }
}));

test('opening an existing store repairs database and sidecar modes and retains records after restart', { skip: process.platform === 'win32' }, () => fixture(root => {
  const first = openStore(root); let second, restarted, firstClosed = false;
  try {
    first.put('word', { id: 'fixture', word: 'orbit' });
    for (const file of files(root)) chmodSync(file, 0o644);
    second = openStore(root); assertPrivateDatabase(root); assert.equal(second.get('fixture').word, 'orbit');
    second.close(); second = null; first.close(); firstClosed = true;
    chmodSync(files(root)[0], 0o644);
    restarted = openStore(root); restarted.put('word', { id: 'other', word: 'planet' });
    assertPrivateDatabase(root); assert.equal(restarted.get('fixture').word, 'orbit');
  } finally { if (second) second.close(); if (restarted) restarted.close(); if (!firstClosed) first.close(); }
}));

test('a symlinked database protects sidecars beside its real path without changing shared directories', { skip: process.platform === 'win32' }, () => fixture(root => {
  const shared = join(root, 'shared'), entry = join(root, 'entry');
  for (const directory of [shared, entry]) { mkdirSync(directory); chmodSync(directory, 0o755); }
  const realPath = join(shared, 'old.sqlite'), original = new DatabaseSync(realPath); let store;
  try {
    original.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE documents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    original.prepare('INSERT INTO documents VALUES (?, ?, ?, ?)').run('fixture', 'word', JSON.stringify({ id: 'fixture', word: 'orbit' }), '2026-10-03T00:00:00Z');
    const realFiles = ['', '-wal', '-shm'].map(suffix => realPath + suffix);
    for (const file of realFiles) chmodSync(file, 0o644);
    symlinkSync(realPath, join(entry, 'study.sqlite'));
    store = openStore(entry);
    assert.equal(store.get('fixture').word, 'orbit');
    for (const file of realFiles) assert.equal(mode(file), 0o600, `Real SQLite file must be private: ${file}`);
    for (const directory of [shared, entry]) assert.equal(mode(directory), 0o755);
  } finally { if (store) store.close(); original.close(); }
}));
