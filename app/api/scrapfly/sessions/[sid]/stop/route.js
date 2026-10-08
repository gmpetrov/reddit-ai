import { route, bad } from '@/lib/http';

export const POST = route(async (rt, { params }) => {
  const local = rt.manager.list().find((s) => s.sessionId === params.sid);
  if (local) await rt.manager.close(local.profileId).catch((err) => {
    throw bad(err.message, 409);
  });
  else await rt.stopRemoteSession(params.sid);
  return { ok: true };
});
