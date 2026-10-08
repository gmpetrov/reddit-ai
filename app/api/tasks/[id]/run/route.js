import { route, bad } from '@/lib/http';

export const POST = route((rt, { params }) => {
  const t = rt.tasks.get(params.id);
  if (!t) throw bad('Not found', 404);
  if (rt.manager.get(t.profileId)?.lockedBy) throw bad('Another run is already using this profile');
  if (rt.runs.list().some((r) => r.profileId === t.profileId && ['queued', 'running', 'waiting_human'].includes(r.status))) {
    throw bad('Another run is already using this profile');
  }
  return rt.startRun(t.id);
});
