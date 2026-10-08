import { route, bad } from '@/lib/http';

export const POST = route((rt, { params }) => {
  if (!rt.profiles.get(params.id)) throw bad('Not found', 404);
  if (rt.manager.get(params.id)) throw bad('Close the browser first');
  rt.profiles.clearState(params.id);
  return { ok: true };
});
