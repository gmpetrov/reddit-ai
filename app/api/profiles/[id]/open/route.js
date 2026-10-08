import { route, bad } from '@/lib/http';

export const POST = route(async (rt, { params }) => {
  const p = rt.profiles.get(params.id);
  if (!p) throw bad('Not found', 404);
  const fresh = !rt.manager.get(p.id);
  const s = await rt.manager.open(p.id);
  if (fresh && p.startUrl) await s.input({ type: 'navigate', url: p.startUrl }).catch(() => {});
  return s.summary();
});
