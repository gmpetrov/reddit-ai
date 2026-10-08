// Per-run resource usage of third-party services.
// - OpenAI: exact token counts from each response's `usage`; cost is computed only if prices are
//   configured (the API doesn't return prices).
// - Scrapfly: runtime + bandwidth from the Cloud Browser API; credits are estimated with Scrapfly's
//   published billing formula (the API's own `api_credits` is recorded too when it is non-zero).
import { getAccount } from './browser.js';

const SF_API = 'https://browser.scrapfly.io';
const KEY = process.env.SCRAPFLY_API_KEY;

// ---------------- OpenAI ----------------
const price = (name) => {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : null;
};
// USD per 1M tokens, from your OpenAI pricing page / invoice.
const OPENAI_PRICES = {
  input: price('OPENAI_PRICE_INPUT_PER_1M'),
  cachedInput: price('OPENAI_PRICE_CACHED_INPUT_PER_1M'),
  output: price('OPENAI_PRICE_OUTPUT_PER_1M'),
};

export function emptyOpenAIUsage(model) {
  return { model, calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: null, pricing: null };
}

export function addOpenAIUsage(acc, usage) {
  acc.calls++;
  if (!usage) return acc;
  acc.inputTokens += usage.input_tokens || 0;
  acc.cachedInputTokens += usage.input_tokens_details?.cached_tokens || 0;
  acc.outputTokens += usage.output_tokens || 0; // includes reasoning tokens
  acc.reasoningTokens += usage.output_tokens_details?.reasoning_tokens || 0;
  if (OPENAI_PRICES.input != null && OPENAI_PRICES.output != null) {
    const cachedRate = OPENAI_PRICES.cachedInput ?? OPENAI_PRICES.input;
    const uncached = acc.inputTokens - acc.cachedInputTokens;
    acc.costUsd = round((uncached * OPENAI_PRICES.input + acc.cachedInputTokens * cachedRate + acc.outputTokens * OPENAI_PRICES.output) / 1e6, 6);
    acc.pricing = { ...OPENAI_PRICES, unit: 'USD per 1M tokens' };
  }
  return acc;
}

// ---------------- Scrapfly ----------------
// https://scrapfly.io/docs/cloud-browser-api/billing — bandwidth credits per MB by plan and pool.
const BANDWIDTH_CREDITS_PER_MB = {
  free: { datacenter: 7, residential: 52 },
  discovery: { datacenter: 7, residential: 52 },
  pro: { datacenter: 10, residential: 78 },
  startup: { datacenter: 8, residential: 65 },
  enterprise: { datacenter: 8, residential: 65 },
};
const MIN_CREDITS_PER_ALLOCATION = 5;
const MB = 1024 * 1024;

async function sfGet(path) {
  const res = await fetch(`${SF_API}${path}${path.includes('?') ? '&' : '?'}api_key=${KEY}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Scrapfly ${path.split('?')[0]} returned ${res.status}`);
  return res.json();
}

// Live counters of a running remote session (also gives its run_id).
export async function scrapflySessionStats(sessionId) {
  const s = await sfGet(`/session/${encodeURIComponent(sessionId)}`);
  return { runId: s.run_id, runtimeMs: s.runtime_ms || 0, bandwidthUp: s.bandwidth_up || 0, bandwidthDown: s.bandwidth_down || 0 };
}

// Final counters of a stopped run; Scrapfly finalizes asynchronously, so poll briefly.
async function scrapflyRunInfo(runId) {
  let info;
  for (let i = 0; i < 8; i++) {
    info = await sfGet(`/run/${encodeURIComponent(runId)}/info`).catch(() => info);
    if (info?.state === 'finished') break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return info;
}

/**
 * start: counters when the run began (null if the run allocated the browser itself).
 * closedByRun: the run stopped the browser, so the whole allocation is billed to it.
 */
export async function scrapflyUsage({ sessionId, start, closedByRun, proxyPool }) {
  const base = start || { runtimeMs: 0, bandwidthUp: 0, bandwidthDown: 0 };
  let end;
  let reportedCredits = null;
  let runId = start?.runId;
  if (closedByRun && runId) {
    const info = await scrapflyRunInfo(runId);
    if (info) {
      end = { runtimeMs: info.runtime_ms || 0, bandwidthUp: info.bandwidth_up || 0, bandwidthDown: info.bandwidth_down || 0 };
      proxyPool = info.proxy_pool || proxyPool;
      if (info.api_credits > 0) reportedCredits = info.api_credits;
    }
  }
  if (!end) {
    const live = await scrapflySessionStats(sessionId).catch(() => null);
    if (!live) return { sessionId, runId, error: 'Scrapfly usage unavailable for this session' };
    end = live;
    runId ||= live.runId;
  }

  const runtimeMs = Math.max(0, end.runtimeMs - base.runtimeMs);
  const bandwidthBytes = Math.max(0, end.bandwidthUp + end.bandwidthDown - base.bandwidthUp - base.bandwidthDown);

  const account = await getAccount().catch(() => null);
  const planKey = String(account?.plan || '').toLowerCase();
  const perMb = BANDWIDTH_CREDITS_PER_MB[planKey]?.[proxyPool] ?? null;
  const timeCredits = Math.ceil(runtimeMs / 30_000);
  const bandwidthCredits = perMb == null ? null : Math.ceil(bandwidthBytes / MB) * perMb;
  let estimatedCredits = bandwidthCredits == null ? null : timeCredits + bandwidthCredits;
  // The 5-credit minimum applies per browser allocation, i.e. only when this run owned the browser.
  if (estimatedCredits != null && closedByRun && !start?.shared) estimatedCredits = Math.max(estimatedCredits, MIN_CREDITS_PER_ALLOCATION);

  const credits = reportedCredits ?? estimatedCredits;
  // Effective $/credit of the subscription (plan price / included credits); $0 on the free plan.
  const usdPerCredit = account?.planPriceUsd != null && account.limit ? account.planPriceUsd / account.limit : null;

  return {
    sessionId,
    runId,
    proxyPool,
    plan: account?.plan ?? null,
    sharedSession: Boolean(start?.shared),
    runtimeMs,
    bandwidthBytes,
    credits,
    creditsSource: reportedCredits != null ? 'scrapfly' : 'estimate',
    breakdown: { timeCredits, bandwidthCredits, bandwidthCreditsPerMb: perMb },
    costUsd: credits != null && usdPerCredit != null ? round(credits * usdPerCredit, 6) : null,
  };
}

export function totalCost(usage) {
  const parts = [usage.openai?.costUsd, usage.scrapfly?.costUsd];
  if (parts.every((p) => p == null)) return null;
  return round(parts.reduce((a, p) => a + (p || 0), 0), 6);
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
