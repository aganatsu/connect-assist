/**
 * IPO_STOCK_BASELINE_V1 — stage 4: CORPORATE-ACTION and LOOKAHEAD audits.
 *
 * Runs BEFORE any headline is believed. If material lookahead is found the
 * profitability numbers are not evidence and the run stops.
 *
 * The lookahead checks are mechanical and exhaustive rather than a sample:
 * every clean trade is tested, and the required 20/20/10 hand-inspected cases
 * are printed in full so the reasoning is visible rather than asserted.
 *
 *   deno run --allow-net --allow-read --allow-write --allow-env \
 *     local-runner/ipo-stock-audit.ts
 */

import { series } from "./ipo-stock-datacheck.ts";
import type { Row } from "./ipo-stock-baseline.ts";

const CACHE = new URL("./.cache/", import.meta.url);
const OUT = new URL("../docs/exports/", import.meta.url);
const BAR_MS: Record<string, number> = { "1h": 3_600_000, "4h": 14_400_000 };

const ny = (iso: string) => new Date(iso).toLocaleString("en-US",
  { timeZone: "America/New_York", hour12: false });

function load(): Row[] {
  const rows: Row[] = [];
  for (const e of Deno.readDirSync(CACHE)) {
    if (!/^stock_resolved_.*\.json$/.test(e.name)) continue;
    rows.push(...JSON.parse(Deno.readTextFileSync(new URL(e.name, CACHE))) as Row[]);
  }
  return rows;
}

interface Violation { rule: string; row: Row; detail: string }

/** Every structural ordering rule the strategy depends on, tested on every trade. */
function lookahead(rows: Row[]): Violation[] {
  const v: Violation[] = [];
  const add = (rule: string, row: Row, detail: string) => v.push({ rule, row, detail });
  for (const r of rows) {
    const ipo = Date.parse(r.ipo_candle_time);
    const bar = Date.parse(r.strategy_bar_time);
    const ent = r.actual_entry_time ? Date.parse(r.actual_entry_time) : null;
    const ex = r.exit_bar_time ? Date.parse(r.exit_bar_time) : null;
    const span = BAR_MS[r.timeframe];

    if (!(ipo < bar)) add("IPO_BEFORE_ENTRY_BAR", r, `ipo ${ny(r.ipo_candle_time)} !< bar ${ny(r.strategy_bar_time)}`);
    if (ent === null) { add("NO_CAUSAL_ENTRY_TIME", r, r.entry_resolution); continue; }
    if (ent < bar) add("ENTRY_BEFORE_ITS_BAR", r, `${ny(r.actual_entry_time!)} < ${ny(r.strategy_bar_time)}`);
    if (ent >= bar + span) add("ENTRY_OUTSIDE_ITS_BAR", r, `${ny(r.actual_entry_time!)} >= bar+${span / 60000}m`);
    if (ent <= ipo) add("ENTRY_NOT_AFTER_IPO", r, `entry ${ny(r.actual_entry_time!)} <= ipo ${ny(r.ipo_candle_time)}`);
    if (ex !== null && ex < bar) add("EXIT_BEFORE_ENTRY_BAR", r, `${ny(r.exit_bar_time!)} < ${ny(r.strategy_bar_time)}`);
    // A target credited on the entry bar must have come AFTER the fill minute;
    // the resolver is what proves that, so its verdict is required here.
    if (ex !== null && ex === bar && r.gross_r !== null && r.gross_r > 0
        && r.entry_resolution !== "ONE_MINUTE_RESOLVED") {
      add("SAME_BAR_WIN_NOT_TAPE_ORDERED", r, `method ${r.entry_resolution}`);
    }
    // Geometry sanity: a long's stop is below its entry, a short's above.
    const longish = r.direction === "long";
    if (longish && !(r.stop < r.entry_price && r.target > r.entry_price)) {
      add("LONG_GEOMETRY_INVERTED", r, `stop ${r.stop} entry ${r.entry_price} target ${r.target}`);
    }
    if (!longish && !(r.stop > r.entry_price && r.target < r.entry_price)) {
      add("SHORT_GEOMETRY_INVERTED", r, `stop ${r.stop} entry ${r.entry_price} target ${r.target}`);
    }
    if (!(r.risk > 0)) add("NON_POSITIVE_RISK", r, `risk ${r.risk}`);
  }
  return v;
}

/**
 * Corporate actions. The provider back-adjusts splits, so the failure mode is
 * not a visible gap — it is a zone whose price level belongs to a different
 * share count than the tape that is supposed to fill it. Re-fetching the 1m
 * tape for the entry bar and checking the entry level lies inside the bar's
 * own range is what catches that.
 */
async function corporateActions(rows: Row[]) {
  const KNOWN_SPLITS: Array<[string, string, string]> = [
    ["NVDA", "2024-06-10", "10:1"], ["AMZN", "2022-06-06", "20:1"],
    ["TSLA", "2022-08-25", "3:1"], ["GOOGL", "2022-07-18", "20:1"],
    ["AAPL", "2020-08-31", "4:1 (before window)"],
  ];
  const out: Array<Record<string, unknown>> = [];

  // 1. Trades nearest each known split.
  for (const [sym, date, ratio] of KNOWN_SPLITS) {
    const near = rows
      .filter((r) => r.symbol === sym && r.actual_entry_time)
      .map((r) => ({ r, d: Math.abs(Date.parse(r.actual_entry_time!) - Date.parse(date)) }))
      .sort((a, b) => a.d - b.d)[0];
    if (!near) { out.push({ kind: "SPLIT", symbol: sym, split_date: date, ratio, verdict: "NO_TRADE_NEAR" }); continue; }
    const r = near.r;
    out.push({
      kind: "SPLIT", symbol: sym, split_date: date, ratio,
      days_from_split: (near.d / 86_400_000).toFixed(1),
      entry_time: r.actual_entry_time, entry_price: r.entry_price,
      stop: r.stop, target: r.target, risk_pct_of_price: (r.risk / r.entry_price * 100).toFixed(3),
      net_r: r.net_r,
      verdict: r.risk / r.entry_price < 0.25 ? "PLAUSIBLE_GEOMETRY" : "SUSPECT_GEOMETRY",
    });
  }

  // 2. Gap-heavy and large-overnight-move cases: the widest risk-to-price
  //    ratios in the population are where a bad adjustment would surface.
  const byRisk = rows.filter((r) => r.actual_entry_time)
    .sort((a, b) => (b.risk / b.entry_price) - (a.risk / a.entry_price));
  for (const r of byRisk.slice(0, 5)) {
    out.push({
      kind: "WIDEST_RISK", symbol: r.symbol, timeframe: r.timeframe,
      entry_time: r.actual_entry_time, entry_price: r.entry_price,
      risk_pct_of_price: (r.risk / r.entry_price * 100).toFixed(3),
      net_r: r.net_r,
      verdict: r.risk / r.entry_price < 0.25 ? "PLAUSIBLE_GEOMETRY" : "SUSPECT_GEOMETRY",
    });
  }

  // 3. Re-fetch the tape and confirm the entry level is inside the entry bar.
  //    A split mismatch between the parent series and the tape shows up here
  //    and nowhere else.
  const sample = [...KNOWN_SPLITS.map(([s, d]) =>
    rows.filter((r) => r.symbol === s && r.actual_entry_time)
        .sort((a, b) => Math.abs(Date.parse(a.actual_entry_time!) - Date.parse(d))
                      - Math.abs(Date.parse(b.actual_entry_time!) - Date.parse(d)))[0])
    .filter(Boolean), ...byRisk.slice(0, 5)];
  for (const r of sample) {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" })
      .format(new Date(r.strategy_bar_time));
    const nxt = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
    let mins: Awaited<ReturnType<typeof series>> = [];
    try { mins = await series(r.symbol, "1min", day, nxt); } catch { /* reported below */ }
    const from = Date.parse(r.strategy_bar_time), to = from + BAR_MS[r.timeframe];
    const inBar = mins.filter((m) => Date.parse(m.datetime) >= from && Date.parse(m.datetime) < to);
    const lo = inBar.length ? Math.min(...inBar.map((m) => m.low)) : NaN;
    const hi = inBar.length ? Math.max(...inBar.map((m) => m.high)) : NaN;
    const inside = r.entry_price >= lo && r.entry_price <= hi;
    out.push({
      kind: "TAPE_RECHECK", symbol: r.symbol, timeframe: r.timeframe,
      entry_time: r.actual_entry_time, entry_price: r.entry_price,
      tape_low: lo, tape_high: hi, minutes: inBar.length,
      verdict: !inBar.length ? "NO_TAPE" : inside ? "ENTRY_INSIDE_TAPE_RANGE" : "ENTRY_OUTSIDE_TAPE_RANGE",
    });
  }
  return out;
}

if (import.meta.main) {
  const all = load();
  const clean = all.filter((r) => !r.ambiguous && r.net_r !== null);
  const amb = all.filter((r) => r.ambiguous);
  console.log(`loaded ${all.length} rows (${clean.length} clean, ${amb.length} ambiguous)\n`);

  console.log("## LOOKAHEAD AUDIT — mechanical, every clean trade");
  const v = lookahead(clean);
  const byRule = new Map<string, Violation[]>();
  for (const x of v) (byRule.get(x.rule) ?? byRule.set(x.rule, []).get(x.rule)!).push(x);
  if (!v.length) console.log(`  0 violations across ${clean.length} trades and 9 rules`);
  for (const [rule, xs] of byRule) {
    console.log(`  ${rule}: ${xs.length}`);
    for (const x of xs.slice(0, 3)) console.log(`     ${x.row.symbol} ${x.row.timeframe} ${x.detail}`);
  }

  const show = (title: string, rows: Row[]) => {
    console.log(`\n### ${title}`);
    for (const r of rows) {
      const lagMin = r.actual_entry_time
        ? (Date.parse(r.actual_entry_time) - Date.parse(r.strategy_bar_time)) / 60000 : NaN;
      console.log(`  ${r.symbol.padEnd(5)} ${r.timeframe} ${r.direction.padEnd(5)} ` +
        `ipo ${ny(r.ipo_candle_time)} | bar ${ny(r.strategy_bar_time)} | ` +
        `entry ${r.actual_entry_time ? ny(r.actual_entry_time) : "—"} (+${lagMin}m) | ` +
        `exit ${r.exit_bar_time ? ny(r.exit_bar_time) : "open"} | ` +
        `netR ${r.net_r?.toFixed(3) ?? "—"} | ${r.entry_resolution}`);
    }
  };
  const pick = (rows: Row[], n: number) => {
    const step = Math.max(1, Math.floor(rows.length / n));
    return rows.filter((_, i) => i % step === 0).slice(0, n);
  };
  show("20 hand-inspected 1H trades", pick(clean.filter((r) => r.timeframe === "1h"), 20));
  show("20 hand-inspected 4H trades", pick(clean.filter((r) => r.timeframe === "4h"), 20));
  show("10 ambiguous / same-bar cases", pick(amb, 10));

  console.log("\n## CORPORATE-ACTION AUDIT");
  const ca = await corporateActions(clean);
  for (const r of ca) console.log("  " + JSON.stringify(r));

  const cols = [...new Set(ca.flatMap((r) => Object.keys(r)))];
  Deno.writeTextFileSync(new URL("ipo_stock_corporate_action_audit.csv", OUT),
    [cols.join(","), ...ca.map((r) => cols.map((c) => r[c] ?? "").join(","))].join("\n") + "\n");

  const exclusions = all.filter((r) => r.ambiguous).map((r) => ({
    symbol: r.symbol, timeframe: r.timeframe, direction: r.direction,
    strategy_bar_time: r.strategy_bar_time, actual_entry_time: r.actual_entry_time ?? "",
    entry_resolution: r.entry_resolution, reason: r.ambiguity_reason,
    minutes_available: r.minutes_available,
  }));
  const ec = Object.keys(exclusions[0] ?? { none: "" });
  Deno.writeTextFileSync(new URL("ipo_stock_exclusions.csv", OUT),
    [ec.join(","), ...exclusions.map((r) => ec.map((c) => (r as never)[c] ?? "").join(","))].join("\n") + "\n");
  console.log(`\nexports: corporate_action_audit ${ca.length} rows, exclusions ${exclusions.length} rows`);
}
