# Browser Agent (Scrapfly Cloud Browser + OpenAI)

Local web app to log in to sites in a Scrapfly cloud browser, reuse those logins, and run AI agent tasks with human-in-the-loop.

```bash
npm install
cp .env.example .env   # fill in keys; APP_SECRET: openssl rand -hex 32
npm run dev            # http://127.0.0.1:3000 (Next.js dev mode, hot reload)

# production
npm run build && npm start
```

## Project layout
A Next.js (App Router) app run by a small custom server:
- `server.js`: starts Next, owns the long-lived state (store, Scrapfly browsers, agent runs), serves the live-view websocket at `/ws/live/:profileId`, and rejects cross-origin requests. Use `npm run dev` / `npm start`; plain `next dev` won't work.
- `app/api/**/route.js`: the REST API and the `/api/events` SSE stream. Route handlers reach the shared state through `lib/runtime.js`, never by importing `lib/store.js` etc. directly (Next would bundle a second copy).
- `app/page.jsx` + `components/`: the React UI.
- `lib/`: agent loop, Scrapfly browser manager, encrypted JSON store, usage/cost tracking.

## How it works
- **Profiles**: "Open & log in" starts a Scrapfly Cloud Browser (CDP over `wss://browser.scrapfly.io`) and shows it live in the app. Log in yourself (paste/"Send text" for passwords, solve 2FA/CAPTCHA), then **Save & close**. Cookies + localStorage are snapshotted (AES-256-GCM encrypted in `data/db.json`) and restored into every new browser for that profile. State is also auto-saved every 60s.
- **Tasks**: instructions + profile + optional start URL. The agent (OpenAI Responses API, `OPENAI_MODEL`) sees a screenshot plus a numbered list of interactive elements and calls one tool per step (click, type, navigate, scroll, …, `ask_human`, `done`, `fail`).
- **Human in the loop**: when the agent calls `ask_human`, the run shows "Needs you"; open the live browser, act, then **Done – resume agent** (optionally with a note). You can watch/take over or stop any run.

## Usage & cost per run
Each run stores `usage` (shown under **Usage & cost** in the Runs tab):
- **OpenAI**: exact tokens per run (input, cached input, output, reasoning) and number of calls, from each response's `usage`. The API doesn't return prices; set `OPENAI_PRICE_INPUT_PER_1M`, `OPENAI_PRICE_CACHED_INPUT_PER_1M` and `OPENAI_PRICE_OUTPUT_PER_1M` in `.env` to get a USD cost.
- **Scrapfly**: browser runtime and bandwidth for the run, from the Cloud Browser API. Credits are estimated with Scrapfly's [billing formula](https://scrapfly.io/docs/cloud-browser-api/billing): 1 credit per 30s, plus per-MB bandwidth by plan and proxy pool, with a 5-credit minimum per browser. Scrapfly's own `api_credits` value is used instead when it is non-zero. USD = credits × (plan price ÷ plan credits). If the run reused a browser you already had open, only the run's share is counted.

## Limits
- Scrapfly sessions last max 30 min (`timeout=1800`); a run or login must fit in that window. Sessions bill until stopped, so the app always stops them on close, on run end, and on Ctrl-C. Check `GET /api/scrapfly/sessions` for orphans.
- The exit IP changes between sessions (proxy pool `SCRAPFLY_PROXY_POOL`, country `SCRAPFLY_COUNTRY`). Some sites (Reddit included) may re-challenge a login from a new IP; the agent will `ask_human` when that happens.
- Element listing covers the main document and open shadow roots, not iframes (the screenshot still shows them).
- Binds to 127.0.0.1 with no auth: don't expose it publicly.
