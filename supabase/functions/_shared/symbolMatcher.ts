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
  const base = baseOf(canonical);
  if (!base) return null;

  let best: { raw: string; score: number } | null = null;
  for (const raw of brokerSymbols) {
    const s = scoreCandidate(base, raw);
    if (s < 0) continue;
    if (!best || s < best.score) best = { raw, score: s };
  }
  if (!best) return null;

  const upper = best.raw.toUpperCase();
  const idx = upper.indexOf(base);
  return {
    brokerSymbol: best.raw,
    prefix: best.raw.slice(0, idx),
    suffix: best.raw.slice(idx + base.length),
  };
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
