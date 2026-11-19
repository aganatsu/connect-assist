/**
 * STRUCTURE_STATE_OOS_V1 (docs/STRUCTURE_STATE_OOS_V1.md) — the fresh 2023-11 → 2025-12 corpus in
 * the shape the SMC replay expects. RESEARCH ONLY; no API calls.
 *   5m / 15m : .cache/momentum (weekend tape removed by loadTf)
 *   1h / 4h  : built from the 5m bars, UTC buckets (the live fetch uses timezone=UTC)
 *   1d       : .cache/trend daily since 2007 (UTC days)
 *   1w       : built from the daily (weekend days dropped), Monday 00:00 UTC
 */
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { dropFxClosedBars } from "../supabase/functions/_shared/sessions.ts";
import { loadTf } from "./momentumCorpus.ts";

export { SYMBOLS } from "./momentumCorpus.ts";

export function aggregate(bars: Candle[], bucketOf: (ms: number) => number): Candle[] {
  const out: Candle[] = [];
  let key = NaN;
  for (const b of bars) {
    const k = bucketOf(Date.parse(b.datetime));
    if (k !== key) {
      out.push({ datetime: new Date(k).toISOString(), open: b.open, high: b.high, low: b.low, close: b.close, volume: 0 } as Candle);
      key = k;
    } else {
      const o = out[out.length - 1];
      o.high = Math.max(o.high, b.high); o.low = Math.min(o.low, b.low); o.close = b.close;
    }
  }
  return out;
}

const H = 3_600_000, D = 86_400_000;
const mondayOf = (ms: number) => { const day = Math.floor(ms / D) * D; return day - ((new Date(day).getUTCDay() + 6) % 7) * D; };

function daily(sym: string): Candle[] {
  const raw: Array<{ t: string; o: number; h: number; l: number; c: number }> =
    JSON.parse(Deno.readTextFileSync(new URL(`./.cache/trend/${sym.replace("/", "")}_1day.json`, import.meta.url)));
  return raw.map((b) => ({ datetime: new Date(b.t).toISOString(), open: b.o, high: b.h, low: b.l, close: b.c, volume: 0 } as Candle));
}

export function loadOos(sym: string, tf: string): Candle[] {
  switch (tf) {
    case "5m": case "15m": return loadTf(sym, tf);
    case "1h": return aggregate(loadTf(sym, "5m"), (ms) => Math.floor(ms / H) * H);
    case "4h": return aggregate(loadTf(sym, "5m"), (ms) => Math.floor(ms / (4 * H)) * 4 * H);
    case "1d": return daily(sym);
    case "1w": return aggregate(dropFxClosedBars(daily(sym), true), mondayOf);
    default: return [];
  }
}
