# AGENTS.md

Context and rules for AI coding assistants (Claude Code, Cursor, Copilot, etc.) working in this repo.

## Project Overview

Local web app that logs in to sites in a Scrapfly Cloud Browser, reuses those logins, and runs OpenAI-driven agent tasks with a human in the loop. See `README.md` for how it works and its limits.

- **Runtime**: Node.js (ES modules, plain JavaScript, no build step, no TypeScript)
- **Server**: Express 5 + `ws` for live updates
- **Browser**: `playwright-core` over CDP to Scrapfly (`wss://browser.scrapfly.io`)
- **AI**: OpenAI Responses API (`openai` package)
- **Storage**: one JSON file, `data/db.json` (session state encrypted with `APP_SECRET`)

## Repository Structure

| Path            | Description                                                          |
| --------------- | -------------------------------------------------------------------- |
| `src/server.js` | HTTP API, WebSocket, same-origin guard, input validation             |
| `src/agent.js`  | Agent loop: screenshot + element list → tool call per step           |
| `src/browser.js` | Scrapfly session manager, CDP connection, state save/restore         |
| `src/store.js`  | JSON-file store for profiles, tasks, runs; encryption helpers        |
| `src/usage.js`  | OpenAI token and Scrapfly credit accounting per run                  |
| `public/`       | Frontend: vanilla `index.html`, `app.js`, `style.css` (no framework) |

## Commands

| Command       | Description                                 |
| ------------- | ------------------------------------------- |
| `npm install` | Install dependencies                        |
| `npm start`   | Run the server (reads `.env`)               |
| `npm run dev` | Run with `--watch`                          |

Setup: `cp .env.example .env` and fill in keys (`APP_SECRET`: `openssl rand -hex 32`).

## Avoid Over-Engineering

This is a small app. Keep it that way. The best change is usually the smallest one that fully solves the task.

- **Do what was asked.** No unrequested features, refactors, renames, or "while I'm here" cleanups. Mention them instead.
- **No speculative abstractions.** No interfaces, factories, plugin systems, config options, or generic helpers for a single caller. Three similar lines beat a premature abstraction. Extract only when there is a second real use.
- **No new dependencies** unless the standard library or an existing dependency truly can't do it. Prefer `node:` built-ins (`node:test`, `node:crypto`, `fetch`, etc.). Ask before adding one.
- **No new layers.** No ORM, database, bundler, framework, TypeScript, or state library. The JSON store, vanilla frontend, and no-build setup are deliberate.
- **No new files or folders** when the code fits in an existing module. Don't split modules just to make them smaller.
- **Match the surrounding code**: same naming, idioms, error handling, and comment density. Comments explain *why*, not *what*.
- **Handle real failure modes only.** Validate at the boundary (HTTP input, external API responses); don't add defensive checks for states that can't happen internally.
- **No backwards-compat shims** for unreleased internal code. Change the callers.
- **Delete dead code** you made dead. Don't leave commented-out code or unused exports behind.
- **Keep diffs reviewable.** If a change is growing large, stop and check the approach with the human.

## Non-Negotiables

- Always stop Scrapfly sessions you start (they bill until stopped), including on error paths.
- Never log or return API keys or decrypted session state; pass error messages through `scrub()`.
- Keep the server bound to `127.0.0.1` and keep the same-origin check in `src/server.js`.
- Never commit `.env` or `data/`.

## Testing

### End-to-end tests are required

Every feature and bug fix includes an e2e test that exercises it the way a user would: through the HTTP API and/or the UI in a real browser.

- **Framework**: `@playwright/test` (the only test dependency; reuses Playwright already in the stack)
- **Location**: `e2e/*.spec.js`, one file per feature area (e.g. `e2e/profiles.spec.js`, `e2e/tasks.spec.js`)
- **Command**: `npm run test:e2e`
- **Server**: started by Playwright's `webServer` config against a throwaway working directory, so tests never touch your real `data/db.json`
- **Bug fixes**: write the failing test first, then fix.
- If the e2e setup doesn't exist yet, the first change that needs it adds it (`playwright.config.js`, `test:e2e` script, `e2e/` folder). Keep that setup minimal.

### External services

OpenAI and Scrapfly cost money and are non-deterministic.

- Default e2e runs must not call them. Cover everything that doesn't need them: CRUD, validation, error responses, same-origin guard, UI flows, persistence.
- Tests that need a real browser session or model call go behind an env flag (e.g. `E2E_LIVE=1`) and are skipped otherwise. Keep them few, short, and always clean up sessions.
- Don't build a mocking framework. If a stub is truly needed, keep it small and local to the test.

### Before finishing a task

1. Run `npm run test:e2e` and make sure it passes. Report failures honestly.
2. Start the app (`npm start`) and check the change works in the UI when it touches the frontend or a user flow.
3. Update `README.md` if behavior, setup, env vars, or limits changed. Add new env vars to `.env.example`.

## Task Completion Guidelines

### Bug fixes

1. Failing e2e test that reproduces the bug
2. Smallest fix that makes it pass
3. Full e2e suite green

### New features

1. Implementation, scoped to the request
2. E2e tests covering the main path and the important failure cases
3. README / `.env.example` updates if user-facing

### Refactoring

- Only when asked. Behavior stays the same and the existing e2e suite proves it.
