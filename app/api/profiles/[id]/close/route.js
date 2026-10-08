import { route, bad } from '@/lib/http';

export const POST = route(async (rt, { params, body }) => {
  // Lock check happens inside the serialized close, after any in-flight open completes.
  await rt.manager.close(params.id, { save: body.save !== false, strict: true }).catch((err) => {
    throw bad(err.message, 409);
  });
  return { ok: true };
});
