const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = { profiles: [], tasks: [], runs: [], sessions: [] };

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}
const guard = (fn) => async (...a) => {
  try {
    await fn(...a);
  } catch (e) {
    toast(e.message);
  }
};

// ---- tabs ----
document.querySelectorAll('nav button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((x) => {
      x.classList.toggle('active', x === b);
      if (x === b) x.setAttribute('aria-current', 'page');
      else x.removeAttribute('aria-current');
    });
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
  })
);
const showTab = (name) => document.querySelector(`nav button[data-tab="${name}"]`).click();

// ---- data ----
// Keep whichever copy of a run is newer, so a slow snapshot can't undo a live SSE update.
function mergeRuns(fresh) {
  const known = new Map(state.runs.map((r) => [r.id, r]));
  return fresh.map((r) => (known.get(r.id)?.rev > r.rev ? known.get(r.id) : r));
}

async function loadAll() {
  let runs;
  [state.profiles, state.tasks, runs, state.sessions] = await Promise.all([
    api('GET', '/api/profiles'),
    api('GET', '/api/tasks'),
    api('GET', '/api/runs'),
    api('GET', '/api/sessions'),
  ]);
  state.runs = mergeRuns(runs);
  render();
}

const sessionOf = (pid) => state.sessions.find((s) => s.profileId === pid);
const profileName = (pid) => state.profiles.find((p) => p.id === pid)?.name || '(deleted profile)';
const taskName = (tid) => state.tasks.find((t) => t.id === tid)?.name || '(deleted task)';
const sameDay = (d) => d.toDateString() === new Date().toDateString();
const fmt = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return sameDay(d)
    ? `today at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const duration = (a, b) => {
  if (!a || !b) return '';
  const s = Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const stripAnsi = (s) => String(s ?? '').replace(/\u001b\[[0-9;]*m/g, '');
const empty = (title, body) => `<div class="empty"><strong>${title}</strong>${body}</div>`;

function render() {
  renderProfiles();
  renderTasks();
  renderRuns();
  renderCounts();
  updateLiveStatus();
  updateLiveHitl();
}

function renderCounts() {
  $('#count-profiles').textContent = state.profiles.length || '';
  $('#count-tasks').textContent = state.tasks.length || '';
  const waiting = state.runs.filter((r) => r.status === 'waiting_human').length;
  $('#count-runs').textContent = waiting ? '' : state.runs.length || '';
  const badge = $('#needs-badge');
  badge.classList.toggle('hidden', !waiting);
  badge.textContent = waiting ? `${waiting} need${waiting === 1 ? 's' : ''} you` : '';
  document.title = waiting ? `(${waiting}) Needs you · Browser Agent` : 'Browser Agent';
}

function profileState(p, s) {
  if (s?.lockedBy) return '<span class="state agent live">Agent is using this browser</span>';
  if (s) return '<span class="state agent live">Browser open</span>';
  if (p.hasSavedSession) return `<span class="state ok">Login saved ${esc(fmt(p.savedAt))}</span>`;
  return '<span class="state idle">Not logged in</span>';
}

function renderProfiles() {
  const el = $('#profiles');
  if (!state.profiles.length)
    return (el.innerHTML = empty('No profiles yet', 'Add one above with its login page, for example https://www.reddit.com/login.'));
  el.innerHTML = state.profiles
    .map((p) => {
      const s = sessionOf(p.id);
      return `<div class="item">
        <div class="meta">
          <div class="title">${esc(p.name)}</div>
          <div>${profileState(p, s)}</div>
          ${p.startUrl ? `<div class="url">${esc(p.startUrl)}</div>` : ''}
        </div>
        <div class="btns">
          ${s ? `<button class="primary" data-act="view" data-id="${p.id}">View browser</button>
                 <button data-act="close" data-id="${p.id}" ${s.lockedBy ? 'disabled title="The agent is using this browser"' : ''}>Save and close</button>`
              : `<button class="primary" data-act="open" data-id="${p.id}">${p.hasSavedSession ? 'Open browser' : 'Open and log in'}</button>`}
          ${p.hasSavedSession && !s ? `<button class="ghost" data-act="clear" data-id="${p.id}">Forget login</button>` : ''}
          <button class="ghost danger" data-act="delete" data-id="${p.id}">Delete</button>
        </div></div>`;
    })
    .join('');
}

function renderTasks() {
  const sel = $('#task-form [name=profileId]');
  const cur = sel.value;
  sel.innerHTML = `<option value="">${state.profiles.length ? 'Choose a profile' : 'Add a profile first'}</option>` + state.profiles.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  sel.value = cur;
  const el = $('#tasks');
  if (!state.tasks.length) return (el.innerHTML = empty('No tasks yet', 'Write your first one above. The agent can browse, click, type and scroll, and it asks before anything it can’t do alone.'));
  el.innerHTML = state.tasks
    .map((t) => {
      const busy = state.runs.some((r) => r.taskId === t.id && ['queued', 'running', 'waiting_human'].includes(r.status));
      return `<div class="item">
        <div class="meta">
          <div class="title">${esc(t.name)} <span class="chip">${esc(profileName(t.profileId))}</span></div>
          <div class="sub clamp">${esc(t.instructions)}</div>
        </div>
        <div class="btns">
          <button class="primary" data-act="run" data-id="${t.id}" ${busy ? 'disabled title="Already running"' : ''}>${busy ? 'Running' : 'Run'}</button>
          <button data-act="edit" data-id="${t.id}">Edit</button>
          <button class="ghost danger" data-act="delete-task" data-id="${t.id}">Delete</button>
        </div></div>`;
    })
    .join('');
}

const STATUS = {
  queued: ['agent', 'Queued'],
  running: ['agent live', 'Running'],
  waiting_human: ['hazard', 'Needs you'],
  succeeded: ['ok', 'Succeeded'],
  failed: ['err', 'Failed'],
  stopped: ['idle', 'Stopped'],
};
const statusPill = (s) => {
  const [cls, label] = STATUS[s] || ['idle', s.replace('_', ' ')];
  return `<span class="state ${cls}">${esc(label)}</span>`;
};

// Actions are numbered; each result, human hand-off or note attaches under the step it follows.
function stepList(steps) {
  const items = [];
  let n = 0;
  for (const s of steps) {
    if (s.kind === 'action') {
      n += 1;
      const args = s.args && Object.keys(s.args).length ? JSON.stringify(s.args) : '';
      items.push({ html: `<li><span class="n">${n}</span><div><div class="tool">${esc(s.tool)}</div>${args ? `<div class="args">${esc(args)}</div>` : ''}${s.thought ? `<div class="thought">${esc(s.thought)}</div>` : ''}`, open: true });
    } else if (s.kind === 'result' && items.at(-1)?.open) {
      items.at(-1).html += `<div class="res">${esc(s.text)}</div>`;
    } else if (s.kind === 'human') {
      items.push({ html: `<li class="human"><span class="n"></span><div><div class="tool">You</div><div class="note">${esc(s.text)}</div>`, open: false });
    } else {
      items.push({ html: `<li><span class="n"></span><div><div class="note">${esc(s.text)}</div>`, open: false });
    }
  }
  return items.map((i) => `${i.html}</div></li>`).join('');
}

function errorBlock(err) {
  const text = stripAnsi(err).trim();
  const [first, ...rest] = text.split('\n');
  const more = rest.join('\n').trim();
  return `<div class="error">${esc(first)}${more ? `<details><summary>Show details</summary><pre>${esc(more)}</pre></details>` : ''}</div>`;
}

// ---- third-party usage & cost per run ----
const num = (n) => Number(n || 0).toLocaleString();
const usd = (n) => (n == null ? null : n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const bytes = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.ceil((b || 0) / 1024)} KB`);
const secs = (ms) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${Math.round((ms || 0) / 1000)}s`);

// Always-visible ledger on every run card: what the run consumed from each provider, and what it cost.
const SPEND_HINT = 'Tokens are exact. Browser credits marked ~ are estimated from time and bandwidth with Scrapfly\'s published rates; dollars use your plan\'s price per credit.';

function spendCell(cls, label, sub, figure, lines, cost, extra = '') {
  return `<div class="spend-cell ${cls}">
    <div class="spend-label">${label}${sub ? ` <span>${sub}</span>` : ''}</div>
    <div class="spend-figure">${figure}</div>
    ${extra}
    ${lines.filter(Boolean).map((l) => `<div class="spend-line">${l}</div>`).join('')}
    ${cost != null ? `<div class="spend-cost">${cost}</div>` : ''}
  </div>`;
}

function aiCell(o) {
  if (!o?.calls) return spendCell('ai', 'AI', '', '<span class="spend-none">No calls</span>', ['The agent never asked the model for a step.'], null);
  return spendCell(
    'ai',
    'AI',
    esc(o.model),
    `${num(o.inputTokens + o.outputTokens)} <small>tokens</small>`,
    [
      `${num(o.inputTokens)} in${o.cachedInputTokens ? `, ${num(o.cachedInputTokens)} cached` : ''}`,
      `${num(o.outputTokens)} out${o.reasoningTokens ? `, ${num(o.reasoningTokens)} reasoning` : ''}`,
      plural(o.calls, 'model call'),
    ],
    o.costUsd != null ? usd(o.costUsd) : '<span class="spend-none" title="Add OPENAI_PRICE_*_PER_1M to .env to price tokens">No price set</span>'
  );
}

function browserCell(s, active) {
  if (!s) {
    return spendCell('browser', 'Browser', 'Scrapfly', `<span class="spend-none">${active ? 'Running' : 'Not started'}</span>`,
      [active ? 'Time and bandwidth are measured when the run ends.' : 'No cloud browser was opened for this run.'], null);
  }
  if (s.error) return spendCell('browser', 'Browser', 'Scrapfly', '<span class="spend-none">Unavailable</span>', [esc(s.error)], null);
  const est = s.creditsSource === 'estimate';
  const b = s.breakdown || {};
  // Split bar: how much of the bill came from time vs. data transferred.
  let bar = '';
  if (b.bandwidthCredits != null && b.timeCredits + b.bandwidthCredits > 0) {
    const t = b.timeCredits, w = b.bandwidthCredits, pct = (x) => Math.max((x / (t + w)) * 100, x ? 2 : 0);
    bar = `<div class="split" role="img" aria-label="${t} credits for time, ${w} for bandwidth">
      <span class="split-time" style="width:${pct(t)}%"></span><span class="split-data" style="width:${pct(w)}%"></span>
    </div>
    <div class="split-key"><span class="k-time">${num(t)} time</span><span class="k-data">${num(w)} bandwidth at ${b.bandwidthCreditsPerMb}/MB</span></div>`;
  }
  return spendCell(
    'browser',
    'Browser',
    `Scrapfly, ${esc(s.proxyPool || 'proxy')}`,
    s.credits != null ? `${est ? '<span class="approx" title="Estimate">~</span>' : ''}${num(s.credits)} <small>credits</small>` : '<span class="spend-none">Credits unknown</span>',
    [`${secs(s.runtimeMs)} open, ${bytes(s.bandwidthBytes)} transferred`, s.sharedSession ? 'Shared with a browser you had open; only this run\'s share is counted.' : ''],
    s.costUsd != null ? `${usd(s.costUsd)}${s.plan ? ` <span>on ${esc(s.plan.toLowerCase())}</span>` : ''}` : null,
    bar
  );
}

function totalCell(u) {
  const aiUnpriced = u.openai?.calls && u.openai.costUsd == null;
  const figure = u.totalCostUsd != null ? usd(u.totalCostUsd) : '<span class="spend-none">—</span>';
  const note = u.totalCostUsd == null ? 'Nothing billable could be priced.' : aiUnpriced ? 'Browser only. AI tokens are not priced yet.' : 'AI and browser combined.';
  return `<div class="spend-cell total"><div class="spend-label">Total</div><div class="spend-figure">${figure}</div><div class="spend-line">${note}</div></div>`;
}

function spendStrip(r) {
  const u = r.usage;
  if (!u) {
    // Runs from before tracking existed, or still queued.
    const why = ACTIVE.includes(r.status) ? 'Usage appears here once the agent takes its first step.' : 'This run happened before usage tracking was added, so nothing was recorded.';
    return `<section class="spend spend-empty" aria-label="Usage and cost"><p>${why}</p></section>`;
  }
  return `<section class="spend" aria-label="Usage and cost" title="${SPEND_HINT}">
    ${aiCell(u.openai)}${browserCell(u.scrapfly, ACTIVE.includes(r.status))}${totalCell(u)}
  </section>`;
}

const logOpen = new Map(); // run id -> user's open/closed choice; running logs start open
const ACTIVE = ['queued', 'running', 'waiting_human'];
function renderRuns() {
  const el = $('#runs');
  if (!state.runs.length) return (el.innerHTML = empty('No runs yet', 'Run a task from the Tasks tab and follow it here, step by step.'));
  // Hand-offs first, then active runs, then history (each group keeps its newest-first order).
  const rank = (r) => (r.status === 'waiting_human' ? 0 : ACTIVE.includes(r.status) ? 1 : 2);
  const runs = [...state.runs].sort((a, b) => rank(a) - rank(b));
  el.innerHTML = runs
    .map((r) => {
      const active = ACTIVE.includes(r.status);
      const live = sessionOf(r.profileId);
      const actions = r.steps.filter((s) => s.kind === 'action').length;
      const took = duration(r.startedAt, r.endedAt);
      return `<article class="item run ${r.status === 'waiting_human' ? 'waiting' : ''}" data-run="${r.id}">
        <div class="head">
          <div class="meta">
            <h3 class="title">${esc(taskName(r.taskId))}</h3>
            ${statusPill(r.status)}
          </div>
          <div class="facts">
            <span>${esc(profileName(r.profileId))}</span>
            <time datetime="${esc(r.startedAt)}">${esc(fmt(r.startedAt).replace(/^today/, 'Today'))}</time>
            <span>${plural(actions, 'step')}</span>
            ${took ? `<span>${took}</span>` : ''}
          </div>
          ${active && r.status !== 'waiting_human' ? `<div class="btns">
            ${live ? `<button data-act="view" data-id="${r.profileId}">Watch</button>` : ''}
            <button class="danger" data-act="stop-run" data-id="${r.id}">Stop</button>
          </div>` : ''}
        </div>
        ${r.status === 'waiting_human' ? `<div class="handoff">
          <p><strong>The agent is waiting for you</strong>${esc(r.humanRequest)}</p>
          <div class="btns">
            <button class="hazard" data-act="view" data-id="${r.profileId}">Open live browser</button>
            <button class="ghost danger" data-act="stop-run" data-id="${r.id}">Stop run</button>
          </div>
        </div>` : ''}
        ${r.result || r.error ? `<div class="body">
          ${r.result ? `<div class="result">${esc(r.result)}</div>` : ''}
          ${r.error ? errorBlock(r.error) : ''}
        </div>` : ''}
        ${spendStrip(r)}
        ${r.steps.length ? `<details class="log" ${(logOpen.has(r.id) ? logOpen.get(r.id) : r.status === 'running') ? 'open' : ''} data-details="${r.id}"><summary>Step log</summary><ol class="steps">${stepList(r.steps)}</ol></details>` : ''}
      </article>`;
    })
    .join('');
  el.querySelectorAll('details[data-details]').forEach((d) => d.addEventListener('toggle', () => logOpen.set(d.dataset.details, d.open)));
}

// ---- actions ----
document.addEventListener('click', guard(async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  b.disabled = true;
  try {
    switch (b.dataset.act) {
      case 'open':
        toast('Starting the cloud browser. This can take about 20 seconds.');
        await api('POST', `/api/profiles/${id}/open`);
        await loadAll();
        openLive(id);
        break;
      case 'view':
        openLive(id);
        break;
      case 'close':
        await api('POST', `/api/profiles/${id}/close`, { save: true });
        toast('Login saved and browser closed');
        break;
      case 'clear':
        if (!confirm('Forget the saved login? You’ll need to sign in again next time.')) break;
        await api('POST', `/api/profiles/${id}/clear`);
        break;
      case 'delete':
        if (!confirm('Delete this profile and its saved login?')) break;
        await api('DELETE', `/api/profiles/${id}`);
        break;
      case 'run':
        await api('POST', `/api/tasks/${id}/run`);
        showTab('runs');
        break;
      case 'edit':
        editTask(id);
        break;
      case 'delete-task':
        if (!confirm('Delete this task?')) break;
        await api('DELETE', `/api/tasks/${id}`);
        break;
      case 'stop-run':
        await api('POST', `/api/runs/${id}/stop`);
        break;
    }
  } finally {
    b.disabled = false;
  }
  await loadAll();
}));

$('#profile-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const f = e.target;
  await api('POST', '/api/profiles', { name: f.name.value, startUrl: f.startUrl.value });
  f.reset();
  await loadAll();
}));

function editTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  const f = $('#task-form');
  for (const k of ['id', 'name', 'profileId', 'startUrl', 'maxSteps', 'instructions']) f[k].value = t[k] ?? '';
  $('#task-submit').textContent = 'Save changes';
  $('#task-form-title').textContent = `Edit ${t.name}`;
  f.classList.add('editing');
  $('#task-cancel').classList.remove('hidden');
  f.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  f.instructions.focus({ preventScroll: true });
}
function resetTaskForm() {
  const f = $('#task-form');
  f.reset();
  f.id.value = '';
  $('#task-submit').textContent = 'Create task';
  $('#task-form-title').textContent = 'New task';
  f.classList.remove('editing');
  $('#task-cancel').classList.add('hidden');
}
$('#task-cancel').addEventListener('click', resetTaskForm);
$('#task-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { name: f.name.value, profileId: f.profileId.value, startUrl: f.startUrl.value, maxSteps: f.maxSteps.value, instructions: f.instructions.value };
  if (f.id.value) await api('PUT', `/api/tasks/${f.id.value}`, body);
  else await api('POST', '/api/tasks', body);
  toast(f.id.value ? 'Changes saved' : 'Task created');
  resetTaskForm();
  await loadAll();
}));

// ---- live events ----
const es = new EventSource('/api/events');
// (Re)connected: refetch everything so events missed while disconnected aren't lost.
es.addEventListener('open', () => loadAll().catch(() => {}));
es.addEventListener('run', (e) => {
  const r = JSON.parse(e.data);
  const i = state.runs.findIndex((x) => x.id === r.id);
  if (i >= 0 && state.runs[i].rev > r.rev) return;
  if (i >= 0) state.runs[i] = r;
  else state.runs.unshift(r);
  if (r.status === 'waiting_human') toast(`The agent needs you: ${r.humanRequest}`);
  render();
});
es.addEventListener('sessions', (e) => {
  state.sessions = JSON.parse(e.data);
  api('GET', '/api/profiles').then((p) => ((state.profiles = p), render())).catch(() => {});
  updateLiveStatus();
});

// ---- live browser viewer (human in the loop) ----
const live = { ws: null, profileId: null, w: 1280, h: 800 };
const frame = $('#frame');
const screen = $('#screen');

function openLive(profileId) {
  closeLiveSocket();
  live.profileId = profileId;
  $('#live').classList.remove('hidden');
  $('#screen-msg').textContent = 'Connecting to the browser…';
  $('#screen-msg').classList.remove('hidden');
  frame.removeAttribute('src');
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/live/${profileId}`);
  live.ws = ws;
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === 'frame') {
      frame.src = `data:image/jpeg;base64,${msg.data}`;
      live.w = msg.width;
      live.h = msg.height;
      $('#screen-msg').classList.add('hidden');
    } else if (msg.type === 'closed') {
      $('#screen-msg').textContent = 'This browser was closed.';
      $('#screen-msg').classList.remove('hidden');
    } else if (msg.type === 'error') toast(msg.message);
  };
  ws.onclose = () => {
    if (live.ws === ws) $('#screen-msg').classList.remove('hidden');
  };
  updateLiveStatus();
  updateLiveHitl();
  screen.focus();
}
function closeLiveSocket() {
  if (live.ws) live.ws.close();
  live.ws = null;
}
function hideLive() {
  closeLiveSocket();
  live.profileId = null;
  $('#live').classList.add('hidden');
}
function send(ev) {
  if (live.ws?.readyState === 1) live.ws.send(JSON.stringify(ev));
}
function updateLiveStatus() {
  if (!live.profileId) return;
  const s = sessionOf(live.profileId);
  const waiting = state.runs.some((r) => r.profileId === live.profileId && r.status === 'waiting_human');
  const st = $('#live-status');
  st.textContent = !s ? 'Closed' : s.lockedBy && !waiting ? 'Agent is driving' : 'You’re driving';
  st.className = `driver ${!s ? 'closed' : s.lockedBy && !waiting ? 'agent' : 'you'}`;
  $('#live-expires').textContent = s?.expiresAt ? `Session ends ${new Date(s.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
  $('#live-close').disabled = !s || !!s.lockedBy;
  const urlInput = $('#live-nav [name=url]');
  if (s?.url && document.activeElement !== urlInput) urlInput.value = s.url;
}
function updateLiveHitl() {
  const r = live.profileId && state.runs.find((x) => x.profileId === live.profileId && x.status === 'waiting_human');
  $('#live-hitl').classList.toggle('hidden', !r);
  if (r) {
    $('#live-hitl-reason').textContent = r.humanRequest;
    $('#live-resume').dataset.run = r.id;
  }
}

function coords(e) {
  const rect = frame.getBoundingClientRect();
  return { x: Math.round(((e.clientX - rect.left) / rect.width) * live.w), y: Math.round(((e.clientY - rect.top) / rect.height) * live.h) };
}
const buttonName = (b) => ['left', 'middle', 'right'][b] || 'left';
let lastMove = 0;
frame.addEventListener('mousemove', (e) => {
  if (Date.now() - lastMove < 60) return;
  lastMove = Date.now();
  send({ type: 'mousemove', ...coords(e) });
});
frame.addEventListener('mousedown', (e) => {
  e.preventDefault();
  screen.focus();
  send({ type: 'mousedown', button: buttonName(e.button), ...coords(e) });
});
frame.addEventListener('mouseup', (e) => send({ type: 'mouseup', button: buttonName(e.button), ...coords(e) }));
frame.addEventListener('contextmenu', (e) => e.preventDefault());
frame.addEventListener('wheel', (e) => {
  e.preventDefault();
  send({ type: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY, ...coords(e) });
}, { passive: false });
screen.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') return; // let paste event handle it
  e.preventDefault();
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
  send({ type: 'key', key: e.key, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey });
});
screen.addEventListener('paste', (e) => {
  e.preventDefault();
  send({ type: 'text', text: e.clipboardData.getData('text') });
});

$('#live-nav').addEventListener('submit', (e) => {
  e.preventDefault();
  send({ type: 'navigate', url: e.target.url.value });
  screen.focus();
});
$('#live-back').addEventListener('click', () => send({ type: 'back' }));
$('#live-reload').addEventListener('click', () => send({ type: 'reload' }));
$('#live-type').addEventListener('submit', (e) => {
  e.preventDefault();
  send({ type: 'text', text: e.target.text.value });
  e.target.text.value = '';
  screen.focus();
});
$('#live-hide').addEventListener('click', hideLive);
$('#live-save').addEventListener('click', guard(async () => {
  await api('POST', `/api/profiles/${live.profileId}/save`);
  toast('Login saved');
}));
$('#live-close').addEventListener('click', guard(async () => {
  const pid = live.profileId;
  hideLive();
  await api('POST', `/api/profiles/${pid}/close`, { save: true });
  toast('Login saved and browser closed');
  await loadAll();
}));
$('#live-resume').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  await api('POST', `/api/runs/${e.target.dataset.run}/resume`, { note: e.target.note.value });
  e.target.note.value = '';
  toast('Control returned to the agent');
}));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#live').classList.contains('hidden') && document.activeElement !== screen) hideLive();
});

// Scrapfly credits: browsers can't start once the plan quota is used up.
async function loadQuota(fresh) {
  const el = $('#quota');
  try {
    const a = await api('GET', `/api/scrapfly/account${fresh ? '?fresh=1' : ''}`);
    const out = a.remaining <= 0 && !a.extraAllowed;
    const low = !out && a.remaining < a.limit * 0.1;
    el.querySelector('.quota-text').textContent = out
      ? `Scrapfly credits used up until ${new Date(a.resetsAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
      : `${Number(a.remaining).toLocaleString()} of ${Number(a.limit).toLocaleString()} Scrapfly credits left`;
    el.style.setProperty('--pct', `${Math.max(0, Math.min(100, (a.remaining / a.limit) * 100))}%`);
    el.className = `quota ${out ? 'out' : low ? 'warn' : ''}`;
    el.title = out ? 'Cloud browsers can’t start until credits reset or you upgrade.' : `${a.plan} plan`;
  } catch {
    el.classList.add('hidden');
  }
}
loadQuota();
setInterval(() => loadQuota(true), 120_000);
es.addEventListener('sessions', () => loadQuota());

loadAll().catch((e) => toast(e.message));
