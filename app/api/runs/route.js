import { route } from '@/lib/http';

export const GET = route((rt) => rt.runs.list().slice(0, 50));
