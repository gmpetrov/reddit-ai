import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { profiles, tasks, runs, publicProfile, flush } from './store.js';
import { manager, events as browserEvents, normalizeUrl, listRemoteSessions, stopRemoteSession, scrub, getAccount } from './browser.js';
import { startRun, stopRun, resumeRun, events as runEvents } from './agent.js';

for (const k of ['SCRAPFLY_API_KEY', 'OPENAI_API_KEY']) {
  if (!process.env[k]) throw new Error(`${k} is not set (see .env.example)`);
}

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;

runs.failInterrupted();

const app = express();
app.use(express.json({ limit: '200kb' }));

// The app drives logged-in browsers, so refuse cross-site requests (CSRF / DNS rebinding).
const allowedHosts = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`, `127.0.0.1:${PORT}`]);
function sameOrigin(req) {
  if (!allowedHosts.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}`;
}
app.use((req, res, next) => (sameOrigin(req) ? next() : res.status(403).json({ error: 'Forbidden origin' })));

app.use(express.static(path.resolve('public')));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => res.status(err.status || 500).json({ error: scrub(err.message) }));
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const str = (v, max = 5000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---- profiles ----
app.get('/api/profiles', (req, res) => res.json(profiles.list()));
app.post('/api/profiles', wrap((req, res) => {
  const name = str(req.body.name, 100);
  if (!name) throw bad('Name is required');
  const startUrl = req.body.startUrl ? normalizeUrl(str(req.body.startUrl, 2000)) : '';
  res.json(publicProfile(profiles.create({ name, startUrl })));
}));
app.delete('/api/profiles/:id', wrap(async (req, res) => {
  if (!profiles.get(req.params.id)) throw bad('Not found', 404);
  if (tasks.list().some((t) => t.profileId === req.params.id)) throw bad('Delete the tasks using this profile first');
  await manager.close(req.params.id, { save: false });
  profiles.remove(req.params.id);
  res.json({ ok: true });
}));
app.post('/api/profiles/:id/clear', wrap(async (req, res) => {
  if (!profiles.get(req.params.id)) throw bad('Not found', 404);
  if (manager.get(req.params.id)) throw bad('Close the browser first');
  profiles.clearState(req.params.id);
  res.json({ ok: true });
}));

// ---- browser sessions ----
app.get('/api/sessions', (req, res) => res.json(manager.list()));
app.post('/api/profiles/:id/open', wrap(async (req, res) => {
  const p = profiles.get(req.params.id);
  if (!p) throw bad('Not found', 404);
  const fresh = !manager.get(p.id);
  const s = await manager.open(p.id);
  if (fresh && p.startUrl) await s.input({ type: 'navigate', url: p.startUrl }).catch(() => {});
  res.json(s.summary());
}));
app.post('/api/profiles/:id/save', wrap(async (req, res) => {
  const s = manager.get(req.params.id);
  if (!s) throw bad('Browser is not open');
  await s.saveState();
  res.json(publicProfile(profiles.get(req.params.id)));
}));
app.post('/api/profiles/:id/close', wrap(async (req, res) => {
  // Lock check happens inside the serialized close, after any in-flight open completes.
  await manager.close(req.params.id, { save: req.body.save !== false, strict: true }).catch((err) => {
    throw bad(err.message, 409);
  });
  res.json({ ok: true });
}));
app.get('/api/scrapfly/account', wrap(async (req, res) => res.json(await getAccount({ fresh: req.query.fresh === '1' }))));
// Remote sessions on the Scrapfly account (incl. orphans from crashes) — these bill until stopped.
app.get('/api/scrapfly/sessions', wrap(async (req, res) => res.json(await listRemoteSessions())));
app.post('/api/scrapfly/sessions/:sid/stop', wrap(async (req, res) => {
  const local = manager.list().find((s) => s.sessionId === req.params.sid);
  if (local) await manager.close(local.profileId).catch((err) => {
    throw bad(err.message, 409);
  });
  else await stopRemoteSession(req.params.sid);
  res.json({ ok: true });
}));

// ---- tasks ----
function taskFields(body) {
  const name = str(body.name, 100);
  const profileId = str(body.profileId, 100);
  const instructions = str(body.instructions, 8000);
  if (!name || !instructions) throw bad('Name and instructions are required');
  if (!profiles.get(profileId)) throw bad('Pick a valid profile');
  const startUrl = body.startUrl ? normalizeUrl(str(body.startUrl, 2000)) : '';
  const maxSteps = Math.min(Math.max(parseInt(body.maxSteps, 10) || 30, 1), 100);
  return { name, profileId, instructions, startUrl, maxSteps };
}
app.get('/api/tasks', (req, res) => res.json(tasks.list()));
app.post('/api/tasks', wrap((req, res) => res.json(tasks.create(taskFields(req.body)))));
app.put('/api/tasks/:id', wrap((req, res) => {
  if (!tasks.get(req.params.id)) throw bad('Not found', 404);
  res.json(tasks.update(req.params.id, taskFields(req.body)));
}));
app.delete('/api/tasks/:id', wrap((req, res) => {
  tasks.remove(req.params.id);
  res.json({ ok: true });
}));
app.post('/api/tasks/:id/run', wrap(async (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) throw bad('Not found', 404);
  if (manager.get(t.profileId)?.lockedBy) throw bad('Another run is already using this profile');
  if (runs.list().some((r) => r.profileId === t.profileId && ['queued', 'running', 'waiting_human'].includes(r.status))) {
    throw bad('Another run is already using this profile');
  }
  res.json(await startRun(t.id));
}));

// ---- runs ----
app.get('/api/runs', (req, res) => res.json(runs.list().slice(0, 50)));
app.get('/api/runs/:id', (req, res) => {
  const r = runs.get(req.params.id);
  r ? res.json(r) : res.status(404).json({ error: 'Not found' });
});
app.post('/api/runs/:id/resume', wrap((req, res) => {
  if (!resumeRun(req.params.id, str(req.body.note, 2000))) throw bad('Run is not waiting for a human');
  res.json({ ok: true });
}));
app.post('/api/runs/:id/stop', wrap((req, res) => {
  if (!stopRun(req.params.id)) throw bad('Run is not active');
  res.json({ ok: true });
}));

// ---- server-sent events: live run + session updates ----
const sseClients = new Set();
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`event: sessions\ndata: ${JSON.stringify(manager.list())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}
runEvents.on('run', (r) => broadcast('run', r));
browserEvents.on('session', () => broadcast('sessions', manager.list()));
setInterval(() => broadcast('ping', Date.now()), 25_000);

// ---- websocket: live view + remote control (human in the loop) ----
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/ws\/live\/([\w-]+)$/);
  if (!m || !sameOrigin(req)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => attachViewer(ws, m[1]));
});

async function attachViewer(ws, profileId) {
  const s = manager.get(profileId);
  if (!s || s.status !== 'open') {
    ws.send(JSON.stringify({ type: 'closed' }));
    return ws.close();
  }
  await s.addViewer(ws).catch(() => {});
  ws.on('message', (raw) => {
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    s.enqueueInput(ev).catch((err) => ws.send(JSON.stringify({ type: 'error', message: scrub(err.message).split('\n')[0] })));
  });
  ws.on('close', () => s.removeViewer(ws).catch(() => {}));
}

server.listen(PORT, HOST, () => console.log(`Scrapfly agent UI on http://${HOST}:${PORT}`));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Saving sessions and stopping remote browsers...');
  server.close();
  wss.clients.forEach((ws) => ws.terminate());
  for (const res of sseClients) res.end();
  await manager.closeAll();
  flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
