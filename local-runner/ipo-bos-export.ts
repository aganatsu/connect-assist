/**
 * IPO_BOS_REQUIRED_V1 — materialise the raw trade list.
 *
 * READ-ONLY. Re-runs the completed experiment to recover per-trade detail the
 * summary run did not persist: it stored bar INDICES only, so timestamps,
 * prices, OHLC, zones and exit reasons had to be rebuilt. The re-run is
 * deterministic — pure functions over cached bars, no clock, no network — and
 * the reconciliation at the end proves it reproduced the published metrics
 * rather than quietly producing different ones.
 *
 * No strategy change. Both arms use exactly the configuration the experiment
 * used, including the 1800-bar window cap.
 *
 * BOS_REQUIRED IS NOT A SUBSET OF CONTROL. Refusing an entry frees the
 * one-position-per-instrument slot earlier, so a later touch that control had
 * blocked can enter in the experiment arm and appear in no control row. Those
 * are classified BOS_NEW_ENTRY_DUE_TO_FREED_SLOT and reported separately —
 * treating the arm as a filtered subset would hide them.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-env local-runner/ipo-bos-export.ts
 */

import type { EngineConfig, LiveTrade } from "../supabase/functions/_shared/ipoLiveEngine.ts";
import { replayIncremental as replay } from "../supabase/functions/_shared/ipoIncrementalEngine.ts";
import { ipoGeometry } from "../supabase/functions/_shared/ipoZones.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { WINDOWS } from "./ipo-bos-fetch.ts";
import { bosAfterOrigin, bosEntryGate } from "./ipo-bos-gate.ts";

const CACHE = "/tmp/ipo-bos-data";
const OUT = "/tmp/ipo-bos-export";
const MAX_BARS = 1800;

/** Same key compareEngines uses to decide whether two trades are the same trade. */
const tkey = (w: string, t: { ipoIndex: number; entryIndex: number }) =>
  `${w}|${t.ipoIndex}@${t.entryIndex}`;

type Classification =
  | "BOS_RETAINED" | "BOS_REMOVED" | "BOS_NEW_ENTRY_DUE_TO_FREED_SLOT";

interface Row {
  classification: Classification;
  arm: "CONTROL" | "BOS_REQUIRED";
  instrument: string; window: string; strategy_timeframe: string;
  direction: string; ipo_kind: string;

  ipo_origin_timestamp: string;
  ipo_open: number; ipo_high: number; ipo_low: number; ipo_close: number;
  ipo_zone_high: number; ipo_zone_low: number; ipo_midpoint: number;
  ipo_extent_invalidation: number;

  ipo_touch_timestamp: string; entry_timestamp: string; entry_price: number;
  s2_price: number; target_price: number; risk_price: number;

  bos_required: boolean; bos_confirmed_before_entry: boolean;
  bos_timestamp: string; bos_structural_level: string; bos_direction: string;
  bars_origin_to_bos: string; bars_bos_to_entry: string;

  one_minute_ordering_used: "NO";
  one_minute_entry_timestamp: string;
  one_minute_target_timestamp: string;
  one_minute_s2_ordering: string;

  exit_timestamp: string; exit_price: string; exit_reason: string;
  realized_r: string; cost_r: number; mae_r: number; mfe_r: number;
  excluded_from_stats: boolean; ambiguity: string;
}

function build(
  arm: Row["arm"], cls: Classification, w: typeof WINDOWS[number], tf: string,
  bars: Candle[], t: LiveTrade,
): Row {
  const ipo = bars[t.ipoIndex];
  const geo = ipoGeometry(ipo, t.direction);
  const long = t.direction === "demand";

  // BOS as knowable strictly before the entry bar — the same call the gate makes.
  const bos = bosAfterOrigin(bars.slice(0, t.entryIndex), t.ipoIndex, t.direction);

  // Exit reason, from the engine's own precedence: S2 close-invalidation is
  // tested BEFORE target, so a bar that does both resolves to S2.
  let reason = "OPEN_AT_WINDOW_END";
  const amb: string[] = [];
  if (t.exitIndex !== null) {
    const c = bars[t.exitIndex];
    const closedBeyond = long ? c.close < t.stop : c.close > t.stop;
    const hitTarget = long ? c.high >= t.target : c.low <= t.target;
    reason = closedBeyond ? "S2_CLOSE_INVALIDATION" : "TARGET";
    // Both on one bar: the engine resolved it by precedence, not by evidence.
    if (closedBeyond && hitTarget) amb.push("SAME_BAR_TARGET_AND_S2_RESOLVED_AS_S2");
    if (t.exitIndex === t.entryIndex) amb.push("SAME_BAR_ENTRY_AND_EXIT");
  }

  return {
    classification: cls, arm,
    instrument: t.instrument, window: w.id, strategy_timeframe: tf,
    direction: t.direction, ipo_kind: long ? "bullish_IPO_demand" : "bearish_IPO_supply",

    ipo_origin_timestamp: ipo.datetime,
    ipo_open: ipo.open, ipo_high: ipo.high, ipo_low: ipo.low, ipo_close: ipo.close,
    ipo_zone_high: geo.zoneHigh, ipo_zone_low: geo.zoneLow,
    ipo_midpoint: geo.distal, ipo_extent_invalidation: geo.extent,

    // The engine enters on the bar it detects the touch, so touch and entry
    // are the same bar by construction. Both emitted rather than one, because
    // they are different concepts and a future variant could separate them.
    ipo_touch_timestamp: bars[t.entryIndex].datetime,
    entry_timestamp: bars[t.entryIndex].datetime,
    entry_price: t.entry, s2_price: t.stop, target_price: t.target, risk_price: t.risk,

    bos_required: arm === "BOS_REQUIRED",
    bos_confirmed_before_entry: bos !== null,
    bos_timestamp: bos ? bars[bos.index].datetime : "",
    // The break bar's close is what confirms it; the prior structural level it
    // closed through is internal to the detector and not surfaced per-entry.
    bos_structural_level: bos ? String(bars[bos.index].close) : "",
    bos_direction: bos ? bos.type : "",
    bars_origin_to_bos: bos ? String(bos.index - t.ipoIndex) : "",
    bars_bos_to_entry: bos ? String(t.entryIndex - bos.index) : "",

    // This backtester decides on strategy-timeframe bars only. The
    // `1m-ordering-v1` contract belongs to the IPO PAPER runner and was not
    // used here, so these are empty by fact rather than by omission.
    one_minute_ordering_used: "NO",
    one_minute_entry_timestamp: "", one_minute_target_timestamp: "",
    one_minute_s2_ordering: "",

    exit_timestamp: t.exitIndex !== null ? bars[t.exitIndex].datetime : "",
    exit_price: t.exitPrice !== null ? String(t.exitPrice) : "",
    exit_reason: reason,
    realized_r: t.netR !== null ? String(t.netR) : "",
    cost_r: t.costR, mae_r: t.mae, mfe_r: t.mfe,
    // The engine counts only closed trades; one still open at the window edge
    // has no realized R and is excluded from every published statistic.
    excluded_from_stats: t.netR === null,
    ambiguity: amb.join("|"),
  };
}

const csv = (rows: Row[]): string => {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc((r as never)[c])).join(","))].join("\n") + "\n";
};

// ── run both arms ────────────────────────────────────────────────────────────
const control: Row[] = [], bosReq: Row[] = [], removed: Row[] = [], retained: Row[] = [], newEntry: Row[] = [];

for (const w of WINDOWS) {
  const inst = IPO_INSTRUMENTS.find((i) => i.instrument === w.instrument)!;
  let bars: Candle[];
  try {
    bars = (JSON.parse(await Deno.readTextFile(`${CACHE}/${w.id}_${w.tf}.json`)) as Candle[]).slice(-MAX_BARS);
  } catch { console.error(`  MISSING ${w.id}`); continue; }

  const base: EngineConfig = {
    instrument: inst.instrument, timeframe: inst.timeframe,
    highVolOnly: inst.highVolOnly, costPerSide: inst.costPerSide,
  };
  const ctl = replay(bars, base).trades;
  const exp = replay(bars, { ...base, entryGate: bosEntryGate }).trades;

  const expKeys = new Set(exp.map((t) => tkey(w.id, t)));
  const ctlKeys = new Set(ctl.map((t) => tkey(w.id, t)));

  for (const t of ctl) {
    const inExp = expKeys.has(tkey(w.id, t));
    const cls: Classification = inExp ? "BOS_RETAINED" : "BOS_REMOVED";
    const r = build("CONTROL", cls, w, inst.timeframe, bars, t);
    control.push(r);
    (inExp ? retained : removed).push(r);
  }
  for (const t of exp) {
    const isNew = !ctlKeys.has(tkey(w.id, t));
    const cls: Classification = isNew ? "BOS_NEW_ENTRY_DUE_TO_FREED_SLOT" : "BOS_RETAINED";
    const r = build("BOS_REQUIRED", cls, w, inst.timeframe, bars, t);
    bosReq.push(r);
    if (isNew) newEntry.push(r);
  }
  console.error(`  ${w.id.padEnd(20)} ctl ${String(ctl.length).padStart(4)}  bos ${String(exp.length).padStart(4)}`);
}

await Deno.mkdir(OUT, { recursive: true });
const files: Array<[string, Row[]]> = [
  ["ipo_control_trades.csv", control],
  ["ipo_bos_required_trades.csv", bosReq],
  ["ipo_bos_removed_trades.csv", removed],
  ["ipo_bos_retained_matched_trades.csv", retained],
  ["ipo_bos_new_entries_freed_slot.csv", newEntry],
];
for (const [name, rows] of files) await Deno.writeTextFile(`${OUT}/${name}`, csv(rows));

// ── reconciliation ───────────────────────────────────────────────────────────
const closed = (rs: Row[]) => rs.filter((r) => !r.excluded_from_stats).map((r) => Number(r.realized_r));
const stat = (rs: Row[]) => {
  const v = closed(rs), n = v.length;
  if (!n) return { n: 0, wr: 0, exp: 0, pf: 0, tot: 0 };
  const w = v.filter((x) => x > 0), g = w.reduce((a, b) => a + b, 0);
  const gl = Math.abs(v.filter((x) => x <= 0).reduce((a, b) => a + b, 0));
  return { n, wr: (w.length / n) * 100, exp: v.reduce((a, b) => a + b, 0) / n,
    pf: gl ? g / gl : Infinity, tot: v.reduce((a, b) => a + b, 0) };
};

console.log(`\n${"=".repeat(78)}\nRAW TRADE EXPORT — IPO_BOS_REQUIRED_V1\n${"=".repeat(78)}\n`);
for (const [name, rows] of files) {
  console.log(`  ${OUT}/${name.padEnd(38)} ${String(rows.length).padStart(5)} rows`);
}
console.log(`\n── reconciliation vs published experiment ──`);
console.log(`  ${"population".padEnd(34)} ${"n".padStart(5)} ${"win%".padStart(6)} ${"expR".padStart(8)} ${"PF".padStart(6)} ${"totalR".padStart(9)}`);
const show = (lab: string, rs: Row[]) => {
  const s = stat(rs);
  console.log(`  ${lab.padEnd(34)} ${String(s.n).padStart(5)} ${s.wr.toFixed(1).padStart(6)} ${(s.exp>=0?"+":"")+s.exp.toFixed(3).padStart(7)} ${(s.pf===Infinity?"inf":s.pf.toFixed(2)).padStart(6)} ${((s.tot>=0?"+":"")+s.tot.toFixed(1)).padStart(9)}`);
};
show("CONTROL            (pub 1121/71.5/+0.587/2.00/+657.9)", control);
show("BOS_REQUIRED       (pub  713/72.4/+0.617/2.09/+439.8)", bosReq);
show("BOS_REMOVED", removed);
show("BOS_RETAINED (control side)", retained);
show("BOS_NEW_ENTRY_DUE_TO_FREED_SLOT", newEntry);

console.log(`\n── set arithmetic ──`);
console.log(`  control            = retained + removed        : ${control.length} = ${retained.length} + ${removed.length} -> ${retained.length + removed.length === control.length ? "OK" : "MISMATCH"}`);
console.log(`  bos_required       = retained + new_entries     : ${bosReq.length} = ${retained.length} + ${newEntry.length} -> ${retained.length + newEntry.length === bosReq.length ? "OK" : "MISMATCH"}`);
console.log(`  BOS_REQUIRED is NOT a subset of CONTROL: ${newEntry.length} trade(s) exist only because the slot freed.`);
