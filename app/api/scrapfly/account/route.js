import { route } from '@/lib/http';

export const GET = route((rt, { req }) => rt.getAccount({ fresh: req.nextUrl.searchParams.get('fresh') === '1' }));
