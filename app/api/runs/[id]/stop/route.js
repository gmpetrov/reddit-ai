import { route, bad } from '@/lib/http';

export const POST = route((rt, { params }) => {
  if (!rt.stopRun(params.id)) throw bad('Run is not active');
  return { ok: true };
});
