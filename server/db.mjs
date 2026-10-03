import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export function openStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolve(directory, 'study.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_documents_kind ON documents(kind);
    PRAGMA user_version=1;`);
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
