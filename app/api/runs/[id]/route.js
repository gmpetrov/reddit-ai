import { route, bad } from '@/lib/http';

export const GET = route((rt, { params }) => {
  const r = rt.runs.get(params.id);
  if (!r) throw bad('Not found', 404);
  return r;
});
