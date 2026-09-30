/**
 * IPO_STOCK_BASELINE_V1 — stage 2b: CAUSAL OUTCOME DERIVATION. READ-ONLY.
 *
 * WHY THIS REPLACES THE FIRST PASS. Stage 2 resolved the ENTRY causally and
 * then took the engine's own `netR` for the outcome. The engine reads the
 * whole fill bar, so on a bar where the entry happened 34 minutes in — the
 * median — it credited a 2R target using the high of the minutes BEFORE the
 * position existed. 46% of trades "exited" on their own entry bar with a
 * 99.9% win rate and +1.82R. Trades that exited on a later bar, where no
 * pre-entry excursion is possible, ran 49.2% and -0.222R.
 *
 * That is textbook lookahead, and it was in the harness, not the strategy.
 *
 * WHAT THIS DOES INSTEAD, matching the production paper runner:
 *
 *   ENTRY BAR   resolved by `resolveBar(isEntryBar: true)` against the 1m
 *               tape. Nothing before the fill minute may resolve the trade.
 *   LATER BARS  whole-bar OHLC is legitimate: the position held all of it.
 *               A bar that BOTH reaches the target and closes beyond S2 is
 *               not orderable without a tape, so it is marked ambiguous
 *               rather than decided by code precedence.
 *
 *   deno run --allow-net --allow-read --allow-write --allow-env \
 *     local-runner/ipo-stock-causal.ts [SYMBOL]
 */

import { resolveBar } from "../supabase/functions/_shared/ipoCausalOrdering.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { series } from "./ipo-stock-datacheck.ts";
import type { Row } from "./ipo-stock-baseline.ts";

const CACHE = new URL("./.cache/", import.meta.url);
const BAR_MS: Record<string, number> = { "1h": 3_600_000, "4h": 14_400_000 };
const CHUNK_DAYS = 15;

const nyDay = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));

/** The same yearly-chunk cache stage 1 built. */
function bars(sym: string, iv: string): Candle[] {
  const out: Candle[] = [];
  for (let y = 2021; y <= 2026; y++) {
    const s = y === 2021 ? "2021-01-01" : `${y}-01-01`;
    const e = y === 2026 ? "2026-09-25" : `${y}-12-31`;
    try {
      out.push(...JSON.parse(Deno.readTextFileSync(
        new URL(`./stock/${sym}_${iv}_${s}_${e}.json`, CACHE))));
    } catch { /* gap reported upstream */ }
  }
  const seen = new Set<string>();
  return out.filter((c) => !seen.has(c.datetime) && seen.add(c.datetime))
            .sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
}

export interface CausalRow extends Row {
  causal_exit_bar_time: string | null;
  causal_exit_price: number | null;
  causal_exit_reason: string;
  causal_gross_r: number | null;
  causal_net_r: number | null;
  causal_bars_held: number | null;
  causal_hold_minutes: number | null;
  /** True when the outcome hinges on ordering no tape here can settle. */
  causal_ambiguous: boolean;
  causal_ambiguity: string;
  /** What the contaminated whole-bar reading would have booked. Diagnostic. */
  htf_would_have_booked: string;
}

if (import.meta.main) {
  const only = Deno.args[0];
  const all: Row[] = [];
  for (const e of Deno.readDirSync(CACHE)) {
    if (!/^stock_resolved_.*\.json$/.test(e.name)) continue;
    all.push(...JSON.parse(Deno.readTextFileSync(new URL(e.name, CACHE))) as Row[]);
  }
  const symbols = only ? [only] : [...new Set(all.map((r) => r.symbol))].sort();

  for (const sym of symbols) {
    const outFile = new URL(`./stock_causal_${sym}.json`, CACHE);
    try { Deno.readTextFileSync(outFile); console.log(`${sym}: cached`); continue; } catch { /* go */ }

    const rows = all.filter((r) => r.symbol === sym) as CausalRow[];
    const barsOf: Record<string, Candle[]> = { "1h": bars(sym, "1h"), "4h": bars(sym, "4h") };
    const idxOf: Record<string, Map<string, number>> = {
      "1h": new Map(barsOf["1h"].map((b, i) => [b.datetime, i])),
      "4h": new Map(barsOf["4h"].map((b, i) => [b.datetime, i])),
    };

    const byDay = new Map<string, CausalRow[]>();
    for (const r of rows) {
      const d = nyDay(r.strategy_bar_time);
      (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(r);
    }
    const days = [...byDay.keys()].sort();
    let done = 0, amb = 0;

    for (let i = 0; i < days.length;) {
      const start = days[i];
      const endMs = Date.parse(start) + CHUNK_DAYS * 86_400_000;
      const end = new Date(endMs).toISOString().slice(0, 10);
      const inChunk: string[] = [];
      while (i < days.length && Date.parse(days[i]) < endMs) inChunk.push(days[i++]);

      let mins: Candle[] = [];
      try { mins = await series(sym, "1min", start, end); } catch { /* handled */ }

      for (const d of inChunk) {
        const dayMins = mins.filter((m) => nyDay(m.datetime) === d);
        for (const r of byDay.get(d)!) {
          r.causal_exit_bar_time = null; r.causal_exit_price = null;
          r.causal_gross_r = null; r.causal_net_r = null;
          r.causal_bars_held = null; r.causal_hold_minutes = null;
          r.causal_ambiguous = false; r.causal_ambiguity = "";
          r.causal_exit_reason = "OPEN_AT_SERIES_END";
          r.htf_would_have_booked = r.exit_bar_time === r.strategy_bar_time
            ? "SAME_BAR" : "LATER_BAR";

          if (!r.actual_entry_time || r.entry_resolution === "NO_1M_TAPE") {
            r.causal_ambiguous = true; r.causal_ambiguity = "NO_CAUSAL_ENTRY"; amb++; continue;
          }
          const bs = barsOf[r.timeframe];
          const barMs = BAR_MS[r.timeframe];
          const e0 = idxOf[r.timeframe].get(r.strategy_bar_time);
          if (e0 === undefined) {
            r.causal_ambiguous = true; r.causal_ambiguity = "ENTRY_BAR_NOT_IN_SERIES"; amb++; continue;
          }
          const long = r.direction === "long";

          // ── the fill bar: only the tape after the entry minute may resolve it
          const o = resolveBar({
            direction: r.direction as "long" | "short",
            entryPrice: r.entry_price, targetPrice: r.target,
            s2InvalidationLevel: r.stop, bar: bs[e0], barMs,
            isEntryBar: true, minutes: dayMins, ticks: null, minutesFinal: true,
          });
          if (o.kind === "AMBIGUOUS_OPEN_OR_CLOSED" || o.kind === "UNRESOLVED_TERMINAL"
              || o.kind === "NEED_MINUTES") {
            r.causal_ambiguous = true; r.causal_ambiguity = `ENTRY_BAR_${o.kind}`; amb++; continue;
          }

          let exitIdx: number | null = null, exitPx: number | null = null, reason = "";
          if (o.kind === "TARGET") { exitIdx = e0; exitPx = r.target; reason = "TARGET_2R"; }
          else if (o.kind === "S2_CLOSE") { exitIdx = e0; exitPx = bs[e0].close; reason = "S2_CLOSE"; }

          // ── later bars: the position held all of each one, so whole-bar OHLC
          //    is legitimate. A bar doing BOTH cannot be ordered without a tape.
          for (let k = e0 + 1; exitIdx === null && k < bs.length; k++) {
            const b = bs[k];
            const hit = long ? b.high >= r.target : b.low <= r.target;
            const beyond = long ? b.close < r.stop : b.close > r.stop;
            if (hit && beyond) {
              r.causal_ambiguous = true;
              r.causal_ambiguity = "LATER_BAR_TARGET_AND_S2_CLOSE";
              exitIdx = -1; break;
            }
            if (hit) { exitIdx = k; exitPx = r.target; reason = "TARGET_2R"; }
            else if (beyond) { exitIdx = k; exitPx = b.close; reason = "S2_CLOSE"; }
          }
          if (exitIdx === -1) { amb++; continue; }
          if (exitIdx === null) continue;   // still open at series end

          const gross = (long ? exitPx! - r.entry_price : r.entry_price - exitPx!) / r.risk;
          r.causal_exit_bar_time = bs[exitIdx].datetime;
          r.causal_exit_price = exitPx;
          r.causal_exit_reason = reason;
          r.causal_gross_r = gross;
          r.causal_net_r = gross - r.cost_r;
          r.causal_bars_held = exitIdx - e0;
          r.causal_hold_minutes = exitIdx === e0 ? null
            : Math.round((Date.parse(bs[exitIdx].datetime)
                          - Date.parse(r.actual_entry_time)) / 60_000);
          done++;
        }
      }
      if (inChunk.length && done % 200 < 20) {
        console.log(`  ${sym} ${start}: resolved ${done} ambiguous ${amb}`);
      }
    }
    Deno.writeTextFileSync(outFile, JSON.stringify(rows));
    console.log(`${sym}: DONE ${rows.length} rows, causal ${done}, ambiguous ${amb}`);
  }
}
