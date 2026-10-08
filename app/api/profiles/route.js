import { route, bad, str } from '@/lib/http';

export const GET = route((rt) => rt.profiles.list());

export const POST = route((rt, { body }) => {
  const name = str(body.name, 100);
  if (!name) throw bad('Name is required');
  const startUrl = body.startUrl ? rt.normalizeUrl(str(body.startUrl, 2000)) : '';
  return rt.publicProfile(rt.profiles.create({ name, startUrl }));
});
