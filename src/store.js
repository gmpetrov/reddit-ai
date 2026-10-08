// Tiny JSON-file store. Browser session state (cookies/localStorage) is encrypted at rest.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve('data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const secret = process.env.APP_SECRET || '';
if (!/^[0-9a-f]{64}$/i.test(secret)) {
  throw new Error('APP_SECRET must be a 64-char hex string (openssl rand -hex 32)');
}
const KEY = Buffer.from(secret, 'hex');

fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { profiles: [], tasks: [], runs: [] };
if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };

let writeTimer = null;
function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 50);
}
export function flush() {
  clearTimeout(writeTimer);
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
}

export function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(str) {
  const [iv, tag, data] = str.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
}

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();

// ---- profiles: a named, reusable logged-in browser identity ----
export function publicProfile(p) {
  if (!p) return p;
  const { storageState, ...rest } = p;
  return { ...rest, hasSavedSession: Boolean(storageState) };
}
export const profiles = {
  list: () => db.profiles.map(publicProfile),
  get: (pid) => db.profiles.find((p) => p.id === pid),
  create({ name, startUrl }) {
    const p = { id: id(), name, startUrl, createdAt: now(), savedAt: null, storageState: null };
    db.profiles.push(p);
    persist();
    return p;
  },
  stateGeneration: (pid) => profiles.get(pid)?.stateGen || 0,
  // gen: the generation observed when the snapshot started; stale snapshots are dropped.
  saveState(pid, state, gen) {
    const p = profiles.get(pid);
    if (!p || (p.stateGen || 0) !== gen) return;
    p.storageState = encrypt(state);
    p.savedAt = now();
    persist();
  },
  loadState(pid) {
    const p = profiles.get(pid);
    return p?.storageState ? decrypt(p.storageState) : null;
  },
  clearState(pid) {
    const p = profiles.get(pid);
    if (!p) return;
    p.storageState = null;
    p.savedAt = null;
    p.stateGen = (p.stateGen || 0) + 1;
    persist();
  },
  remove(pid) {
    db.profiles = db.profiles.filter((p) => p.id !== pid);
    persist();
  },
};

// ---- tasks: instructions the AI agent performs with a profile ----
export const tasks = {
  list: () => db.tasks,
  get: (tid) => db.tasks.find((t) => t.id === tid),
  create({ name, profileId, startUrl, instructions, maxSteps }) {
    const t = { id: id(), name, profileId, startUrl, instructions, maxSteps, createdAt: now() };
    db.tasks.push(t);
    persist();
    return t;
  },
  update(tid, fields) {
    const t = tasks.get(tid);
    if (!t) return null;
    Object.assign(t, fields);
    persist();
    return t;
  },
  remove(tid) {
    db.tasks = db.tasks.filter((t) => t.id !== tid);
    persist();
  },
};

// ---- runs: one execution of a task ----
const MAX_RUNS = 200;
export const runs = {
  list: () => db.runs.slice().reverse(),
  get: (rid) => db.runs.find((r) => r.id === rid),
  create({ taskId, profileId, task }) {
    const r = { id: id(), rev: 0, taskId, profileId, task, status: 'queued', startedAt: now(), endedAt: null, result: null, error: null, humanRequest: null, steps: [] };
    db.runs.push(r);
    if (db.runs.length > MAX_RUNS) db.runs = db.runs.slice(-MAX_RUNS);
    persist();
    return r;
  },
  update(rid, fields) {
    const r = runs.get(rid);
    if (!r) return null;
    Object.assign(r, fields);
    r.rev++;
    persist();
    return r;
  },
  addStep(rid, step) {
    const r = runs.get(rid);
    if (!r) return;
    r.steps.push({ at: now(), ...step });
    r.rev++;
    persist();
  },
  // Runs left "active" by a crashed/restarted server can never finish.
  failInterrupted() {
    for (const r of db.runs) {
      if (['queued', 'running', 'waiting_human'].includes(r.status)) {
        Object.assign(r, { status: 'failed', error: 'Interrupted by server restart', endedAt: now(), humanRequest: null });
      }
    }
    persist();
  },
};
