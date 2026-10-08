// Scrapfly Cloud Browser sessions driven over CDP with Playwright.
// One live browser per profile. The browser's cookies/localStorage are snapshotted into the
// (encrypted) profile so a login survives Scrapfly's 30-minute session limit and server restarts.
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright-core';
import { profiles } from './store.js';

const API = 'https://browser.scrapfly.io';
const KEY = process.env.SCRAPFLY_API_KEY;
const SESSION_TIMEOUT_S = 1800; // Scrapfly maximum
// Scrapfly keeps the fingerprinted native window size (viewport emulation is ignored), so we
// only cap the screencast resolution; input coordinates come from the frame metadata.
const SCREENCAST_MAX = { maxWidth: 1280, maxHeight: 900 };
const AUTOSAVE_MS = 60_000;

export const events = new EventEmitter(); // 'session' -> session summary

function wsUrl(sessionId) {
  const params = new URLSearchParams({
    api_key: KEY,
    session: sessionId,
    auto_close: 'false',
    timeout: String(SESSION_TIMEOUT_S),
    proxy_pool: process.env.SCRAPFLY_PROXY_POOL || 'residential',
    os: process.env.SCRAPFLY_OS || 'windows',
  });
  if (process.env.SCRAPFLY_COUNTRY) params.set('country', process.env.SCRAPFLY_COUNTRY);
  return `wss://browser.scrapfly.io?${params}`;
}

// Stops a remote browser (it bills until stopped). 404 means it is already gone.
export async function stopRemoteSession(sessionId, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${API}/session/${encodeURIComponent(sessionId)}/stop?api_key=${KEY}`, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok || res.status === 404) return;
      lastErr = new Error(`Scrapfly stop returned ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  console.error(`Failed to stop Scrapfly session ${sessionId}: ${scrub(lastErr?.message)}`);
  throw lastErr;
}

export async function listRemoteSessions() {
  const res = await fetch(`${API}/sessions?api_key=${KEY}`);
  if (!res.ok) throw new Error(`Scrapfly /sessions ${res.status}`);
  return res.json();
}

// Strip secrets from errors that may contain the websocket URL.
export function scrub(msg) {
  return String(msg).replaceAll(KEY, '***');
}

// ---- account / quota ----
let accountCache = { at: 0, data: null };
export async function getAccount({ fresh = false } = {}) {
  if (!fresh && accountCache.data && Date.now() - accountCache.at < 60_000) return accountCache.data;
  const res = await fetch(`https://api.scrapfly.io/account?key=${KEY}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Scrapfly /account returned ${res.status}`);
  const sub = (await res.json()).subscription || {};
  const usage = sub.usage?.scrape || {};
  const data = {
    plan: sub.plan_name,
    planPriceUsd: sub.billing?.plan_price?.currency === 'USD' ? sub.billing.plan_price.amount : null,
    used: usage.current,
    limit: usage.limit,
    remaining: usage.remaining,
    extraAllowed: Boolean(sub.extra_scrape_allowed),
    concurrencyRemaining: usage.concurrent_remaining,
    resetsAt: sub.period?.end ? new Date(sub.period.end.replace(' ', 'T') + 'Z').toISOString() : null,
  };
  accountCache = { at: Date.now(), data };
  return data;
}

const quotaMessage = (a) =>
  `Scrapfly quota exhausted${a?.plan ? ` (${a.plan} plan: ${a.used}/${a.limit} credits used` + (a.resetsAt ? `, resets ${a.resetsAt.slice(0, 10)})` : ')') : ''}. ` +
  'Upgrade or top up at https://scrapfly.io/dashboard/subscription, or wait for the reset.';

// Turn Playwright's verbose connect error (ANSI codes, call log) into one actionable sentence.
export function friendlyBrowserError(err, account) {
  const raw = scrub(err?.message || err).replace(/\u001b\[[0-9;]*m|\[\d+m/g, '');
  const m = raw.match(/ERR::([A-Z_]+(?:::[A-Z_]+)*):\s*([^\n]*)/);
  if (m) {
    if (m[1].endsWith('QUOTA_LIMIT_REACHED')) return quotaMessage(account);
    if (m[1].includes('CONCURRENCY')) return `Scrapfly concurrency limit reached (too many browsers running). Close another browser and retry. [${m[1]}]`;
    return `Scrapfly refused the browser: ${m[2].trim()} [ERR::${m[1]}]`;
  }
  return raw.split('\n')[0].replace(/^browserType\.connectOverCDP:\s*/, '');
}

// Fail fast (and for free) when the account cannot start a browser.
async function assertQuota() {
  let a;
  try {
    a = await getAccount();
  } catch {
    return; // account API unavailable: let the connect attempt decide
  }
  if (a.remaining <= 0 && !a.extraAllowed) throw new Error(quotaMessage(a));
}

class BrowserSession {
  constructor(profileId) {
    this.profileId = profileId;
    // A fresh remote session per open: a stopped Scrapfly session can't be resumed, our own
    // encrypted snapshot is what carries the login across sessions.
    this.sessionId = `p-${profileId.slice(0, 8)}-${Date.now().toString(36)}`;
    this.status = 'connecting'; // connecting | open | closing | closed
    this.viewers = new Set();
    this.lockedBy = null; // run id currently driving the browser
    this.page = null;
    this.cdp = null;
    this.startedAt = Date.now();
    this.expiresAt = this.startedAt + SESSION_TIMEOUT_S * 1000;
    this.lastFrame = null;
    this.inputQueue = Promise.resolve();
    this.saveChain = Promise.resolve();
    this.closeListeners = new Set(); // notified when the browser goes away for any reason
  }

  summary() {
    return {
      profileId: this.profileId,
      sessionId: this.sessionId,
      status: this.status,
      lockedBy: this.lockedBy,
      url: this.page && !this.page.isClosed() ? this.page.url() : null,
      expiresAt: new Date(this.expiresAt).toISOString(),
      viewers: this.viewers.size,
    };
  }

  emit() {
    events.emit('session', this.summary());
  }

  async connect() {
    this.browser = await chromium.connectOverCDP(wsUrl(this.sessionId), { timeout: 90_000 });
    this.browser.on('disconnected', () => this.handleDisconnect());
    if (this.status !== 'connecting') throw new Error('Session closed while connecting');
    this.context = this.browser.contexts()[0] || (await this.browser.newContext());
    this.context.on('page', (p) => this.setActivePage(p).catch(() => {}));
    await this.setActivePage(this.context.pages()[0] || (await this.context.newPage()));
    await this.restoreState();
    if (this.status !== 'connecting') throw new Error('Browser disconnected while restoring the session');
    this.status = 'open';
    this.autosave = setInterval(() => this.saveState().catch(() => {}), AUTOSAVE_MS);
    this.emit();
  }

  async restoreState() {
    const state = profiles.loadState(this.profileId);
    if (!state) return;
    if (state.cookies?.length) await this.context.addCookies(state.cookies);
    // localStorage has to be written from a page on the matching origin.
    for (const { origin, localStorage } of state.origins || []) {
      if (!localStorage?.length) continue;
      try {
        await this.page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        // Never write one origin's tokens into another origin (e.g. after a redirect).
        if (new URL(this.page.url()).origin !== origin) continue;
        await this.page.evaluate(
          ({ expected, items }) => {
            if (location.origin !== expected) return;
            for (const { name, value } of items) window.localStorage.setItem(name, value);
          },
          { expected: origin, items: localStorage }
        );
      } catch {
        // Origin unreachable; cookies are usually what matters for auth.
      }
    }
  }

  // Snapshots are serialized so an older snapshot never lands after a newer one, and tagged with
  // the profile's state generation so "Forget session" can't be undone by an in-flight save.
  saveState() {
    const run = async () => {
      if (!this.context || (this.status !== 'open' && this.status !== 'closing')) return;
      const gen = profiles.stateGeneration(this.profileId);
      const state = await this.context.storageState();
      // A replaced/disconnected session must not overwrite its successor's newer login.
      if (manager.sessions.get(this.profileId) !== this) return;
      profiles.saveState(this.profileId, state, gen);
    };
    const next = this.saveChain.then(run);
    this.saveChain = next.catch(() => {});
    return next;
  }

  onClose(fn) {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  async setActivePage(page) {
    if (this.page === page) return;
    this.page = page;
    page.on('close', () => {
      if (this.page !== page) return;
      const next = this.context.pages().find((p) => !p.isClosed());
      if (next) this.setActivePage(next).catch(() => {});
    });
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) this.emit();
    });
    await this.restartScreencast();
    this.emit();
  }

  // ---- live view (human in the loop) ----
  async restartScreencast() {
    if (this.cdp) {
      await this.cdp.detach().catch(() => {});
      this.cdp = null;
    }
    if (!this.viewers.size || !this.page || this.page.isClosed()) return;
    const cdp = await this.context.newCDPSession(this.page);
    this.cdp = cdp;
    cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      this.lastFrame = { data, metadata };
      const msg = JSON.stringify({ type: 'frame', data, width: metadata.deviceWidth, height: metadata.deviceHeight });
      for (const ws of this.viewers) if (ws.readyState === 1) ws.send(msg);
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, ...SCREENCAST_MAX, everyNthFrame: 1 });
  }

  async addViewer(ws) {
    this.viewers.add(ws);
    if (this.lastFrame) ws.send(JSON.stringify({ type: 'frame', data: this.lastFrame.data, width: this.lastFrame.metadata.deviceWidth, height: this.lastFrame.metadata.deviceHeight }));
    if (this.viewers.size === 1) await this.restartScreencast();
    this.emit();
  }

  async removeViewer(ws) {
    this.viewers.delete(ws);
    if (!this.viewers.size && this.cdp) {
      await this.cdp.send('Page.stopScreencast').catch(() => {});
      await this.cdp.detach().catch(() => {});
      this.cdp = null;
    }
    this.emit();
  }

  // Viewer input must be applied in order (mousedown before mouseup, keys in sequence).
  enqueueInput(ev) {
    const next = this.inputQueue.then(() => this.input(ev));
    this.inputQueue = next.catch(() => {});
    return next;
  }

  // Input from the live viewer. Coordinates arrive in viewport CSS pixels.
  async input(ev) {
    const page = this.page;
    if (!page || page.isClosed()) return;
    const mouse = page.mouse;
    switch (ev.type) {
      case 'mousemove':
        return mouse.move(ev.x, ev.y);
      case 'mousedown':
        await mouse.move(ev.x, ev.y);
        return mouse.down({ button: ev.button || 'left' });
      case 'mouseup':
        await mouse.move(ev.x, ev.y);
        return mouse.up({ button: ev.button || 'left' });
      case 'wheel':
        await mouse.move(ev.x, ev.y);
        return mouse.wheel(ev.deltaX || 0, ev.deltaY || 0);
      case 'key': {
        const mods = [ev.ctrl && 'Control', ev.alt && 'Alt', ev.meta && 'Meta', ev.shift && ev.key.length > 1 && 'Shift'].filter(Boolean);
        if (ev.key.length === 1 && !ev.ctrl && !ev.meta && !ev.alt) return page.keyboard.type(ev.key);
        return page.keyboard.press([...mods, ev.key].join('+'));
      }
      case 'text':
        return page.keyboard.insertText(String(ev.text || ''));
      case 'navigate':
        return page.goto(normalizeUrl(ev.url), { waitUntil: 'domcontentloaded', timeout: 45_000 });
      case 'back':
        return page.goBack({ timeout: 15_000 });
      case 'reload':
        return page.reload({ timeout: 30_000 });
    }
  }

  handleDisconnect() {
    if (this.status === 'closed') return;
    const unexpected = this.status !== 'closing';
    clearInterval(this.autosave);
    this.status = 'closed';
    for (const ws of this.viewers) if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'closed' }));
    if (manager.sessions.get(this.profileId) === this) manager.sessions.delete(this.profileId);
    // Transport dropped or Scrapfly timeout: make sure the remote browser isn't left billing.
    if (unexpected) stopRemoteSession(this.sessionId).catch(() => orphans.add(this.sessionId));
    for (const fn of this.closeListeners) fn();
    this.emit();
  }

  // save: snapshot the login first. strict: if that snapshot fails, keep the browser open and throw.
  async close({ save = true, strict = false } = {}) {
    if (this.status === 'closed' || this.status === 'closing') return;
    clearInterval(this.autosave);
    if (save) {
      try {
        await this.saveState();
      } catch (err) {
        if (strict) {
          if (this.status === 'open') this.autosave = setInterval(() => this.saveState().catch(() => {}), AUTOSAVE_MS);
          throw new Error(`Could not save the session (browser left open): ${scrub(err.message)}`);
        }
      }
    }
    await this.saveChain;
    this.status = 'closing';
    this.emit();
    try {
      // With auto_close=false, browser.close() over CDP only disconnects; the remote browser
      // must be stopped explicitly so it stops billing.
      await this.browser?.close().catch(() => {});
    } finally {
      let stopErr;
      await stopRemoteSession(this.sessionId).catch((err) => {
        stopErr = err;
        orphans.add(this.sessionId);
      });
      this.handleDisconnect();
      if (stopErr) throw new Error('Browser closed, but Scrapfly did not confirm the stop; it will be retried automatically');
    }
  }
}

// Remote sessions whose stop failed; retried periodically and on shutdown so they don't keep billing.
const orphans = new Set();
async function retryOrphans() {
  await Promise.all(
    [...orphans].map((sid) =>
      stopRemoteSession(sid, 1)
        .then(() => orphans.delete(sid))
        .catch(() => {})
    )
  );
}
setInterval(retryOrphans, 60_000).unref();

export function normalizeUrl(url) {
  const u = String(url || '').trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`;
  const parsed = new URL(withScheme);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http(s) URLs are allowed');
  return parsed.href;
}

// open/close are serialized per profile so a closing session can never race its replacement.
const ops = new Map();
function serialize(profileId, fn) {
  const prev = ops.get(profileId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  ops.set(profileId, tail);
  tail.then(() => ops.get(profileId) === tail && ops.delete(profileId));
  return next;
}

export const manager = {
  sessions: new Map(),
  get: (profileId) => manager.sessions.get(profileId),
  list: () => [...manager.sessions.values()].map((s) => s.summary()),

  // Returns an open session. With runId, also takes the run lock atomically.
  shuttingDown: false,
  open(profileId, { runId } = {}) {
    if (manager.shuttingDown) return Promise.reject(new Error('Server is shutting down'));
    return serialize(profileId, async () => {
      if (manager.shuttingDown) throw new Error('Server is shutting down');
      let s = manager.sessions.get(profileId);
      if (!s || s.status !== 'open') {
        await assertQuota();
        s = new BrowserSession(profileId);
        manager.sessions.set(profileId, s);
        s.emit();
        try {
          await s.connect();
        } catch (err) {
          s.status = 'closing';
          await s.browser?.close().catch(() => {});
          await stopRemoteSession(s.sessionId).catch(() => orphans.add(s.sessionId));
          s.handleDisconnect();
          const account = await getAccount({ fresh: true }).catch(() => null);
          throw new Error(`Could not open Scrapfly browser: ${friendlyBrowserError(err, account)}`);
        }
      }
      if (runId) {
        if (s.lockedBy) throw new Error('Another run is using this profile');
        s.lockedBy = runId;
        s.emit();
      }
      return s;
    });
  },

  // force: close even if a run holds the lock (used on shutdown).
  // expect: only close if that exact session is still current (never its replacement).
  close(profileId, { save = true, strict = false, force = false, runId, expect } = {}) {
    return serialize(profileId, async () => {
      const s = manager.sessions.get(profileId);
      if (!s || (expect && s !== expect)) return;
      if (s.lockedBy && !force && s.lockedBy !== runId) throw new Error('A task run is using this browser; stop it first');
      await s.close({ save, strict });
    });
  },

  async closeAll() {
    manager.shuttingDown = true;
    const ids = new Set([...manager.sessions.keys(), ...ops.keys()]);
    await Promise.all([...ids].map((id) => manager.close(id, { force: true }).catch(() => {})));
    await retryOrphans();
  },
};
