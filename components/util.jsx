import { useState } from 'react';

export async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export const ACTIVE = ['queued', 'running', 'waiting_human'];

const sameDay = (d) => d.toDateString() === new Date().toDateString();
export const fmt = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return sameDay(d)
    ? `today at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
export const duration = (a, b) => {
  if (!a || !b) return '';
  const s = Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const stripAnsi = (s) => String(s ?? '').replace(/\u001b\[[0-9;]*m/g, '');

export const num = (n) => Number(n || 0).toLocaleString();
export const usd = (n) => (n == null ? null : n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
export const bytes = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.ceil((b || 0) / 1024)} KB`);
export const secs = (ms) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${Math.round((ms || 0) / 1000)}s`);

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

// A button that disables itself while its (async) action runs.
export function Act({ onClick, disabled, ...props }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      {...props}
      disabled={disabled || busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
