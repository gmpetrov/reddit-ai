import { route, bad } from '@/lib/http';

export const DELETE = route(async (rt, { params }) => {
  if (!rt.profiles.get(params.id)) throw bad('Not found', 404);
  if (rt.tasks.list().some((t) => t.profileId === params.id)) throw bad('Delete the tasks using this profile first');
  await rt.manager.close(params.id, { save: false });
  rt.profiles.remove(params.id);
  return { ok: true };
});
