/**
 * IPO_BASELINE_1H_4H_CAUSAL_V2 — live-period gate.
 *
 * The corrected engine must reproduce IPO_24_TRADE_CAUSAL_AUDIT_V1 on the
 * forward-paper period 2026-09-24 -> 2026-10-02: the 24 recorded trades, the
 * two suppressed USD/JPY trades (09-30 20:00 short, 10-01 11:30 long), and the
 * one open ORDERING_AMBIGUOUS position — corrected total -3.144R. Anything
 * else stops the rebuild.
 *
 * Inputs: the live engines' own persisted bars and the audit's 1m tape
 * (local-runner/.cache/ipo-24-audit/). Each instrument runs at its live
 * timeframe with its own slot, flat at the period start, as paper was.
 */

import { IPO_INSTRUMENTS, engineConfig } from "../supabase/functions/_shared/ipoInstruments.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { minuteIndex, scanSeries, simulateSlot, type Selection, type SimTrade } from "./ipoCausalV2.ts";

const CACHE = new URL("./.cache/ipo-24-audit/", import.meta.url);
const read = <T>(n: string): T => JSON.parse(Deno.readTextFileSync(new URL(n, CACHE)));
const FROM = Date.parse("2026-09-24T18:00:00Z"), TO = Date.parse("2026-10-02T13:00:00Z");
const EXPECTED_TOTAL = -3.144, RECORDED_TOTAL = 4.263, SUPPRESSED_TOTAL = -7.407;
const iso = (s: string) => new Date(Date.parse(s)).toISOString().replace(".000Z", "Z");

export interface LiveCheck { pass: boolean; lines: string[]; trades: Array<SimTrade & { symbol: string; matched: string }> }

export function runLiveCheck(selection: Selection = "TOUCH_ORDER"): LiveCheck {
  const rows = read<Record<string, any>[]>("rows.json");
  const recorded = new Map(rows.map((r) => [`${r.symbol}|${iso(r.strategy_bar_time)}|${iso(r.ipo_candle_time)}`, r]));
  const AMB = "USD/JPY|2026-10-01T15:30:00Z|2026-09-30T23:00:00Z";
  const SUPP = new Set(["USD/JPY|2026-09-30T20:00:00Z|2026-09-29T23:30:00Z", "USD/JPY|2026-10-01T11:30:00Z|2026-10-01T03:30:00Z"]);
  const all: LiveCheck["trades"] = [];
  for (const inst of IPO_INSTRUMENTS) {
    const snap = read<{ bars: Candle[] }>(`engine_${inst.instrument.replace("/", "")}.json`);
    const tape = read<Candle[]>(`${inst.instrument.replace("/", "")}_1min.json`);
    const minutesFor = minuteIndex(tape, snap.bars, inst.barMs);
    const pes = scanSeries(inst.timeframe, snap.bars, inst.barMs, engineConfig(inst), minutesFor, [], [selection]).pes[selection];
    const inPeriod = pes.filter((p) => Date.parse(p.barTime) >= FROM && Date.parse(p.barTime) <= TO);
    const { trades } = simulateSlot([{ tf: inst.timeframe, bars: snap.bars, barMs: inst.barMs, pes: inPeriod, minutesFor }], inst.costPerSide);
    for (const t of trades) {
      const key = `${inst.instrument}|${t.pe.barTime}|${snap.bars[t.pe.cand.k].datetime}`;
      all.push({ ...t, symbol: inst.instrument, matched: recorded.has(key) ? "RECORDED" : key === AMB ? "OPEN_AMBIGUOUS" : SUPP.has(key) ? "SUPPRESSED" : "UNEXPECTED" });
    }
  }
  const lines: string[] = [];
  const by = (m: string) => all.filter((t) => t.matched === m);
  const sum = (ts: typeof all) => ts.reduce((a, t) => a + (t.netR ?? 0), 0);
  const rec = by("RECORDED"), supp = by("SUPPRESSED"), amb = by("OPEN_AMBIGUOUS"), unexpected = by("UNEXPECTED");
  // per-trade R against the recorded rows (BTC cost is priced at the fill in V2, at the touch-bar close live)
  let maxDiff = 0, worst = "";
  for (const t of rec) {
    const r = recorded.get(`${t.symbol}|${t.pe.barTime}|${new Date(t.pe.fillMs).toISOString()}`) ??
      [...recorded.values()].find((x) => x.symbol === t.symbol && iso(x.strategy_bar_time) === t.pe.barTime)!;
    const d = Math.abs((t.netR ?? NaN) - r.realized_r);
    if (!(d <= maxDiff)) { maxDiff = d; worst = `${t.symbol} ${t.pe.barTime}`; }
  }
  const resolvable = [...rec, ...supp];
  const total = sum(resolvable);
  lines.push(`[${selection}] live period: ${all.length} V2 entries — recorded ${rec.length}/24, suppressed ${supp.length}/2, open-ambiguous ${amb.length}/1, unexpected ${unexpected.length}`);
  lines.push(`recorded set ${sum(rec).toFixed(4)}R (audit ${RECORDED_TOTAL}), suppressed ${sum(supp).toFixed(4)}R (audit ${SUPPRESSED_TOTAL}), corrected total ${total.toFixed(4)}R (audit ${EXPECTED_TOTAL})`);
  lines.push(`largest per-trade R difference vs recorded: ${maxDiff.toFixed(5)}R (${worst})`);
  lines.push(`ambiguous entry: ${amb.map((t) => `${t.symbol} ${t.pe.barTime} ${t.res.outcome} alt=${t.res.altBranch} open=${t.res.openBranch}`).join("; ")}`);
  for (const t of unexpected) lines.push(`UNEXPECTED ${t.symbol} ${t.pe.barTime} ${t.res.outcome} ${t.netR}`);
  const pass = rec.length === 24 && supp.length === 2 && amb.length === 1 && unexpected.length === 0 &&
    Math.abs(total - EXPECTED_TOTAL) < 0.005 && maxDiff < 0.005 && amb[0].netR === null;
  lines.push(`LIVE-PERIOD GATE: ${pass ? "PASS" : "FAIL"}`);
  return { pass, lines, trades: all };
}

if (import.meta.main) {
  const r = runLiveCheck((Deno.args[0] as Selection) ?? "TOUCH_ORDER");
  for (const l of r.lines) console.log(l);
  for (const t of r.trades) console.log(`  ${t.matched.padEnd(15)} ${t.symbol} ${t.pe.barTime} fill ${t.pe.fillMinute} ${t.res.outcome}${t.res.sameBarS2 ? " (same-bar S2)" : ""} ${t.netR === null ? "-" : t.netR.toFixed(4)}R`);
  if (!r.pass) Deno.exit(2);
}
