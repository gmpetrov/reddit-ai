import { route } from '@/lib/http';

export const GET = route((rt) => rt.manager.list());
