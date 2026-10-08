import { route, bad, str } from '@/lib/http';

export const POST = route((rt, { params, body }) => {
  if (!rt.resumeRun(params.id, str(body.note, 2000))) throw bad('Run is not waiting for a human');
  return { ok: true };
});
