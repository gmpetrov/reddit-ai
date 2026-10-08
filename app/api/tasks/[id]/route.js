import { route, bad } from '@/lib/http';
import { taskFields } from '../fields';

export const PUT = route((rt, { params, body }) => {
  if (!rt.tasks.get(params.id)) throw bad('Not found', 404);
  return rt.tasks.update(params.id, taskFields(rt, body));
});

export const DELETE = route((rt, { params }) => {
  rt.tasks.remove(params.id);
  return { ok: true };
});
