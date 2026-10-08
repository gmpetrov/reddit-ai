'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './util';
import Profiles from './Profiles';
import Tasks from './Tasks';
import Runs from './Runs';
import LiveBrowser from './LiveBrowser';
import Quota from './Quota';

// Keep whichever copy of a run is newer, so a slow snapshot can't undo a live SSE update.
function mergeRuns(known, fresh) {
  const byId = new Map(known.map((r) => [r.id, r]));
  return fresh.map((r) => (byId.get(r.id)?.rev > r.rev ? byId.get(r.id) : r));
}

const TABS = [
  ['profiles', 'Profiles'],
  ['tasks', 'Tasks'],
  ['runs', 'Runs'],
];

export default function App() {
  const [data, setData] = useState({ profiles: [], tasks: [], runs: [], sessions: [] });
  const [tab, setTab] = useState('profiles');
  const [liveId, setLiveId] = useState(null);
  const [toastMsg, setToastMsg] = useState(null);
  const toastTimer = useRef();

  const toast = useCallback((msg) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 4000);
  }, []);

  const loadAll = useCallback(async () => {
    const [profiles, tasks, runs, sessions] = await Promise.all([
      api('GET', '/api/profiles'),
      api('GET', '/api/tasks'),
      api('GET', '/api/runs'),
      api('GET', '/api/sessions'),
    ]);
    setData((d) => ({ profiles, tasks, sessions, runs: mergeRuns(d.runs, runs) }));
  }, []);

  // Runs fn, reports errors as a toast, then refreshes everything.
  const act = useCallback(
    (fn) => async (...a) => {
      try {
        await fn(...a);
        await loadAll();
      } catch (e) {
        toast(e.message);
      }
    },
    [loadAll, toast]
  );

  // ---- live events ----
  useEffect(() => {
    loadAll().catch((e) => toast(e.message));
    const es = new EventSource('/api/events');
    // (Re)connected: refetch everything so events missed while disconnected aren't lost.
    es.addEventListener('open', () => loadAll().catch(() => {}));
    es.addEventListener('run', (e) => {
      const r = JSON.parse(e.data);
      setData((d) => {
        const i = d.runs.findIndex((x) => x.id === r.id);
        if (i >= 0 && d.runs[i].rev > r.rev) return d;
        const runs = i >= 0 ? d.runs.with(i, r) : [r, ...d.runs];
        return { ...d, runs };
      });
      if (r.status === 'waiting_human') toast(`The agent needs you: ${r.humanRequest}`);
    });
    es.addEventListener('sessions', (e) => {
      const sessions = JSON.parse(e.data);
      setData((d) => ({ ...d, sessions }));
      api('GET', '/api/profiles')
        .then((profiles) => setData((d) => ({ ...d, profiles })))
        .catch(() => {});
    });
    return () => es.close();
  }, [loadAll, toast]);

  const waiting = data.runs.filter((r) => r.status === 'waiting_human').length;
  useEffect(() => {
    document.title = waiting ? `(${waiting}) Needs you · Browser Agent` : 'Browser Agent';
  }, [waiting]);

  const sessionOf = (pid) => data.sessions.find((s) => s.profileId === pid);
  const counts = { profiles: data.profiles.length, tasks: data.tasks.length, runs: waiting ? 0 : data.runs.length };
  const ctx = { ...data, sessionOf, act, toast, loadAll, openLive: setLiveId, showTab: setTab };

  return (
    <>
      <header className="top">
        <div className="brand">
          <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="2.5" y="4" width="19" height="16" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M2.5 9h19" stroke="currentColor" strokeWidth="1.8" />
            <circle cx="12" cy="14.5" r="2.4" fill="var(--agent)" />
          </svg>
          <span>Browser Agent</span>
        </div>
        <nav aria-label="Sections">
          {TABS.map(([key, label]) => (
            <button key={key} className={tab === key ? 'active' : undefined} aria-current={tab === key ? 'page' : undefined} onClick={() => setTab(key)}>
              {label} <span className="count">{counts[key] || ''}</span>
              {key === 'runs' && waiting > 0 && <span className="needs">{`${waiting} need${waiting === 1 ? 's' : ''} you`}</span>}
            </button>
          ))}
        </nav>
        <Quota sessions={data.sessions} />
      </header>

      <main>
        <Profiles active={tab === 'profiles'} {...ctx} />
        <Tasks active={tab === 'tasks'} {...ctx} />
        <Runs active={tab === 'runs'} {...ctx} />
      </main>

      {liveId && <LiveBrowser key={liveId} profileId={liveId} onHide={() => setLiveId(null)} {...ctx} />}

      <div className={`toast${toastMsg ? '' : ' hidden'}`} role="status" aria-live="polite">
        {toastMsg}
      </div>
    </>
  );
}
