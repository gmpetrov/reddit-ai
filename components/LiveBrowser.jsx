import { useEffect, useRef, useState } from 'react';
import { api } from './util';

const buttonName = (b) => ['left', 'middle', 'right'][b] || 'left';

// Live view of a profile's cloud browser over a websocket, with remote mouse/keyboard (human in the loop).
export default function LiveBrowser({ profileId, sessionOf, runs, onHide, act, toast }) {
  const s = sessionOf(profileId);
  const waitingRun = runs.find((r) => r.profileId === profileId && r.status === 'waiting_human');
  const [frame, setFrame] = useState(null);
  const [msg, setMsg] = useState('Connecting to the browser…');
  const [url, setUrl] = useState('');
  const ws = useRef(null);
  const dims = useRef({ w: 1280, h: 800 });
  const lastMove = useRef(0);
  const screenRef = useRef(null);
  const frameRef = useRef(null);
  const urlRef = useRef(null);

  const send = (ev) => {
    if (ws.current?.readyState === 1) ws.current.send(JSON.stringify(ev));
  };

  useEffect(() => {
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/live/${profileId}`);
    ws.current = sock;
    sock.onmessage = (m) => {
      const data = JSON.parse(m.data);
      if (data.type === 'frame') {
        dims.current = { w: data.width, h: data.height };
        setFrame(data.data);
        setMsg(null);
      } else if (data.type === 'closed') setMsg('This browser was closed.');
      else if (data.type === 'error') toast(data.message);
    };
    sock.onclose = () => {
      if (ws.current === sock) setMsg((m) => m || 'Disconnected from the browser.');
    };
    screenRef.current?.focus();
    return () => {
      ws.current = null;
      sock.close();
    };
  }, [profileId, toast]);

  // Follow the remote URL unless the user is typing a new one.
  useEffect(() => {
    if (s?.url && document.activeElement !== urlRef.current) setUrl(s.url);
  }, [s?.url]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && document.activeElement !== screenRef.current) onHide();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onHide]);

  // React wheel listeners are passive; this one must be able to preventDefault.
  useEffect(() => {
    const img = frameRef.current;
    const onWheel = (e) => {
      e.preventDefault();
      send({ type: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY, ...coords(e) });
    };
    img.addEventListener('wheel', onWheel, { passive: false });
    return () => img.removeEventListener('wheel', onWheel);
  }, []);

  function coords(e) {
    const rect = frameRef.current.getBoundingClientRect();
    return { x: Math.round(((e.clientX - rect.left) / rect.width) * dims.current.w), y: Math.round(((e.clientY - rect.top) / rect.height) * dims.current.h) };
  }

  const agentDriving = s?.lockedBy && !waitingRun;
  const driver = !s ? ['closed', 'Closed'] : agentDriving ? ['agent', 'Agent is driving'] : ['you', 'You’re driving'];

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Live browser">
      <div className="live-panel">
        <div className="live-bar">
          <button className="icon" aria-label="Back" title="Back" onClick={() => send({ type: 'back' })}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button className="icon" aria-label="Reload" title="Reload" onClick={() => send({ type: 'reload' })}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M15.5 10a5.5 5.5 0 1 1-1.8-4.07M15.5 3.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send({ type: 'navigate', url });
              screenRef.current.focus();
            }}
          >
            <input ref={urlRef} name="url" className="mono" placeholder="Go to a URL" aria-label="URL" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} />
          </form>
          <span className={`driver ${driver[0]}`}>{driver[1]}</span>
          <span className="expires">{s?.expiresAt ? `Session ends ${new Date(s.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</span>
          <div className="live-actions">
            <button
              className="ghost"
              onClick={act(async () => {
                await api('POST', `/api/profiles/${profileId}/save`);
                toast('Login saved');
              })}
            >
              Save login
            </button>
            <button
              disabled={!s || !!s.lockedBy}
              onClick={act(async () => {
                onHide();
                await api('POST', `/api/profiles/${profileId}/close`, { save: true });
                toast('Login saved and browser closed');
              })}
            >
              Save and close browser
            </button>
            <button className="icon" aria-label="Hide viewer. The browser keeps running." title="Hide viewer (browser keeps running)" onClick={onHide}>
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="m5.5 5.5 9 9m0-9-9 9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
        {waitingRun && (
          <div className="hitl">
            <div className="hitl-text">
              <strong>The agent handed you control.</strong>
              <span>{waitingRun.humanRequest}</span>
            </div>
            <form
              className="hitl-form"
              onSubmit={act(async (e) => {
                e.preventDefault();
                const f = e.currentTarget;
                await api('POST', `/api/runs/${waitingRun.id}/resume`, { note: new FormData(f).get('note') });
                f.reset();
                toast('Control returned to the agent');
              })}
            >
              <input name="note" placeholder="Note for the agent, e.g. “logged in” or “yes, post it”" aria-label="Note for the agent" />
              <button className="hazard">Give control back</button>
            </form>
          </div>
        )}
        <div
          id="screen"
          ref={screenRef}
          tabIndex={0}
          aria-label="Remote browser screen. Click to focus for keyboard input."
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') return; // let paste event handle it
            e.preventDefault();
            if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
            send({ type: 'key', key: e.key, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey });
          }}
          onPaste={(e) => {
            e.preventDefault();
            send({ type: 'text', text: e.clipboardData.getData('text') });
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- live screencast frames */}
          <img
            id="frame"
            ref={frameRef}
            alt=""
            draggable={false}
            src={frame ? `data:image/jpeg;base64,${frame}` : undefined}
            onMouseMove={(e) => {
              if (Date.now() - lastMove.current < 60) return;
              lastMove.current = Date.now();
              send({ type: 'mousemove', ...coords(e) });
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              screenRef.current.focus();
              send({ type: 'mousedown', button: buttonName(e.button), ...coords(e) });
            }}
            onMouseUp={(e) => send({ type: 'mouseup', button: buttonName(e.button), ...coords(e) })}
            onContextMenu={(e) => e.preventDefault()}
          />
          <div className={`screen-msg${msg ? '' : ' hidden'}`}>{msg}</div>
        </div>
        <form
          className="live-type"
          onSubmit={(e) => {
            e.preventDefault();
            const input = e.currentTarget.elements.namedItem('text');
            send({ type: 'text', text: input.value });
            input.value = '';
            screenRef.current.focus();
          }}
        >
          <input name="text" type="password" placeholder="Type into the focused field: passwords, codes. Not shown or stored." autoComplete="off" aria-label="Text to send" />
          <button>Send text</button>
          <span className="hint">Click the page to type into it directly.</span>
        </form>
      </div>
    </div>
  );
}
