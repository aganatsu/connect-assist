/**
 * IPO_BASELINE_1H_4H_CAUSAL_V2 — aggregation, reconciliation and exports.
 *
 * Reads the twelve per-window results (ipo-baseline-causal-v2.ts) and the
 * frozen V1 export, and writes:
 *   docs/exports/ipo_baseline_causal_v2_trades.csv
 *   docs/exports/ipo_baseline_causal_v2_reconciliation.csv
 *   docs/exports/ipo_baseline_causal_v2_suppressed_trades.csv
 *   docs/exports/ipo_baseline_causal_v2_data_integrity.csv
 *   local-runner/.cache/ipo-v2/tables.md   (figures for the report)
 *
 * Variants:  V2         = PRODUCTION_BAR zone selection (as specified)
 *            V2_STRICT  = TOUCH_ORDER zone selection (also removes the
 *                         zone-selection look-ahead)
 *
 *   deno run --allow-read --allow-write local-runner/ipo-baseline-causal-v2-report.ts
 */

import { readCsv } from "./ipo-entry-m1-fetch.ts";
import { OUT_DIR, SPECS, type V2Trade } from "./ipo-baseline-causal-v2.ts";

const EXP = new URL("../docs/exports/", import.meta.url);
const TABLES = new URL("./.cache/ipo-v2/tables.md", import.meta.url);
const FROZEN = new URL("../docs/exports/ipo_1h_4h_combined_clean.csv", import.meta.url);
const VARIANTS = [["V2", "PRODUCTION_BAR"], ["V2_STRICT", "TOUCH_ORDER"]] as const;
const MONTH_MS = 30.4375 * 86_400_000;

const wins = SPECS.map((s) => JSON.parse(Deno.readTextFileSync(new URL(`${s.m1}.json`, OUT_DIR))));
const frozen = readCsv(FROZEN);
const esc = (v: unknown) => { const s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join(";") : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (rows: Record<string, unknown>[], cols?: string[]) => {
  const c = cols ?? Object.keys(rows[0] ?? {});
  return [c.join(","), ...rows.map((r) => c.map((k) => esc(r[k])).join(","))].join("\n") + "\n";
};
const f3 = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);

// ── metrics ────────────────────────────────────────────────────────────────
interface Metric { n: number; wins: number; losses: number; wr: number; avgW: number; avgL: number; exp: number; pf: number; net: number; dd: number; perMonth: number }
const instMonths = wins.reduce((a, w) => a + (Date.parse(w.decision_end) - Date.parse(w.decision_start)) / MONTH_MS, 0);
function metric(rs: Array<{ net: number; at: number }>, months = instMonths): Metric {
  const r = rs.map((x) => x.net), w = r.filter((x) => x > 0), l = r.filter((x) => x <= 0);
  const sw = w.reduce((a, b) => a + b, 0), sl = l.reduce((a, b) => a + b, 0);
  let eq = 0, pk = 0, dd = 0;
  for (const x of [...rs].sort((a, b) => a.at - b.at)) { eq += x.net; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  return { n: r.length, wins: w.length, losses: l.length, wr: r.length ? w.length / r.length : 0, avgW: w.length ? sw / w.length : 0,
    avgL: l.length ? sl / l.length : 0, exp: r.length ? (sw + sl) / r.length : 0, pf: sl < 0 ? sw / -sl : Infinity, net: sw + sl, dd,
    perMonth: r.length / months };
}
const fmtM = (m: Metric) => `| ${m.n} | ${m.wins} | ${m.losses} | ${(100 * m.wr).toFixed(1)}% | ${f3(m.avgW)} | ${f3(m.avgL)} | ${f3(m.exp)} | ${Number.isFinite(m.pf) ? m.pf.toFixed(2) : "inf"} | ${f3(m.net)} | ${m.dd.toFixed(1)} | ${m.perMonth.toFixed(1)} |`;
const HDR = "| n | wins | losses | WR | avg win R | avg loss R | expectancy R | PF | net R | chron. max DD R | trades/month |\n|---|---|---|---|---|---|---|---|---|---|---|";

// ── V1 reference ───────────────────────────────────────────────────────────
const v1 = frozen.map((r) => ({ ...r, net: +r.net_r, at: Date.parse(r.m1_entry_time) }));
const v1M = metric(v1);
const monthsBy = (pred: (inst: string) => boolean) => wins.filter((w) => pred(w.instrument))
  .reduce((a, w) => a + (Date.parse(w.decision_end) - Date.parse(w.decision_start)) / MONTH_MS, 0);

const md: string[] = [];
md.push(`instrument-months (decision spans): ${instMonths.toFixed(2)}`);
md.push(`V1 recomputed: ${fmtM(v1M)}`);
md.push("", "## V1 parity control (exact copy of V1's ARM C + resolver on the rebuilt inputs)");
let pm = 0, po = 0, pf = 0, pe = 0;
for (const w of wins) {
  pm += w.parity.matched; po += w.parity.outcome_identical; pf += w.parity.frozen; pe += w.parity.extra.length;
  md.push(`${w.window}: span ${w.decision_start} -> ${w.decision_end} (${w.m1_pages} pages, ${w.m1_bars} 1m bars) | frozen ${w.parity.frozen}, matched ${w.parity.matched}, identical ${w.parity.outcome_identical}, extra ${w.parity.extra.length}, missing ${w.parity.missing.length}`);
}
md.push(`TOTAL parity: ${pm}/${pf} matched, ${po} identical outcome+R, ${pe} extra`);

// ── per variant ────────────────────────────────────────────────────────────
const allTradeRows: Record<string, unknown>[] = [], recRows: Record<string, unknown>[] = [], suppRows: Record<string, unknown>[] = [];
const keyT = (w: string, tf: string, ipo: string, bar: string) => `${w}|${tf}|${ipo}|${bar}`;
const keyZ = (w: string, tf: string, ipo: string, dir: string) => `${w}|${tf}|${ipo}|${dir}`;
const v1Outcome = (r: Record<string, string>) => (r.exit_reason === "TARGET" ? "TARGET" : "S2_CLOSE");

for (const [label, sel] of VARIANTS) {
  const trades: V2Trade[] = wins.flatMap((w) => w[sel].trades as V2Trade[]);
  const blocked = wins.flatMap((w) => (w[sel].blocked as any[]).map((b) => ({ ...b, window: w.window })));
  const scope = trades.filter((t) => t.inScope);
  const resolvable = scope.filter((t) => t.net_r !== null && (t.outcome === "TARGET" || t.outcome === "S2_CLOSE"));
  const asM = (ts: V2Trade[]) => ts.map((t) => ({ net: t.net_r as number, at: Date.parse(t.fill_minute ?? t.touch_bar_time) }));
  const M = metric(asM(resolvable));
  md.push("", `## ${label} (${sel})`);
  md.push(`in scope ${scope.length}: resolvable ${resolvable.length}, AMBIGUOUS ${scope.filter((t) => t.outcome === "AMBIGUOUS").length} ` +
    `(same-minute entry/target ${scope.filter((t) => t.outcome === "AMBIGUOUS" && t.alt_branch === "CLOSED_AT_TARGET").length}, ` +
    `1m/strategy-bar disagreement ${scope.filter((t) => t.outcome === "AMBIGUOUS" && t.alt_branch === "NO_POSITION").length}), ` +
    `VOID ${scope.filter((t) => t.outcome === "VOID").length}, OPEN_AT_DATA_END ${scope.filter((t) => t.outcome === "OPEN_AT_DATA_END").length}`);
  md.push(`warm-up trades (slot continuity only, not counted): ${trades.length - scope.length}`);
  md.push("", "### combined", HDR, fmtM(M));
  md.push("", "### by timeframe", "| TF " + HDR.split("\n")[0], "|---" + HDR.split("\n")[1]);
  for (const tf of ["1h", "4h"]) md.push(`| ${tf} ` + fmtM(metric(asM(resolvable.filter((t) => t.tf === tf)))));
  md.push("", "### by instrument", "| instrument " + HDR.split("\n")[0], "|---" + HDR.split("\n")[1]);
  for (const inst of ["EUR/USD", "USD/JPY", "BTC/USD"]) md.push(`| ${inst} ` + fmtM(metric(asM(resolvable.filter((t) => t.instrument === inst)), monthsBy((i) => i === inst))));
  md.push("", "### instrument x timeframe", "| instrument | TF " + HDR.split("\n")[0], "|---|---" + HDR.split("\n")[1]);
  for (const inst of ["EUR/USD", "USD/JPY", "BTC/USD"]) for (const tf of ["1h", "4h"]) {
    md.push(`| ${inst} | ${tf} ` + fmtM(metric(asM(resolvable.filter((t) => t.instrument === inst && t.tf === tf)), monthsBy((i) => i === inst))));
  }
  md.push("", "### by period", "| period " + HDR.split("\n")[0], "|---" + HDR.split("\n")[1]);
  for (const [nm, f] of [["2022 windows", (t: V2Trade) => t.window.endsWith("2022-07-01") || t.window.endsWith("2022-11-01")], ["2025 windows", (t: V2Trade) => t.window.includes("_2025-")]] as const) {
    md.push(`| ${nm} ` + fmtM(metric(asM(resolvable.filter(f)))));
  }
  const sameBarS2 = scope.filter((t) => t.same_bar_s2);

  // ── reconciliation ───────────────────────────────────────────────────────
  const byExact = new Map(scope.map((t) => [keyT(t.window, t.tf, t.ipo_origin_time, t.touch_bar_time), t]));
  const byZone = new Map<string, V2Trade[]>();
  for (const t of scope) byZone.set(keyZ(t.window, t.tf, t.ipo_origin_time, t.direction), [...(byZone.get(keyZ(t.window, t.tf, t.ipo_origin_time, t.direction)) ?? []), t]);
  const matchedV2 = new Set<V2Trade>();
  const counts: Record<string, number> = {};
  // the V2 trade holding the slot at a refused fill instant
  const occupantOf = (w: string, fillMs: number) => trades.find((t) => t.window === w && t.fill_ms <= fillMs &&
    (t.exit_ms === null || t.exit_ms > fillMs));
  // pass 1: exact pairs, so a re-entry's exact match is never consumed as another trade's shift
  for (const r of frozen) { const t = byExact.get(keyT(r.window, r.ipo_timeframe, r.ipo_origin_time, r.entry_time)); if (t) matchedV2.add(t); }
  for (const r of frozen) {
    const w = wins.find((x) => x.window === r.window)!;
    const k = keyT(r.window, r.ipo_timeframe, r.ipo_origin_time, r.entry_time);
    const t = byExact.get(k);
    let cls: string, why = "", v2 = "";
    if (t) {
      matchedV2.add(t);
      v2 = `${t.outcome} ${t.net_r === null ? "" : f3(t.net_r)}`;
      const same = t.outcome === v1Outcome(r) && t.net_r !== null && Math.abs(t.net_r - +r.net_r) < 0.005;
      cls = same ? "SAME" : "OUTCOME_CHANGED";
      if (!same) why = t.outcome === "AMBIGUOUS" ? `V2 AMBIGUOUS (${t.alt_branch === "CLOSED_AT_TARGET" ? "entry and target in the same minute" : "1m and strategy bar disagree on the fill"})`
        : `V1 ${v1Outcome(r)} ${f3(+r.net_r)} -> V2 ${t.outcome} ${t.net_r === null ? "" : f3(t.net_r)}` + (t.outcome !== v1Outcome(r) && r.ambiguity_detail ? "" : "");
    } else {
      const v1At = Date.parse(r.entry_time);
      const z = (byZone.get(keyZ(r.window, r.ipo_timeframe, r.ipo_origin_time, r.direction)) ?? []).filter((x) => !matchedV2.has(x) && !x.production_view.includes("TOUCH_BAR_CLOSED_BEYOND_S2"))   // a recovered trade is never a shift
        .sort((a, b) => Math.abs(Date.parse(a.touch_bar_time) - v1At) - Math.abs(Date.parse(b.touch_bar_time) - v1At));
      const d = w.diagnoses[`${r.ipo_timeframe}|${r.ipo_origin_time}|${r.entry_time}`];
      if (z.length) {
        cls = "SHIFTED"; matchedV2.add(z[0]);
        v2 = `${z[0].touch_bar_time} ${z[0].outcome} ${z[0].net_r === null ? "" : f3(z[0].net_r)}`;
        why = "same zone entered on a different bar";
      } else {
        cls = "REMOVED";
        const blk = blocked.find((b) => b.window === r.window && b.tf === r.ipo_timeframe && b.bar === r.entry_time && b.ipo === r.ipo_origin_time);
        if (d && d.flags.length) why = `LOOKAHEAD_DEPENDENCY: ${d.flags.join("+")}`;
        else if (blk) {
          const occ = occupantOf(r.window, blk.fillMs);
          why = `SLOT_OCCUPIED${blk.reason === "SAME_TF_EXIT_BAR" ? " (same-TF exit bar)" : ""}` +
            (occ ? ` by ${occ.tf} ${occ.touch_bar_time}${occ.production_view.includes("TOUCH_BAR_CLOSED_BEYOND_S2") ? " (recovered suppressed trade)" : ""}` : "");
        } else {
          const other = scope.find((x) => x.window === r.window && x.tf === r.ipo_timeframe && x.touch_bar_time === r.entry_time);
          why = other ? `OTHER_ZONE_TAKEN_ON_BAR (${other.ipo_origin_time})` : sel === "TOUCH_ORDER" ? "NO_ENTRY_AT_BAR (older zone touched first and never filled)" : "NO_ENTRY_AT_BAR";
        }
      }
    }
    counts[cls] = (counts[cls] ?? 0) + 1;
    recRows.push({ variant: label, side: "V1_TRADE", window: r.window, tf: r.ipo_timeframe, direction: r.direction,
      ipo_origin_time: r.ipo_origin_time, v1_entry_bar: r.entry_time, v1_outcome: v1Outcome(r), v1_net_r: +r.net_r,
      classification: cls, v2_trade: v2, cause: why });
  }
  let recovered = 0, recoveredNet = 0, newSeq = 0, newSel = 0;
  for (const t of scope) {
    if (matchedV2.has(t)) continue;
    let cls: string;
    if (t.production_view.includes("TOUCH_BAR_CLOSED_BEYOND_S2")) { cls = "NEW_SUPPRESSED_TRADE_RECOVERED"; recovered++; recoveredNet += t.net_r ?? 0; }
    else if (sel === "TOUCH_ORDER" && t.production_view.includes("PRODUCTION_WOULD_PICK_ANOTHER_ZONE")) { cls = "NEW_SELECTION_LOOKAHEAD_RECOVERED"; newSel++; }
    else { cls = "NEW_DUE_TO_SEQUENCE_CHANGE"; newSeq++; }
    counts[cls] = (counts[cls] ?? 0) + 1;
    recRows.push({ variant: label, side: "V2_TRADE", window: t.window, tf: t.tf, direction: t.direction, ipo_origin_time: t.ipo_origin_time,
      v1_entry_bar: "", v1_outcome: "", v1_net_r: "", classification: cls,
      v2_trade: `${t.touch_bar_time} fill ${t.fill_minute} ${t.outcome} ${t.net_r === null ? "" : f3(t.net_r)}`,
      cause: t.production_view.join("+") || "slot/sequence differs from V1" });
    if (cls === "NEW_SUPPRESSED_TRADE_RECOVERED") suppRows.push({ variant: label, ...pickT(t) });
  }
  const recoveredAll = scope.filter((t) => t.production_view.includes("TOUCH_BAR_CLOSED_BEYOND_S2"));
  md.push("", "### reconciliation", JSON.stringify(counts));
  md.push(`suppressed trades recovered (all touch-bar-close cases in scope): ${recoveredAll.length}, net ${f3(recoveredAll.reduce((a, t) => a + (t.net_r ?? 0), 0))}R ` +
    `(resolvable ${recoveredAll.filter((t) => t.net_r !== null).length}; of them unmatched-to-V1 NEW: ${recovered}, net ${f3(recoveredNet)}R)`);
  md.push(`same-bar S2 losses: ${sameBarS2.length} (net ${f3(sameBarS2.reduce((a, t) => a + (t.net_r ?? 0), 0))}R)`);
  md.push(`new due to sequence change: ${newSeq}${sel === "TOUCH_ORDER" ? `, new from selection look-ahead removal: ${newSel}` : ""}`);
  const removed = recRows.filter((r) => r.variant === label && r.classification === "REMOVED");
  const causes: Record<string, number> = {};
  for (const r of removed) { const c = String(r.cause).split(":")[0].split(" ")[0]; causes[c] = (causes[c] ?? 0) + 1; }
  md.push(`removed V1 trades by cause: ${JSON.stringify(causes)}`);
  const lookFlags: Record<string, number> = {};
  for (const r of removed) if (String(r.cause).startsWith("LOOKAHEAD")) for (const f of String(r.cause).split(": ")[1].split("+")) lookFlags[f] = (lookFlags[f] ?? 0) + 1;
  md.push(`  look-ahead flags among removed: ${JSON.stringify(lookFlags)}`);
  const pv: Record<string, number> = {};
  for (const t of scope) for (const f of t.production_view) pv[f] = (pv[f] ?? 0) + 1;
  md.push(`production view of V2 trades: ${JSON.stringify(pv)}`);
  // data dependence
  const flagged = scope.filter((t) => t.data_flags.length);
  const htfFlagged = flagged.filter((t) => t.data_flags.some((f) => f.startsWith("HTF")));
  const spikeFlagged = flagged.filter((t) => t.data_flags.some((f) => f.startsWith("M1_SPIKE")));
  const ocFlagged = flagged.filter((t) => t.data_flags.some((f) => f.startsWith("M1_OPEN_CLOSE")));
  md.push(`data-flagged trades: HTF OHLC violation in life ${htfFlagged.length} (net ${f3(htfFlagged.reduce((a, t) => a + (t.net_r ?? 0), 0))}R), ` +
    `1m spike in window ${spikeFlagged.length}, 1m corrupt open/close in window ${ocFlagged.length} (net ${f3(ocFlagged.reduce((a, t) => a + (t.net_r ?? 0), 0))}R)`);
  const exHtf = metric(asM(resolvable.filter((t) => !t.data_flags.some((f) => f.startsWith("HTF")))));
  md.push(`  excluding HTF-flagged trades: ${fmtM(exHtf)}`);
  (globalThis as any)[`M_${label}`] = { M, scope, resolvable, sameBarS2, recoveredAll, counts };
  for (const t of scope) allTradeRows.push({ variant: label, ...pickT(t) });
}

function pickT(t: V2Trade) {
  return { window: t.window, instrument: t.instrument, tf: t.tf, direction: t.direction, ipo_origin_time: t.ipo_origin_time,
    ipo_open: t.ipo_open, ipo_high: t.ipo_high, ipo_low: t.ipo_low, ipo_close: t.ipo_close, zone_low: t.zone_low, zone_high: t.zone_high,
    entry: t.entry, s2: t.s2, target: t.target, risk: t.risk, touch_bar_time: t.touch_bar_time, fill_minute: t.fill_minute, fill_note: t.fill_note,
    outcome: t.outcome, alt_branch: t.alt_branch, open_branch: t.open_branch, resolution_method: t.method,
    target_minute: t.target_minute, s2_bar_time: t.s2_bar_time, exit_bar_time: t.exit_bar_time, exit_price: t.exit_price,
    gross_r: t.gross_r, cost_r: t.cost_r, net_r: t.net_r, same_bar_s2: t.same_bar_s2, eligible_zones_on_bar: t.n_eligible,
    production_engine_view: t.production_view, data_flags: t.data_flags,
    excluded_from_stats: !(t.net_r !== null && (t.outcome === "TARGET" || t.outcome === "S2_CLOSE")) };
}

// ── V1 vs V2 ───────────────────────────────────────────────────────────────
const A = (globalThis as any).M_V2, B = (globalThis as any).M_V2_STRICT;
md.push("", "## V1 vs V2", "| Metric | V1 Old | V2 Corrected | Difference | V2 strict | Difference |", "|---|---:|---:|---:|---:|---:|");
const row = (nm: string, a: number, b: number, c: number, fmt: (x: number) => string) => md.push(`| ${nm} | ${fmt(a)} | ${fmt(b)} | ${fmt(b - a)} | ${fmt(c)} | ${fmt(c - a)} |`);
row("Trades", v1M.n, A.M.n, B.M.n, (x) => x.toFixed(0));
row("WR %", 100 * v1M.wr, 100 * A.M.wr, 100 * B.M.wr, (x) => x.toFixed(1));
row("Expectancy R", v1M.exp, A.M.exp, B.M.exp, f3);
row("PF", v1M.pf, A.M.pf, B.M.pf, (x) => x.toFixed(2));
row("Net R", v1M.net, A.M.net, B.M.net, (x) => x.toFixed(1));
row("Chronological DD R", v1M.dd, A.M.dd, B.M.dd, (x) => x.toFixed(1));
row("Trades/month", v1M.perMonth, A.M.perMonth, B.M.perMonth, (x) => x.toFixed(1));

// ── data integrity export ──────────────────────────────────────────────────
const integ: Record<string, unknown>[] = [];
for (const w of wins) {
  for (const b of w.data.corruptM1) integ.push({ window: w.window, kind: "M1_OPEN_CLOSE_OUTSIDE_RANGE", datetime: b.datetime, source_open: b.open, source_high: b.high,
    source_low: b.low, source_close: b.close, repaired_open: b.repaired_open, repaired_close: b.repaired_close,
    repair_used: "none — the causal resolver and entry timing read 1m high/low only; the clamp shown is what a repair would be" });
  for (const b of w.data.spikeM1) integ.push({ window: w.window, kind: "M1_ISOLATED_SPIKE", datetime: b.datetime, source_open: b.open, source_high: b.high, source_low: b.low, source_close: b.close, repair_used: "none (none found)" });
  for (const g of w.data.gaps) integ.push({ window: w.window, kind: "M1_GAP_OVER_60M_NOT_WEEKEND", datetime: g.from, source_open: "", source_high: "", source_low: "", source_close: "", repaired_open: "", repaired_close: g.to, repair_used: `provider gap of ${g.minutes} min inside a contiguous page chain` });
  for (const tf of ["1h", "4h"]) for (const b of w.data.corruptHtf[tf]) integ.push({ window: w.window, kind: `HTF_${tf}_OPEN_CLOSE_OUTSIDE_RANGE`, datetime: b.datetime, source_open: b.open, source_high: b.high, source_low: b.low, source_close: b.close, repair_used: "none — V1 and V2 both consume the provider strategy bars as-is; affected trades flagged" });
}
const icount: Record<string, number> = {};
for (const r of integ) icount[String(r.kind)] = (icount[String(r.kind)] ?? 0) + 1;
md.push("", `## data integrity: ${JSON.stringify(icount)}`);
const byMonth: Record<string, number> = {};
for (const r of integ.filter((x) => x.kind === "M1_OPEN_CLOSE_OUTSIDE_RANGE")) { const k = `${r.window} ${String(r.datetime).slice(0, 7)}`; byMonth[k] = (byMonth[k] ?? 0) + 1; }
md.push(`corrupt 1m open/close by window-month: ${JSON.stringify(byMonth)}`);

await Deno.writeTextFile(new URL("ipo_baseline_causal_v2_trades.csv", EXP), csv(allTradeRows));
await Deno.writeTextFile(new URL("ipo_baseline_causal_v2_reconciliation.csv", EXP), csv(recRows));
await Deno.writeTextFile(new URL("ipo_baseline_causal_v2_suppressed_trades.csv", EXP), csv(suppRows.length ? suppRows : [{ variant: "", note: "none" }]));
await Deno.writeTextFile(new URL("ipo_baseline_causal_v2_data_integrity.csv", EXP), csv(integ.length ? integ : [{ window: "", kind: "none" }],
  ["window", "kind", "datetime", "source_open", "source_high", "source_low", "source_close", "repaired_open", "repaired_close", "repair_used"]));
await Deno.mkdir(new URL("./.cache/ipo-v2/", import.meta.url), { recursive: true });
await Deno.writeTextFile(TABLES, md.join("\n") + "\n");
console.log(md.join("\n"));
