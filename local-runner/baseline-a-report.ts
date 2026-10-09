/**
 * BASELINE A strategy report — READ-ONLY (SELECT only; nothing is written anywhere).
 * Spec: docs/BASELINE_A_REPORT_SPEC_V1.md. Metrics: supabase/functions/_shared/baselineReport.ts.
 *
 * Sections: BASELINE A (real orders, frozen config, at/after the unlock) · pre-order context for the
 * same window · HISTORICAL DRY-RUN CONTEXT (pre-unlock dry-run orders, never pooled with Baseline A).
 *
 * Usage: deno run --allow-read --allow-net --allow-env local-runner/baseline-a-report.ts [--json]
 * (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from local-runner/.env.local, or the file named by LOCAL_RUNNER_ENV)
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  type AttributionRow, BASELINE_A, type Breakdown, cohortOf, decisionContext, type DecisionRow, type MaeMfe, maeMfe,
  type Stat, summarize, type Summary,
} from "../supabase/functions/_shared/baselineReport.ts";
import { loadBars } from "../supabase/functions/_shared/outcomeResolverRun.ts";
import { SPECS } from "../supabase/functions/_shared/smcAnalysis.ts";

const env: Record<string, string> = {};
// LOCAL_RUNNER_ENV points at another checkout's .env.local (e.g. from a git worktree); default ./.env.local
for (const l of Deno.readTextFileSync(Deno.env.get("LOCAL_RUNNER_ENV") ?? new URL("./.env.local", import.meta.url)).split("\n")) {
  const i = l.indexOf("=");
  if (i > 0 && !l.startsWith("#")) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// deno-lint-ignore no-explicit-any
async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: any; error: { message: string } | null }>, what: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(`${what}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) return out;
  }
}

const COLS = "signal_id, symbol, direction, dry_run, config_version, route, primary_engine, decision_at, order_placed_at, touched_at, " +
  "confirmed_at, filled_at, closed_at, entry_source, confirmation, terminal_status, terminal_reason, stop_source, stop_distance_pips, " +
  "fill_stop_distance_pips, fill_inside_floor, intended_risk_usd, intended_risk_pct, fill_risk_usd, fill_risk_pct, fill_price, " +
  "fill_stop_price, exit_reason, realized_pnl_usd, realized_r_gross, realized_r_net";
const rows = await all<AttributionRow>((a, b) => db.from("trade_attribution").select(COLS).order("decision_at").range(a, b), "trade_attribution");
const baseline = rows.filter((r) => cohortOf(r) === "baseline_a");
const dry = rows.filter((r) => cohortOf(r) === "historical_dry_run");
const excluded = rows.filter((r) => cohortOf(r) === "excluded");

// resets per order (events)
const resets = new Map<string, number>();
for (const ids of [baseline, dry].map((g) => g.map((r) => r.signal_id))) {
  for (let i = 0; i < ids.length; i += 200) {
    const ev = await all<{ signal_id: string }>((a, b) => db.from("trade_attribution_events").select("signal_id")
      .eq("event_type", "reset").in("signal_id", ids.slice(i, i + 200)).range(a, b), "trade_attribution_events");
    for (const e of ev) resets.set(e.signal_id, (resets.get(e.signal_id) ?? 0) + 1);
  }
}

// MAE / MFE for closed trades, from the same 5m bars the outcome resolver replays
const mm = new Map<string, MaeMfe>();
const closed = [...baseline, ...dry].filter((r) => r.filled_at && r.closed_at);
for (const symbol of [...new Set(closed.map((r) => r.symbol))]) {
  const mine = closed.filter((r) => r.symbol === symbol);
  const from = new Date(Math.min(...mine.map((r) => Date.parse(r.filled_at!))) - 10 * 60_000).toISOString();
  const { bars } = await loadBars(db, symbol, from);
  for (const r of mine) {
    mm.set(r.signal_id, maeMfe({
      direction: r.direction, fillPrice: r.fill_price == null ? null : Number(r.fill_price),
      stopPrice: r.fill_stop_price == null ? null : Number(r.fill_stop_price),
      filledAtMs: Date.parse(r.filled_at!), closedAtMs: Date.parse(r.closed_at!), pipSize: SPECS[symbol]?.pipSize ?? NaN,
    }, bars));
  }
}

// pre-order decisions: Baseline A window, and the dry-run window
const decisions = async (fromIso: string, toIso: string | null) => await all<DecisionRow>((a, b) => {
  let q = db.from("smc_scan_decision").select("symbol, scanned_at, status:final_decision->>status, skip:final_decision->>skipReason, " +
    "direction:final_decision->>direction, entry:final_decision->>entry").gte("scanned_at", fromIso);
  if (toIso) q = q.lt("scanned_at", toIso);
  return q.order("scanned_at").range(a, b);
}, "smc_scan_decision");
const dryFrom = dry.length ? dry[0].decision_at : BASELINE_A.unlockedAt;
const report = {
  generatedAt: new Date().toISOString(),
  cohort: BASELINE_A,
  baselineA: { summary: summarize(baseline, { maeMfe: mm, resets }), preOrder: decisionContext(await decisions(BASELINE_A.unlockedAt, null)) },
  historicalDryRun: {
    window: { from: dryFrom, to: BASELINE_A.unlockedAt },
    byConfig: Object.fromEntries([...new Set(dry.map((r) => r.config_version))].map((c) => [c, dry.filter((r) => r.config_version === c).length])),
    summary: summarize(dry, { maeMfe: mm, resets }),
    preOrder: decisionContext(await decisions(dryFrom, BASELINE_A.unlockedAt)),
  },
  excluded: { rows: excluded.length, signalIds: excluded.slice(0, 20).map((r) => r.signal_id) },
};

if (Deno.args.includes("--json")) {
  console.log(JSON.stringify(report, null, 1));
  Deno.exit(0);
}

// ── text ──
const f = (x: number | null, d = 3) => (x == null ? "n/a" : (Math.round(x * 10 ** d) / 10 ** d).toString());
const pct = (x: number | null) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const st = (s: Stat, d = 2) => (s.n ? `median ${f(s.median, d)} · mean ${f(s.mean, d)} (n ${s.n})` : "n/a (n 0)");
const usd = (x: number | null) => (x == null ? "n/a" : `$${x.toFixed(2)}`);
const table = (title: string, b: Record<string, Breakdown>) => {
  console.log(`  ${title}`);
  if (!Object.keys(b).length) return console.log("    (none)");
  for (const [k, v] of Object.entries(b)) {
    console.log(`    ${k.padEnd(26)} orders ${String(v.orders).padStart(3)} · fills ${String(v.fills).padStart(3)} (${pct(v.fillRate)}) · closed ${v.closed}` +
      ` · win ${pct(v.winRate)} · R gross ${f(v.avgGrossR)} · R net ${f(v.avgNetR)} · P/L ${usd(v.realizedPnlUsd)}`);
  }
};
const section = (s: Summary, pnlLabel: string) => {
  const u = s.funnel, r = s.rates, o = s.outcomes;
  console.log(`  Funnel: orders ${u.orders} → touched ${u.touched} → confirmed ${u.confirmed} → fills ${u.fills} → closed ${u.closed}` +
    `  (open orders ${u.openOrders}, open positions ${u.openPositions})`);
  console.log(`  Terminal: ${JSON.stringify(u.byTerminal)}`);
  console.log(`  Rates (÷ orders): touch ${pct(r.touch)} · fill ${pct(r.fill)} · invalidated ${pct(r.invalidated)} · cancelled ${pct(r.cancelled)}` +
    ` · expired ${pct(r.expired)} (never touched ${pct(r.expiredNeverTouched)}, after touch ${pct(r.expiredAfterTouch)}) · superseded ${pct(r.superseded)} · blocked ${pct(r.blocked)}`);
  console.log(`  Outcomes: closed ${o.closed} · wins ${o.wins} · losses ${o.losses} · breakeven ${o.breakeven} · win rate ${pct(o.winRate)}`);
  console.log(`            avg R gross ${f(o.avgGrossR)} · avg R net ${f(o.avgNetR)}${o.netRMissing ? ` (${o.netRMissing} without net R)` : ""}` +
    ` · avg win ${f(o.avgWinR)} · avg loss ${f(o.avgLossR)}`);
  console.log(`            expectancy ${f(o.expectancyNetR)} R net / ${f(o.expectancyGrossR)} R gross per trade · ${pnlLabel} ${usd(o.realizedPnlUsd)}` +
    ` (avg ${usd(o.avgPnlUsd)})${o.pnlMissing ? ` (${o.pnlMissing} without P/L)` : ""} · exits ${JSON.stringify(o.byExitReason)}`);
  console.log(`  MAE/MFE (5m bars, bar-granular): ok ${s.maeMfe.ok}${Object.keys(s.maeMfe.unavailable).length ? ` · unavailable ${JSON.stringify(s.maeMfe.unavailable)}` : ""}`);
  console.log(`    MAE R ${st(s.maeMfe.maeR)} · MFE R ${st(s.maeMfe.mfeR)}`);
  console.log(`    MAE pips ${st(s.maeMfe.maePips, 1)} · MFE pips ${st(s.maeMfe.mfePips, 1)}`);
  console.log(`  Risk: intended ${st(s.risk.intendedUsd)} USD · at fill ${st(s.risk.fillUsd)} USD · fill/intended ${st(s.risk.fillOverIntended, 3)}`);
  console.log(`        intended % ${st(s.risk.intendedPct, 3)} · fill % ${st(s.risk.fillPct, 3)}`);
  console.log(`  Stop: planned ${st(s.risk.stopDistancePips, 1)} pips · at fill ${st(s.risk.fillStopDistancePips, 1)} pips · source ${JSON.stringify(s.risk.stopSource)} · fills inside floor ${s.risk.fillInsideFloor}`);
  const t = s.timingMinutes;
  console.log(`  Timing (minutes): decision→order ${st(t.decisionToOrder, 1)}`);
  console.log(`                    order→first touch ${st(t.orderToTouch, 1)} · touch→confirm ${st(t.touchToConfirm, 1)}`);
  console.log(`                    confirm→fill ${st(t.confirmToFill, 1)} · fill→close ${st(t.fillToClose, 1)} · decision→fill ${st(t.decisionToFill, 1)}`);
  console.log(`                    resets per order ${st(t.resetsPerOrder, 2)}`);
  table("By pair", s.byPair);
  table("By entry source", s.byEntrySource);
  table("By confirmation tier (confirmed orders)", s.byConfirmationTier);
  table("By confirmation type (confirmed orders)", s.byConfirmationType);
};
const pre = (p: ReturnType<typeof decisionContext>) => {
  console.log(`  Scan decisions ${p.decisions} · re-detections of an active order ${p.redetections} (zone_setup_insert_failed "already active": not a signal, not a failure)`);
  console.log(`  Refused before an order: ${p.refusedDecisions} decisions ≈ ${p.approxDistinctRefusedSetups} distinct setups (approx.) ${JSON.stringify(p.approxDistinctRefusedByStatus)}`);
  console.log(`  By status: ${JSON.stringify(p.byStatus)}`);
};

console.log(`BASELINE A STRATEGY REPORT — generated ${report.generatedAt} (read-only)`);
console.log(`Cohort: dry_run=false · config ${BASELINE_A.configVersion} · ${BASELINE_A.route} · ${BASELINE_A.primaryEngine} · decided ≥ ${BASELINE_A.unlockedAt}`);
console.log(`\n═══ BASELINE A (live paper) ═══`);
if (!baseline.length) console.log("  No Baseline A orders yet — every metric below is n/a until the first real order.");
section(report.baselineA.summary, "realized P/L");
console.log(`\n─── Pre-order context (scan decisions since the unlock) ───`);
pre(report.baselineA.preOrder);
console.log(`\n═══ HISTORICAL DRY-RUN CONTEXT (NOT Baseline A — never pooled) ═══`);
console.log(`  ${dry.length} dry-run orders decided ${report.historicalDryRun.window.from} → ${report.historicalDryRun.window.to} · by config ${JSON.stringify(report.historicalDryRun.byConfig)}`);
console.log("  Differs from live: 17-A fill re-anchor and 17-B log-only TP gate applied; position caps never bound (no positions); outcomes are 5m bar replays.");
section(report.historicalDryRun.summary, "hypothetical P/L");
console.log(`\n─── Pre-order context (dry-run window) ───`);
pre(report.historicalDryRun.preOrder);
if (excluded.length) console.log(`\nExcluded rows (neither cohort): ${excluded.length} — first: ${report.excluded.signalIds.join(", ")}`);
