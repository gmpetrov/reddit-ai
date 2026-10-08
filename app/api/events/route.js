import { runtime } from '@/lib/runtime';

// Server-sent events: live run + session updates.
export function GET(req) {
  const { manager, runEvents, browserEvents } = runtime();
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (event, data) => {
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup(); // stream already closed
        }
      };
      const onRun = (r) => send('run', r);
      const onSession = () => send('sessions', manager.list());
      const ping = setInterval(() => send('ping', Date.now()), 25_000);
      runEvents.on('run', onRun);
      browserEvents.on('session', onSession);
      cleanup = () => {
        clearInterval(ping);
        runEvents.off('run', onRun);
        browserEvents.off('session', onSession);
      };
      req.signal.addEventListener('abort', cleanup);
      onSession();
    },
    cancel: () => cleanup(),
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } });
}
