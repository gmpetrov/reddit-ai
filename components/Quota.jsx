import { useCallback, useEffect, useState } from 'react';
import { api } from './util';

// Scrapfly credits: browsers can't start once the plan quota is used up.
export default function Quota({ sessions }) {
  const [a, setA] = useState(null);
  const load = useCallback((fresh) => {
    api('GET', `/api/scrapfly/account${fresh ? '?fresh=1' : ''}`)
      .then(setA)
      .catch(() => setA(null));
  }, []);

  useEffect(() => {
    const t = setInterval(() => load(true), 120_000);
    return () => clearInterval(t);
  }, [load]);
  // Browsers opening/closing spend credits; the server caches the account for 60s.
  useEffect(() => load(), [load, sessions]);

  if (!a) return null;
  const out = a.remaining <= 0 && !a.extraAllowed;
  const low = !out && a.remaining < a.limit * 0.1;
  return (
    <div
      className={`quota${out ? ' out' : low ? ' warn' : ''}`}
      style={{ '--pct': `${Math.max(0, Math.min(100, (a.remaining / a.limit) * 100))}%` }}
      title={out ? 'Cloud browsers can’t start until credits reset or you upgrade.' : `${a.plan} plan`}
    >
      <span className="quota-text">
        {out
          ? `Scrapfly credits used up until ${new Date(a.resetsAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
          : `${Number(a.remaining).toLocaleString()} of ${Number(a.limit).toLocaleString()} Scrapfly credits left`}
      </span>
      <span className="quota-bar" aria-hidden="true">
        <i />
      </span>
    </div>
  );
}
