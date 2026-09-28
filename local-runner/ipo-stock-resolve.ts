/**
 * IPO_STOCK_BASELINE_V1 — stage 2: CAUSAL 1m ENTRY RESOLUTION. READ-ONLY.
 *
 * Applies the same standard the forex baseline was accepted under. The first
 * 1m candle that actually reaches the entry price sets `actual_entry_time`;
 * `strategy_bar_time` is kept separately and is never used as the entry time.
 *
 * Same-parent-bar entry/target/stop ordering goes through the production
 * `resolveBar`, not a local re-implementation. Anything it refuses to order is
 * marked ambiguous and excluded from clean profitability, never guessed.
 *
 * Minutes are fetched in multi-day chunks and consumed streaming — one symbol
 * needs ~630 trading days of tape and keeping it all resident is ~500 MB.
 *
 *   deno run --allow-net --allow-read --allow-write --allow-env \
 *     local-runner/ipo-stock-resolve.ts [SYMBOL]
 */

import {
  firstEntryMinute, minutesInBar, resolveBar,
} from "../supabase/functions/_shared/ipoCausalOrdering.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { series } from "./ipo-stock-datacheck.ts";
import type { Row } from "./ipo-stock-baseline.ts";

const BAR_MS: Record<string, number> = { "1h": 3_600_000, "4h": 14_400_000 };
const CHUNK_DAYS = 15;          // ~10 trading days x 390 bars, under the 5000 cap
const RTH_OPEN = 9 * 60 + 30;   // 09:30 ET
const RTH_CLOSE = 16 * 60;      // 16:00 ET

const nyParts = (iso: string) => {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(iso));
  const g = Object.fromEntries(f.map((p) => [p.type, p.value]));
  return { day: `${g.year}-${g.month}-${g.day}`, mins: +g.hour * 60 + +g.minute };
};

if (import.meta.main) {
  const only = Deno.args[0];
  const all: Row[] = [];
  for (const e of Deno.readDirSync(new URL("./.cache/", import.meta.url))) {
    if (!/^stock_rows_.*\.json$/.test(e.name)) continue;
    const d = JSON.parse(Deno.readTextFileSync(new URL(`./.cache/${e.name}`, import.meta.url)));
    all.push(...d.rows as Row[]);
  }
  const symbols = only ? [only] : [...new Set(all.map((r) => r.symbol))].sort();

  for (const sym of symbols) {
    const outFile = new URL(`./.cache/stock_resolved_${sym}.json`, import.meta.url);
    try { Deno.readTextFileSync(outFile); console.log(`${sym}: already resolved`); continue; }
    catch { /* not yet */ }

    const rows = all.filter((r) => r.symbol === sym);
    // Index by the NY day of the entry bar so a chunk can serve every trade in it.
    const byDay = new Map<string, Row[]>();
    for (const r of rows) {
      const d = nyParts(r.strategy_bar_time).day;
      (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(r);
    }
    const days = [...byDay.keys()].sort();
    let resolved = 0, ambiguous = 0, noTape = 0, noTouch = 0;

    for (let i = 0; i < days.length;) {
      const start = days[i];
      const endMs = Date.parse(start) + CHUNK_DAYS * 86_400_000;
      const end = new Date(endMs).toISOString().slice(0, 10);
      const inChunk: string[] = [];
      while (i < days.length && Date.parse(days[i]) < endMs) inChunk.push(days[i++]);

      let mins: Candle[] = [];
      try { mins = await series(sym, "1min", start, end); }
      catch (e) { console.log(`  ${sym} ${start}: fetch failed ${(e as Error).message}`); }

      for (const d of inChunk) {
        const dayMins = mins.filter((m) => nyParts(m.datetime).day === d);
        for (const r of byDay.get(d)!) {
          r.minutes_available = dayMins.length;
          if (dayMins.length === 0) {
            r.entry_resolution = "NO_1M_TAPE"; r.ambiguous = true;
            r.ambiguity_reason = "NO_1M_TAPE"; noTape++; continue;
          }
          const barMs = BAR_MS[r.timeframe];
          const bar = { datetime: r.strategy_bar_time } as Candle;
          const hit = firstEntryMinute(dayMins, bar, barMs,
            r.direction as "long" | "short", r.entry_price);
          if (!hit) {
            // The parent bar says E2 was reached and the tape does not. A feed
            // disagreement, not a fill at the bar open.
            r.entry_resolution = "NO_MINUTE_REACHED_ENTRY"; r.ambiguous = true;
            r.ambiguity_reason = "FEED_DISAGREEMENT"; noTouch++; continue;
          }
          r.actual_entry_time = hit.datetime;

          // Same-bar ordering, through the production resolver.
          const inBar = minutesInBar(dayMins, bar, barMs);
          const parent = {
            datetime: r.strategy_bar_time,
            open: inBar[0].open,
            high: Math.max(...inBar.map((m) => m.high)),
            low: Math.min(...inBar.map((m) => m.low)),
            close: inBar[inBar.length - 1].close, volume: 0,
          } as Candle;
          const o = resolveBar({
            direction: r.direction as "long" | "short",
            entryPrice: r.entry_price, targetPrice: r.target,
            s2InvalidationLevel: r.stop, bar: parent, barMs,
            isEntryBar: true, minutes: dayMins, ticks: null, minutesFinal: true,
          });
          r.entry_resolution = o.method;
          if (o.kind === "AMBIGUOUS_OPEN_OR_CLOSED" || o.kind === "UNRESOLVED_TERMINAL") {
            r.ambiguous = true; r.ambiguity_reason = o.kind; ambiguous++;
          } else resolved++;

          if (r.exit_bar_time) {
            r.hold_minutes = Math.round(
              (Date.parse(r.exit_bar_time) - Date.parse(hit.datetime)) / 60_000);
          }
          const p = nyParts(hit.datetime);
          if (p.mins < RTH_OPEN || p.mins >= RTH_CLOSE) {
            r.ambiguity_reason = (r.ambiguity_reason ? r.ambiguity_reason + ";" : "")
              + "ENTRY_OUTSIDE_RTH";
          }
        }
      }
      if (inChunk.length) {
        console.log(`  ${sym} ${start}..${end}: ${inChunk.length} days, ` +
          `${mins.length} minutes, resolved ${resolved} amb ${ambiguous} ` +
          `noTape ${noTape} noTouch ${noTouch}`);
      }
    }
    Deno.writeTextFileSync(outFile, JSON.stringify(rows));
    console.log(`${sym}: DONE ${rows.length} rows, clean ${resolved}, ` +
      `ambiguous ${ambiguous}, noTape ${noTape}, noTouch ${noTouch}`);
  }
}
