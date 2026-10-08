import { useState } from 'react';
import { api, ACTIVE, fmt, duration, plural, stripAnsi, num, usd, bytes, secs, Empty, Act } from './util';

const STATUS = {
  queued: ['agent', 'Queued'],
  running: ['agent live', 'Running'],
  waiting_human: ['hazard', 'Needs you'],
  succeeded: ['ok', 'Succeeded'],
  failed: ['err', 'Failed'],
  stopped: ['idle', 'Stopped'],
};
function StatusPill({ status }) {
  const [cls, label] = STATUS[status] || ['idle', status.replace('_', ' ')];
  return <span className={`state ${cls}`}>{label}</span>;
}

// Actions are numbered; each result, human hand-off or note attaches under the step it follows.
function StepList({ steps }) {
  const items = [];
  let n = 0;
  steps.forEach((s, i) => {
    if (s.kind === 'action') {
      n += 1;
      const args = s.args && Object.keys(s.args).length ? JSON.stringify(s.args) : '';
      items.push({ key: i, n, tool: s.tool, args, thought: s.thought, results: [], open: true });
    } else if (s.kind === 'result' && items.at(-1)?.open) {
      items.at(-1).results.push(s.text);
    } else if (s.kind === 'human') {
      items.push({ key: i, human: true, tool: 'You', note: s.text });
    } else {
      items.push({ key: i, note: s.text });
    }
  });
  return (
    <ol className="steps">
      {items.map((it) => (
        <li key={it.key} className={it.human ? 'human' : undefined}>
          <span className="n">{it.n || ''}</span>
          <div>
            {it.tool && <div className="tool">{it.tool}</div>}
            {it.args && <div className="args">{it.args}</div>}
            {it.thought && <div className="thought">{it.thought}</div>}
            {it.note != null && <div className="note">{it.note}</div>}
            {it.results?.map((r, j) => (
              <div className="res" key={j}>
                {r}
              </div>
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}

function ErrorBlock({ error }) {
  const [first, ...rest] = stripAnsi(error).trim().split('\n');
  const more = rest.join('\n').trim();
  return (
    <div className="error">
      {first}
      {more && (
        <details>
          <summary>Show details</summary>
          <pre>{more}</pre>
        </details>
      )}
    </div>
  );
}

// ---- third-party usage & cost per run ----
// Always-visible ledger on every run card: what the run consumed from each provider, and what it cost.
const SPEND_HINT = "Tokens are exact. Browser credits marked ~ are estimated from time and bandwidth with Scrapfly's published rates; dollars use your plan's price per credit.";
const None = ({ children, title }) => (
  <span className="spend-none" title={title}>
    {children}
  </span>
);

function SpendCell({ cls, label, sub, figure, lines, cost, extra }) {
  return (
    <div className={`spend-cell ${cls}`}>
      <div className="spend-label">
        {label}
        {sub && <> <span>{sub}</span></>}
      </div>
      <div className="spend-figure">{figure}</div>
      {extra}
      {lines.filter(Boolean).map((l, i) => (
        <div className="spend-line" key={i}>
          {l}
        </div>
      ))}
      {cost != null && <div className="spend-cost">{cost}</div>}
    </div>
  );
}

function AiCell({ o }) {
  if (!o?.calls) return <SpendCell cls="ai" label="AI" figure={<None>No calls</None>} lines={['The agent never asked the model for a step.']} />;
  return (
    <SpendCell
      cls="ai"
      label="AI"
      sub={o.model}
      figure={<>{num(o.inputTokens + o.outputTokens)} <small>tokens</small></>}
      lines={[
        `${num(o.inputTokens)} in${o.cachedInputTokens ? `, ${num(o.cachedInputTokens)} cached` : ''}`,
        `${num(o.outputTokens)} out${o.reasoningTokens ? `, ${num(o.reasoningTokens)} reasoning` : ''}`,
        plural(o.calls, 'model call'),
      ]}
      cost={o.costUsd != null ? usd(o.costUsd) : <None title="Add OPENAI_PRICE_*_PER_1M to .env to price tokens">No price set</None>}
    />
  );
}

function BrowserCell({ s, active }) {
  if (!s) {
    return (
      <SpendCell
        cls="browser"
        label="Browser"
        sub="Scrapfly"
        figure={<None>{active ? 'Running' : 'Not started'}</None>}
        lines={[active ? 'Time and bandwidth are measured when the run ends.' : 'No cloud browser was opened for this run.']}
      />
    );
  }
  if (s.error) return <SpendCell cls="browser" label="Browser" sub="Scrapfly" figure={<None>Unavailable</None>} lines={[s.error]} />;
  const est = s.creditsSource === 'estimate';
  const b = s.breakdown || {};
  // Split bar: how much of the bill came from time vs. data transferred.
  let bar = null;
  if (b.bandwidthCredits != null && b.timeCredits + b.bandwidthCredits > 0) {
    const t = b.timeCredits;
    const w = b.bandwidthCredits;
    const pct = (x) => Math.max((x / (t + w)) * 100, x ? 2 : 0);
    bar = (
      <>
        <div className="split" role="img" aria-label={`${t} credits for time, ${w} for bandwidth`}>
          <span className="split-time" style={{ width: `${pct(t)}%` }} />
          <span className="split-data" style={{ width: `${pct(w)}%` }} />
        </div>
        <div className="split-key">
          <span className="k-time">{num(t)} time</span>
          <span className="k-data">
            {num(w)} bandwidth at {b.bandwidthCreditsPerMb}/MB
          </span>
        </div>
      </>
    );
  }
  return (
    <SpendCell
      cls="browser"
      label="Browser"
      sub={`Scrapfly, ${s.proxyPool || 'proxy'}`}
      figure={
        s.credits != null ? (
          <>
            {est && (
              <span className="approx" title="Estimate">
                ~
              </span>
            )}
            {num(s.credits)} <small>credits</small>
          </>
        ) : (
          <None>Credits unknown</None>
        )
      }
      lines={[`${secs(s.runtimeMs)} open, ${bytes(s.bandwidthBytes)} transferred`, s.sharedSession && "Shared with a browser you had open; only this run's share is counted."]}
      cost={
        s.costUsd != null ? (
          <>
            {usd(s.costUsd)}
            {s.plan && <> <span>on {s.plan.toLowerCase()}</span></>}
          </>
        ) : null
      }
      extra={bar}
    />
  );
}

function TotalCell({ u }) {
  const aiUnpriced = u.openai?.calls && u.openai.costUsd == null;
  const note = u.totalCostUsd == null ? 'Nothing billable could be priced.' : aiUnpriced ? 'Browser only. AI tokens are not priced yet.' : 'AI and browser combined.';
  return (
    <div className="spend-cell total">
      <div className="spend-label">Total</div>
      <div className="spend-figure">{u.totalCostUsd != null ? usd(u.totalCostUsd) : <None>—</None>}</div>
      <div className="spend-line">{note}</div>
    </div>
  );
}

function SpendStrip({ r }) {
  const u = r.usage;
  const active = ACTIVE.includes(r.status);
  if (!u) {
    // Runs from before tracking existed, or still queued.
    const why = active ? 'Usage appears here once the agent takes its first step.' : 'This run happened before usage tracking was added, so nothing was recorded.';
    return (
      <section className="spend spend-empty" aria-label="Usage and cost">
        <p>{why}</p>
      </section>
    );
  }
  return (
    <section className="spend" aria-label="Usage and cost" title={SPEND_HINT}>
      <AiCell o={u.openai} />
      <BrowserCell s={u.scrapfly} active={active} />
      <TotalCell u={u} />
    </section>
  );
}

export default function Runs({ active, runs, tasks, profiles, sessionOf, act, openLive }) {
  const [logOpen, setLogOpen] = useState({}); // run id -> user's open/closed choice; running logs start open
  const taskName = (tid) => tasks.find((t) => t.id === tid)?.name || '(deleted task)';
  const profileName = (pid) => profiles.find((p) => p.id === pid)?.name || '(deleted profile)';
  // Hand-offs first, then active runs, then history (each group keeps its newest-first order).
  const rank = (r) => (r.status === 'waiting_human' ? 0 : ACTIVE.includes(r.status) ? 1 : 2);
  const sorted = [...runs].sort((a, b) => rank(a) - rank(b));
  const stop = (id) => act(() => api('POST', `/api/runs/${id}/stop`));

  return (
    <section className={`tab${active ? ' active' : ''}`}>
      <div className="section-head">
        <h1>Runs</h1>
        <p className="lede">Every time a task runs. Runs that need you rise to the top.</p>
      </div>
      <div className="list">
        {!runs.length ? (
          <Empty title="No runs yet">Run a task from the Tasks tab and follow it here, step by step.</Empty>
        ) : (
          sorted.map((r) => {
            const isActive = ACTIVE.includes(r.status);
            const waiting = r.status === 'waiting_human';
            const live = sessionOf(r.profileId);
            const actions = r.steps.filter((s) => s.kind === 'action').length;
            const took = duration(r.startedAt, r.endedAt);
            return (
              <article key={r.id} className={`item run${waiting ? ' waiting' : ''}`}>
                <div className="head">
                  <div className="meta">
                    <h3 className="title">{taskName(r.taskId)}</h3>
                    <StatusPill status={r.status} />
                  </div>
                  <div className="facts">
                    <span>{profileName(r.profileId)}</span>
                    <time dateTime={r.startedAt}>{fmt(r.startedAt).replace(/^today/, 'Today')}</time>
                    <span>{plural(actions, 'step')}</span>
                    {took && <span>{took}</span>}
                  </div>
                  {isActive && !waiting && (
                    <div className="btns">
                      {live && <button onClick={() => openLive(r.profileId)}>Watch</button>}
                      <Act className="danger" onClick={stop(r.id)}>
                        Stop
                      </Act>
                    </div>
                  )}
                </div>
                {waiting && (
                  <div className="handoff">
                    <p>
                      <strong>The agent is waiting for you</strong>
                      {r.humanRequest}
                    </p>
                    <div className="btns">
                      <button className="hazard" onClick={() => openLive(r.profileId)}>
                        Open live browser
                      </button>
                      <Act className="ghost danger" onClick={stop(r.id)}>
                        Stop run
                      </Act>
                    </div>
                  </div>
                )}
                {(r.result || r.error) && (
                  <div className="body">
                    {r.result && <div className="result">{r.result}</div>}
                    {r.error && <ErrorBlock error={r.error} />}
                  </div>
                )}
                <SpendStrip r={r} />
                {r.steps.length > 0 && (
                  <details className="log" open={r.id in logOpen ? logOpen[r.id] : r.status === 'running'} onToggle={(e) => {
                    const open = e.currentTarget.open;
                    setLogOpen((m) => (m[r.id] === open ? m : { ...m, [r.id]: open }));
                  }}>
                    <summary>Step log</summary>
                    <StepList steps={r.steps} />
                  </details>
                )}
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
