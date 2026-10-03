import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

function protectFiles(paths) {
  for (const path of paths) {
    try { chmodSync(path, 0o600); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function openStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filePath = resolve(directory, 'study.sqlite');
  // SQLite derives sidecar permissions from its database; create it privately first.
  closeSync(openSync(filePath, 'a', 0o600));
  const databasePath = realpathSync(filePath);
  const privateFiles = ['', '-wal', '-shm', '-journal'].map(suffix => databasePath + suffix);
  protectFiles(privateFiles);
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_documents_kind ON documents(kind);
      PRAGMA user_version=1;`);
    protectFiles(privateFiles);
  } catch (error) { db.close(); throw error; }
  const get = db.prepare('SELECT data FROM documents WHERE id = ?');
  const list = db.prepare('SELECT data FROM documents WHERE kind = ? ORDER BY updated_at DESC');
  const put = db.prepare('INSERT INTO documents(id, kind, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at');
  return {
    db,
    get(id) { const row = get.get(id); return row ? JSON.parse(row.data) : null; },
    list(kind) { return list.all(kind).map(row => JSON.parse(row.data)); },
    put(kind, value) { put.run(value.id, kind, JSON.stringify(value), new Date().toISOString()); return value; },
    transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch(error) { db.exec('ROLLBACK'); throw error; } },
    close() { db.close(); }
  };
}
