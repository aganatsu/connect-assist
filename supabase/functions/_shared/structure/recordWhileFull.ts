// Keep the canonical 1H and 5m structure-bar recorders running while bot-scanner is at its position cap (owner approval 2026-10-26).
//
// WHY. Both writers reuse candles the per-pair scan loop already fetched. At max open positions bot-scanner switches its full scans
// to "management only" and skips that loop, so the recorders stopped too: V3 state froze and the Impulse-on-V3 shadow stalled
// (observed 2026-10-26 21:20Z → 00:15Z at 3/3 positions). The shadow must observe the market whatever the account holds.
// WHAT. For each structure pair the account trades: fetch exactly the 1H ("5d") and, for a 5m entry timeframe, 5m ("5d") candles
// through the scanner's own cache (the same calls a full scan makes, ~12 per cycle for six pairs, only while full) and hand them to
// the existing writers. Observational: the result is telemetry only; any failure is caught here and never thrown.
import type { Candle } from "../smcAnalysis.ts";
import { fxOpenNY, H1_MS, STRUCTURE_PAIRS } from "./canonicalBars.ts";
import { liveWriterConfig, writeLiveStructureBars, type LiveWriterConfig, type WriterTelemetry } from "./structureBarsWriter.ts";
import { liveWriter5mConfig, writeLiveStructureBars5m, type LiveWriter5mConfig } from "./structureBarsWriter5m.ts";

// deno-lint-ignore no-explicit-any
type Client = { from: (table: string) => any };
export type PairRecord = { h1?: WriterTelemetry; m5?: WriterTelemetry; error?: string };

export async function recordStructureBarsWhileFull(
  client: Client, instruments: readonly string[], fetch: (sym: string, interval: string, range: string) => Promise<Candle[]>,
  o: { entryInterval: string; nowMs: number; cfg1h?: LiveWriterConfig; cfg5m?: LiveWriter5mConfig; clock?: () => number },
): Promise<Record<string, PairRecord>> {
  const cfg1h = o.cfg1h ?? liveWriterConfig(), cfg5m = o.cfg5m ?? liveWriter5mConfig();
  const want1h = cfg1h.enabled, want5m = cfg5m.enabled && o.entryInterval === "5m";
  const out: Record<string, PairRecord> = {};
  if (!want1h && !want5m) return out;
  // FX closed for more than 2 hours: nothing new can settle (the writers reject closed-market bars anyway); save the calls
  if (!fxOpenNY(Math.floor(o.nowMs / H1_MS) * H1_MS) && !fxOpenNY(Math.floor((o.nowMs - 2 * H1_MS) / H1_MS) * H1_MS)) return out;
  for (const pair of instruments) {
    if (!STRUCTURE_PAIRS.includes(pair as typeof STRUCTURE_PAIRS[number])) continue;
    try {
      const fetchStartedAtMs = (o.clock ?? Date.now)();
      const [h1, m5] = await Promise.all([want1h ? fetch(pair, "1h", "5d") : Promise.resolve([]), want5m ? fetch(pair, "5m", "5d") : Promise.resolve([])]);
      const r: PairRecord = {};
      if (want1h) r.h1 = await writeLiveStructureBars(client, pair, h1, { cfg: cfg1h, fetchStartedAtMs });
      if (want5m) r.m5 = await writeLiveStructureBars5m(client, pair, m5, { cfg: cfg5m, fetchStartedAtMs });
      out[pair] = r;
    } catch (e) {
      out[pair] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return out;
}
