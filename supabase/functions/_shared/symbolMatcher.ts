// Strict broker-symbol matcher.
// Given a canonical symbol (e.g. "EUR/USD", "BTC/USD", "XAU/USD") and a list of
// raw broker symbols, return the best match using strict rules:
//   - Same base (alnum-only, uppercased) must appear as a contiguous substring.
//   - Allowed wrapping: at most ONE non-alnum prefix char AND at most ONE
//     non-alnum/alnum suffix run of length ≤ 2 (covers "b", "r", ".raw", ".m").
//   - Reject anything with extra punctuation in the middle ("EUR.USD.pro" → ok
//     because base is contiguous; "EUR-USDz" rejected — dash in middle).
//
// Returns null if no confident match.

export interface MatchResult {
  brokerSymbol: string;
  /** Detected suffix (e.g. "b", "r", ".raw"). Empty string if none. */
  suffix: string;
  /** Detected prefix (e.g. "#"). Empty string if none. */
  prefix: string;
}

const ALNUM = /[A-Z0-9]/;

function baseOf(canonical: string): string {
  return canonical.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Score a candidate broker symbol against a base.
 * Lower score = better. -1 = no match.
 */
function scoreCandidate(base: string, raw: string): number {
  const upper = raw.toUpperCase();
  const idx = upper.indexOf(base);
  if (idx === -1) return -1;

  const prefix = upper.slice(0, idx);
  const suffix = upper.slice(idx + base.length);

  // Strict prefix: empty, or exactly 1 non-alnum char (e.g. "#")
  if (prefix.length > 1) return -1;
  if (prefix.length === 1 && ALNUM.test(prefix)) return -1;

  // Strict suffix: empty, or up to 4 chars total, with at most 1 non-alnum
  // separator. Examples accepted: "", "b", "r", ".m", ".raw", "_pro", "z".
  if (suffix.length > 4) return -1;
  const nonAlnumCount = (suffix.match(/[^A-Z0-9]/g) ?? []).length;
  if (nonAlnumCount > 1) return -1;

  // Score: prefer shorter wrappers, prefer no-prefix over with-prefix.
  return prefix.length * 10 + suffix.length;
}

export function matchBrokerSymbol(
  canonical: string,
  brokerSymbols: string[],
): MatchResult | null {
  const all = matchAllBrokerSymbols(canonical, brokerSymbols);
  return all[0] ?? null;
}

/**
 * Return ALL candidate broker symbols matching the canonical pair,
 * sorted by static score (best first). Use this when you want to
 * probe each variant for tradability (Standard vs Raw vs Zero accounts).
 */
export function matchAllBrokerSymbols(
  canonical: string,
  brokerSymbols: string[],
): MatchResult[] {
  const base = baseOf(canonical);
  if (!base) return [];

  const scored: { raw: string; score: number }[] = [];
  for (const raw of brokerSymbols) {
    const s = scoreCandidate(base, raw);
    if (s < 0) continue;
    scored.push({ raw, score: s });
  }
  scored.sort((a, b) => a.score - b.score);

  return scored.map(({ raw }) => {
    const upper = raw.toUpperCase();
    const idx = upper.indexOf(base);
    return {
      brokerSymbol: raw,
      prefix: raw.slice(0, idx),
      suffix: raw.slice(idx + base.length),
    };
  });
}

/**
 * Build a full mapping for a list of canonical symbols against a broker's
 * symbol list. Returns:
 *   - overrides: { "EUR/USD": "EURUSDb", "BTC/USD": "#BTCUSDr", ... }
 *   - suffix: most common suffix (used as default when override missing)
 *   - unmapped: canonical symbols with no confident match
 */
export function buildBrokerSymbolMap(
  canonicalSymbols: string[],
  brokerSymbols: string[],
): { overrides: Record<string, string>; suffix: string; unmapped: string[] } {
  const overrides: Record<string, string> = {};
  const suffixCounts: Record<string, number> = {};
  const unmapped: string[] = [];

  for (const sym of canonicalSymbols) {
    const m = matchBrokerSymbol(sym, brokerSymbols);
    if (!m) {
      unmapped.push(sym);
      continue;
    }
    overrides[sym] = m.brokerSymbol;
    // Track simple alnum suffixes only (skip prefixes/punct) for default
    if (m.prefix === "" && m.suffix && /^[A-Z0-9]+$/i.test(m.suffix)) {
      suffixCounts[m.suffix] = (suffixCounts[m.suffix] ?? 0) + 1;
    }
  }

  // Pick most common suffix as default
  let suffix = "";
  let bestCount = 0;
  for (const [s, c] of Object.entries(suffixCounts)) {
    if (c > bestCount) { bestCount = c; suffix = s; }
  }

  return { overrides, suffix, unmapped };
}

// ---------------------------------------------------------------------------
// Tradability probe — distinguishes EURUSD vs EURUSDr vs EURUSDm by asking
// the broker whether each candidate is actually tradable on THIS account.
// ---------------------------------------------------------------------------

export interface TradabilityProbe {
  (brokerSymbol: string): Promise<{
    tradeMode?: string;       // "FULL", "DISABLED", "CLOSE_ONLY", etc.
    hasLivePrice?: boolean;   // true if bid/ask returned
  } | null>;
}

export interface ProbedMatch extends MatchResult {
  tradeMode?: string;
  hasLivePrice?: boolean;
  score: number;
}

function scoreProbed(c: { tradeMode?: string; hasLivePrice?: boolean; suffix: string; prefix: string }): number {
  let score = 0;
  if (c.tradeMode === "FULL") score += 100;
  else if (c.tradeMode && c.tradeMode !== "DISABLED") score += 30;
  if (c.hasLivePrice) score += 50;
  score -= c.prefix.length * 2;
  score -= c.suffix.length;
  return score;
}

/**
 * Probe-aware mapper. For each canonical pair, gather candidate variants and
 * call `probe` to see which is actually tradable; pick the highest scorer.
 * Falls back to static best when the probe returns nothing useful.
 */
export async function buildBrokerSymbolMapProbed(
  canonicalSymbols: string[],
  brokerSymbols: string[],
  probe: TradabilityProbe,
  opts: { concurrency?: number } = {},
): Promise<{
  overrides: Record<string, string>;
  suffix: string;
  unmapped: string[];
  details: Record<string, { picked: string; candidates: ProbedMatch[] }>;
}> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const overrides: Record<string, string> = {};
  const suffixCounts: Record<string, number> = {};
  const unmapped: string[] = [];
  const details: Record<string, { picked: string; candidates: ProbedMatch[] }> = {};

  const tasks = canonicalSymbols.map((sym) => async () => {
    const candidates = matchAllBrokerSymbols(sym, brokerSymbols).slice(0, 6);
    if (!candidates.length) {
      unmapped.push(sym);
      return;
    }
    const probed: ProbedMatch[] = await Promise.all(
      candidates.map(async (c) => {
        const info = await probe(c.brokerSymbol).catch(() => null);
        const merged = { ...c, ...(info ?? {}) };
        return { ...merged, score: scoreProbed(merged) };
      }),
    );
    probed.sort((a, b) => b.score - a.score);
    const tradable = probed.find((p) => p.tradeMode === "FULL" || p.hasLivePrice);
    const pick = tradable ?? probed[0];
    overrides[sym] = pick.brokerSymbol;
    details[sym] = { picked: pick.brokerSymbol, candidates: probed };
    if (pick.prefix === "" && pick.suffix && /^[A-Z0-9]+$/i.test(pick.suffix)) {
      suffixCounts[pick.suffix] = (suffixCounts[pick.suffix] ?? 0) + 1;
    }
  });

  // Run with bounded concurrency
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (i < tasks.length) {
      const idx = i++;
      await tasks[idx]();
    }
  });
  await Promise.all(workers);

  let suffix = "";
  let bestCount = 0;
  for (const [s, c] of Object.entries(suffixCounts)) {
    if (c > bestCount) { bestCount = c; suffix = s; }
  }

  return { overrides, suffix, unmapped, details };
}
