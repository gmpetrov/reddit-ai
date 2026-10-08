// Custom Next.js server. It owns the long-lived state (encrypted store, Scrapfly browsers, agent
// runs) and the live-view websocket, which Next route handlers can't serve.
import http from 'node:http';
import { EventEmitter } from 'node:events';
import next from 'next';
import { WebSocketServer } from 'ws';
import { register } from './lib/runtime.js';
import { profiles, tasks, runs, publicProfile, flush } from './lib/store.js';
import { manager, events as browserEvents, normalizeUrl, listRemoteSessions, stopRemoteSession, scrub, getAccount } from './lib/browser.js';
import { startRun, stopRun, resumeRun, events as runEvents } from './lib/agent.js';

for (const k of ['SCRAPFLY_API_KEY', 'OPENAI_API_KEY']) {
  if (!process.env[k]) throw new Error(`${k} is not set (see .env.example)`);
}

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const dev = process.env.NODE_ENV !== 'production';

runs.failInterrupted();

register({
  profiles, tasks, runs, publicProfile,
  manager, browserEvents, normalizeUrl, listRemoteSessions, stopRemoteSession, scrub, getAccount,
  startRun, stopRun, resumeRun, runEvents,
});

// Next attaches its own 'upgrade' listener to `httpServer` (for dev HMR). Hand it a private emitter
// so it only sees the upgrades routed to it below, never /ws/live or cross-origin ones.
const nextUpgrades = new EventEmitter();
const app = next({ dev, hostname: HOST, port: PORT, httpServer: nextUpgrades });
const handle = app.getRequestHandler();
await app.prepare();

// The app drives logged-in browsers, so refuse cross-site requests (CSRF / DNS rebinding).
const allowedHosts = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`, `127.0.0.1:${PORT}`]);
function sameOrigin(req) {
  if (!allowedHosts.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}`;
}

const server = http.createServer((req, res) => {
  if (!sameOrigin(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Forbidden origin' }));
  }
  handle(req, res);
});

// ---- websocket: live view + remote control (human in the loop) ----
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (!sameOrigin(req)) return socket.destroy();
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/ws\/live\/([\w-]+)$/);
  if (m) return wss.handleUpgrade(req, socket, head, (ws) => attachViewer(ws, m[1]));
  if (dev && url.pathname === '/_next/hmr') return nextUpgrades.emit('upgrade', req, socket, head);
  socket.destroy();
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
  server.closeAllConnections(); // ends open SSE streams
  wss.clients.forEach((ws) => ws.terminate());
  await manager.closeAll();
  flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
