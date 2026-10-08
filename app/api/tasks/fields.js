import { bad, str } from '@/lib/http';

export function taskFields(rt, body) {
  const name = str(body.name, 100);
  const profileId = str(body.profileId, 100);
  const instructions = str(body.instructions, 8000);
  if (!name || !instructions) throw bad('Name and instructions are required');
  if (!rt.profiles.get(profileId)) throw bad('Pick a valid profile');
  const startUrl = body.startUrl ? rt.normalizeUrl(str(body.startUrl, 2000)) : '';
  const maxSteps = Math.min(Math.max(parseInt(body.maxSteps, 10) || 30, 1), 100);
  return { name, profileId, instructions, startUrl, maxSteps };
}
