import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

export function openDatabase(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY)');
  const files = readdirSync(root).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  for (const file of files) {
    const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(file);
    if (!applied) db.transaction(() => {
      db.exec(readFileSync(join(root, file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(file);
    })();
  }
  return db;
}
