// Bridge between the custom server (server.js) and Next.js route handlers.
// Next bundles route handlers separately, so if they imported lib/store.js etc. directly they would
// get their own copies of the database, browser manager and active runs. Instead server.js loads
// those modules once and registers them here; route handlers only read this registry.
const KEY = Symbol.for('browser-agent.runtime');

export function register(services) {
  globalThis[KEY] = services;
}

export function runtime() {
  const r = globalThis[KEY];
  if (!r) throw new Error('Runtime not initialized: start the app with `npm run dev` or `npm start` (server.js), not `next dev`');
  return r;
}
