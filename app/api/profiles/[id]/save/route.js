import { route, bad } from '@/lib/http';

export const POST = route(async (rt, { params }) => {
  const s = rt.manager.get(params.id);
  if (!s) throw bad('Browser is not open');
  await s.saveState();
  return rt.publicProfile(rt.profiles.get(params.id));
});
