// Helpers shared by the route handlers in app/api. Must not import the stateful lib modules
// (see lib/runtime.js); everything stateful comes from runtime().
import { runtime } from './runtime.js';

const MAX_BODY = 200 * 1024;

export const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
export const str = (v, max = 5000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Wraps a handler: (rt, ctx) where ctx = { req, params, body }. Errors become { error } JSON.
export function route(fn) {
  return async (req, { params } = {}) => {
    const rt = runtime();
    try {
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
      const out = await fn(rt, { req, params: await params, body });
      return out instanceof Response ? out : Response.json(out);
    } catch (err) {
      return Response.json({ error: rt.scrub(err.message) }, { status: err.status || 500 });
    }
  };
}

async function readJson(req) {
  if (Number(req.headers.get('content-length')) > MAX_BODY) throw bad('Request body too large', 413);
  const text = await req.text();
  if (text.length > MAX_BODY) throw bad('Request body too large', 413);
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw bad('Invalid JSON');
  }
}
