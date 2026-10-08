import { route } from '@/lib/http';

// Remote sessions on the Scrapfly account (incl. orphans from crashes) — these bill until stopped.
export const GET = route((rt) => rt.listRemoteSessions());
