/**
 * IPO_STOCK_BASELINE_V1 — ARM A (large / liquid US equities). RESEARCH ONLY.
 *
 * Asks one question: does the frozen IPO strategy, UNCHANGED, have a causal,
 * execution-realistic edge on US equities? No stock-selection logic, no
 * filters, no tuning. Geometry, lifecycle, E2, S2, 2R target, repeated-touch
 * and one-position sequencing all come from the production engine.
 *
 * WHAT IS DIFFERENT FROM THE FOREX BASELINE, AND WHY:
 *
 *   COSTS ARE PROPORTIONAL, NOT PER-SHARE. The provider back-adjusts prices
 *   for splits, so NVDA trades at ~$121 in June 2024 where the tape said
 *   ~$1210. A cents-per-share cost applied to an adjusted series is wrong by
 *   the split factor — 10x too small here, and too large elsewhere. Basis
 *   points are invariant under adjustment, so the cost model is in bps and
 *   the result is reported at two levels rather than one assumption.
 *
 *   REGULAR HOURS ONLY. Pre/post-market 1m is a Pro-plan entitlement and this
 *   key is on `grow`; `extended_hours=true` silently returns the same 390
 *   regular-session bars. The extended-hours arm is therefore NOT run rather
 *   than run on data that cannot contain it.
 *
 *   SESSION-ANCHORED BARS. US equity 1h bars start 09:30, and "4h" is really
 *   09:30-13:29 plus a truncated 13:30-15:59. Both windows are covered by the
 *   tape and do not overlap under barMs=4h, verified before use.
 *
 * Entry timestamps use the SAME causal standard as the accepted forex
 * baseline: `firstEntryMinute` on the 1m tape, never the parent bar open.
 *
 *   deno run --allow-net --allow-read --allow-write --allow-env \
 *     local-runner/ipo-stock-baseline.ts
 */

import { replayIncremental } from "../supabase/functions/_shared/ipoIncrementalEngine.ts";
import type { EngineConfig, LiveTrade } from "../supabase/functions/_shared/ipoLiveEngine.ts";
import {
  firstEntryMinute, minutesInBar, resolveBar,
} from "../supabase/functions/_shared/ipoCausalOrdering.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { series } from "./ipo-stock-datacheck.ts";

// ─── universe ────────────────────────────────────────────────────────────────

/**
 * ARM A exactly as specified. This list is HINDSIGHT-SELECTED — it is today's
 * mega-caps, and NVDA/META/TSLA are in it because they won. That biases LONG
 * results upward and SHORT results downward on these names, and the verdict
 * must not be read as "the strategy works on equities" without that caveat.
 * A symbol with insufficient coverage is reported and excluded, never swapped.
 */
const ARM_A = ["AAPL", "MSFT", "NVDA", "AMZN", "META", "TSLA",
               "AMD", "GOOGL", "NFLX", "SPY", "QQQ"];

const TFS = [
  { tf: "1h", barMs: 3_600_000 },
  { tf: "4h", barMs: 14_400_000 },
] as const;

const START = "2021-01-01";
const END = "2026-09-25";

/** Conservative for mega-caps: half-spread + slippage + commission + SEC/TAF. */
const COST_BPS = [2.5, 5.0] as const;
const PRIMARY_BPS = 2.5;

// ─── cache ───────────────────────────────────────────────────────────────────

const CACHE = new URL("./.cache/stock/", import.meta.url);
try { Deno.mkdirSync(CACHE, { recursive: true }); } catch { /* exists */ }

async function cached(sym: string, iv: string, s: string, e: string): Promise<Candle[]> {
  const f = new URL(`${sym.replace("/", "_")}_${iv}_${s}_${e}.json`, CACHE);
  try { return JSON.parse(Deno.readTextFileSync(f)); } catch { /* miss */ }
  const v = await series(sym, iv, s, e);
  Deno.writeTextFileSync(f, JSON.stringify(v));
  return v;
}

/** Yearly chunks: one request returns at most 5000 bars. */
async function history(sym: string, iv: string): Promise<Candle[]> {
  const out: Candle[] = [];
  for (let y = +START.slice(0, 4); y <= +END.slice(0, 4); y++) {
    const s = y === +START.slice(0, 4) ? START : `${y}-01-01`;
    const e = y === +END.slice(0, 4) ? END : `${y}-12-31`;
    out.push(...await cached(sym, iv, s, e));
  }
  const seen = new Set<string>();
  return out.filter((c) => !seen.has(c.datetime) && seen.add(c.datetime))
            .sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
}

const dayOf = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));

const nyClock = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });

// ─── the trade record ────────────────────────────────────────────────────────

export interface Row {
  symbol: string; timeframe: string; direction: "long" | "short";
  ipo_candle_time: string;
  strategy_bar_time: string;
  actual_entry_time: string | null;
  entry_resolution: string;
  entry_price: number; stop: number; target: number; risk: number;
  exit_bar_time: string | null; exit_price: number | null;
  gross_r: number | null; cost_r: number; net_r: number | null;
  mae_r: number; mfe_r: number; bars_held: number | null;
  hold_minutes: number | null;
  vol_bucket: string; ambiguous: boolean; ambiguity_reason: string;
  minutes_available: number;
}

function toRow(
  sym: string, tf: string, bars: Candle[], t: LiveTrade, costPerSide: (p: number) => number,
): Row {
  const dir = t.direction === "demand" ? "long" : "short";
  const costR = (2 * costPerSide(t.entry)) / t.risk;
  const grossR = t.exitPrice === null ? null
    : (dir === "long" ? t.exitPrice - t.entry : t.entry - t.exitPrice) / t.risk;
  return {
    symbol: sym, timeframe: tf, direction: dir,
    ipo_candle_time: bars[t.ipoIndex].datetime,
    strategy_bar_time: bars[t.entryIndex].datetime,
    actual_entry_time: null, entry_resolution: "UNRESOLVED",
    entry_price: t.entry, stop: t.stop, target: t.target, risk: t.risk,
    exit_bar_time: t.exitIndex === null ? null : bars[t.exitIndex].datetime,
    exit_price: t.exitPrice,
    gross_r: grossR, cost_r: costR,
    net_r: grossR === null ? null : grossR - costR,
    mae_r: t.mae / t.risk, mfe_r: t.mfe / t.risk,
    bars_held: t.exitIndex === null ? null : t.exitIndex - t.entryIndex,
    hold_minutes: null,
    vol_bucket: t.vol, ambiguous: false, ambiguity_reason: "",
    minutes_available: 0,
  };
}

// ─── main ────────────────────────────────────────────────────────────────────

/**
 * WINDOWED REPLAY. The engine is ~O(n^2.7): measured 1.5s at 500 bars, 32s at
 * 1500, 231s at 3000. AAPL 1h alone is 10,023 bars, which extrapolates to ~1.6
 * hours for ONE symbol. The forex baseline windowed for the same reason.
 *
 * WARMUP bars at the head of each window rebuild lifecycle state and are not
 * eligible to own a trade; TAIL bars at the end exist only so a trade entered
 * late in the window can still resolve. Windows therefore advance by
 * WINDOW - WARMUP - TAIL, and every trade is attributed to exactly one window
 * — the one where its ENTRY falls in the eligible middle.
 *
 * WHAT THIS COSTS, STATED PLAINLY: one-position sequencing is enforced within
 * a window, not across boundaries, so a position open at a boundary does not
 * block a candidate on the far side. That inflates trade count slightly versus
 * a single continuous replay. It is the same compromise the forex baseline
 * made, and it is a sequencing artefact, not a lookahead.
 */
const WINDOW = 1500, WARMUP = 400, TAIL = 100;
const STEP = WINDOW - WARMUP - TAIL;

function replayWindowed(
  bars: Candle[], cfg: EngineConfig,
): Array<{ t: LiveTrade; bars: Candle[]; unresolvedAtEdge: boolean }> {
  const out: Array<{ t: LiveTrade; bars: Candle[]; unresolvedAtEdge: boolean }> = [];
  const seen = new Set<string>();
  for (let start = 0; start < bars.length; start += STEP) {
    const win = bars.slice(start, start + WINDOW);
    if (win.length < WARMUP + 50) break;
    const lo = start === 0 ? 0 : WARMUP;
    const hi = Math.min(win.length, WARMUP + STEP + (start === 0 ? WARMUP : 0));
    for (const t of replayIncremental(win, cfg).trades) {
      if (t.entryIndex < lo || t.entryIndex >= hi) continue;
      // Identity is the IPO candle plus the entry bar, both absolute instants,
      // so an overlap cannot book the same trade twice.
      const key = `${win[t.ipoIndex].datetime}|${win[t.entryIndex].datetime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ t, bars: win, unresolvedAtEdge: t.exitIndex === null });
    }
  }
  return out;
}

if (import.meta.main) {
  const only = Deno.args[0];
  const symbols = only ? [only] : ARM_A;
  const rows: Row[] = [];
  const coverage: Array<Record<string, unknown>> = [];
  const excluded: Array<Record<string, unknown>> = [];

  for (const sym of symbols) {
    for (const { tf } of TFS) {
      const bars = await history(sym, tf);
      if (bars.length < WARMUP + 100) {
        excluded.push({ symbol: sym, timeframe: tf, reason: "INSUFFICIENT_HISTORY",
          detail: `${bars.length} bars` });
        console.log(`${sym} ${tf}: EXCLUDED (${bars.length} bars)`);
        continue;
      }
      const cost = (p: number) => p * (PRIMARY_BPS / 10_000);
      const cfg: EngineConfig = {
        instrument: sym, timeframe: tf, highVolOnly: false, costPerSide: cost,
      };
      const t0 = Date.now();
      const found = replayWindowed(bars, cfg);
      for (const f of found) {
        const r = toRow(sym, tf, f.bars, f.t, cost);
        if (f.unresolvedAtEdge) {
          r.ambiguous = true; r.ambiguity_reason = "UNRESOLVED_AT_WINDOW_EDGE";
        }
        rows.push(r);
      }
      coverage.push({
        symbol: sym, timeframe: tf, bars: bars.length,
        from: bars[0].datetime, to: bars[bars.length - 1].datetime,
        candidates: found.length,
        unresolved_edge: found.filter((f) => f.unresolvedAtEdge).length,
      });
      console.log(`${sym} ${tf}: ${bars.length} bars ` +
        `${dayOf(bars[0].datetime)}..${dayOf(bars[bars.length - 1].datetime)}  ` +
        `${found.length} candidates  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }

  const tag = only ? `_${only}` : "";
  Deno.writeTextFileSync(new URL(`./.cache/stock_rows${tag}.json`, import.meta.url),
    JSON.stringify({ rows, coverage, excluded }, null, 1));
  console.log(`${rows.length} candidate trades written`);
}
