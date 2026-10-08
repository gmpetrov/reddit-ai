import { route } from '@/lib/http';
import { taskFields } from './fields';

export const GET = route((rt) => rt.tasks.list());

export const POST = route((rt, { body }) => rt.tasks.create(taskFields(rt, body)));
