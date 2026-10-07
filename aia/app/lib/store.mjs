import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(stable(value)).digest('hex');
export const hashBytes = value => createHash('sha256').update(value).digest('hex');
export const id = prefix => `${prefix}-${randomUUID()}`;
export function fail(status, message) { const error = new Error(message); error.status = status; throw error; }
export function field(value, name, min = 0, max = 20000) {
  if (typeof value !== 'string' || value.includes('\0')) fail(400, `${name}必须是文字。`);
  const result = value.trim();
  if (Array.from(result).length < min || Array.from(result).length > max) fail(400, `${name}须为 ${min} 至 ${max} 字。`);
  return result;
}

export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'aia.sqlite'));
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE NOT NULL, password_hash TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS research (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), previous_id TEXT REFERENCES research(id), data TEXT NOT NULL, artifact TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assessments (id TEXT PRIMARY KEY, research_id TEXT NOT NULL REFERENCES research(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, research_id TEXT NOT NULL REFERENCES research(id), owner_id TEXT NOT NULL REFERENCES users(id), reviewer_id TEXT NOT NULL REFERENCES users(id), data TEXT NOT NULL, CHECK(owner_id <> reviewer_id));
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, research_id TEXT NOT NULL REFERENCES research(id), owner_id TEXT NOT NULL REFERENCES users(id), executor_id TEXT NOT NULL REFERENCES users(id), verifier_id TEXT NOT NULL REFERENCES users(id), data TEXT NOT NULL, CHECK(owner_id <> executor_id AND owner_id <> verifier_id AND executor_id <> verifier_id));
    CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL, archive TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS verifications (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), delivery_id TEXT NOT NULL UNIQUE REFERENCES deliveries(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS contributions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), user_id TEXT NOT NULL REFERENCES users(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, research_id TEXT NOT NULL REFERENCES research(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wallet_challenges (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), data TEXT NOT NULL, consumed_at TEXT);
    CREATE TABLE IF NOT EXISTS attestations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), tx_hash TEXT UNIQUE, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS research_owner ON research(owner_id);
    CREATE INDEX IF NOT EXISTS review_participants ON reviews(owner_id, reviewer_id);
    CREATE INDEX IF NOT EXISTS task_participants ON tasks(owner_id, executor_id, verifier_id);
    PRAGMA user_version=1;`);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); if (result?.then) throw new Error('Database transactions must be synchronous'); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function event(researchId, actorId, action, details = {}) {
    const record = { id: id('event'), researchId, actorId, action, ...details, createdAt: new Date().toISOString() };
    run('INSERT INTO events(id,research_id,data) VALUES(?,?,?)', record.id, researchId, JSON.stringify(record));
    return record;
  }
  return { db, one, all, run, transaction, event, close: () => db.close() };
}
