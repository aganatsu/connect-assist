/**
 * SMC_IMPULSE_ZONE_ROUTE1_SAFETY_GATES_V1 — one-variable test.
 *
 * Takes the 216-trade Route 1 cohort and asks ONLY: do the 12 replayable
 * production safety gates improve it?
 *
 * The gates are NOT reimplemented. `runSafetyGates` is imported from
 * bot-scanner and called with the real `analysis` object produced by
 * `runConfluenceAnalysis`. Two behaviour-preserving source changes made this
 * possible: `export` on the function, and `if (import.meta.main)` on
 * `Deno.serve` so importing the module does not start a server. Supabase runs
 * index.ts as the entry module, so deployment is unaffected.
 *
 * THE 10 ACCOUNT-STATE GATES ARE NOT FABRICATED. The supabase handle is a stub
 * that returns no rows, so gates 13/14/15/16 would evaluate against an empty
 * history and pass trivially. Their verdicts are therefore DISCARDED by name
 * rather than counted — a trivially-passing gate is a silently-defaulted gate.
 *
 *   deno run --allow-read --allow-write --allow-env --allow-net \
 *     local-runner/smc-route1-gates.ts
 */

import { runSafetyGates } from "../supabase/functions/bot-scanner/index.ts";
import { runConfluenceAnalysis } from "../supabase/functions/_shared/confluenceScoring.ts";
import { mapNestedToFlat, applyPairOverrides } from "../supabase/functions/_shared/configMapper.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { loadCorpus } from "./smc-corpus-fetch.ts";
import type { R1Row } from "./smc-route1-replay.ts";

/** STYLE_OVERRIDES.scalper, verbatim from bot-scanner:477. */
const SCALPER = {
  scanIntervalMinutes: 5, entryTimeframe: "5m", htfTimeframe: "1h",
  tpRatio: 2.0, slBufferPips: 1, minConfluence: 40, riskPerTrade: 0.5,
  impulseSlCapMultiplier: 1.5, trailingStopEnabled: false, trailingStopPips: 8,
  trailingStopActivation: "after_1r", breakEvenEnabled: false, breakEvenPips: 8,
  partialTPEnabled: false, maxHoldEnabled: true, maxHoldHours: 4,
};

/**
 * Gate classification by reason text.
 *
 * REPLAYABLE — decided from market data the corpus contains.
 * ACCOUNT_STATE — needs history that was never persisted. Discarded, not
 * counted, because the stub makes them pass for the wrong reason.
 */
const ACCOUNT_STATE = [
  /^Cooldown/, /consecutive loss/i, /^Daily loss/, /^Daily net P/, /^Drawdown/,
  /^Max positions/, /^Max per symbol/i, /^Already \d+ position/, /portfolio heat/i,
  /^Correlated/, /^Hedge conflict/, /^No correlated conflicts/, /^News filter/,
  /high-impact news/i, /^Max open/,
];
const isAccountState = (reason: string) => ACCOUNT_STATE.some((r) => r.test(reason));

/** Short stable label so gates can be aggregated across trades. */
function gateLabel(reason: string): string {
  const head = reason.split(/[:(]/)[0].trim();
  return head.slice(0, 44);
}

/** Supabase stub: returns no rows for every query shape the gates use. */
function stubDb(): unknown {
  const h: Record<string, unknown> = {};
  for (const k of ["select", "eq", "gte", "lte", "gt", "lt", "order", "limit", "in", "is", "neq"]) {
    h[k] = () => h;
  }
  h.then = (res: (v: unknown) => unknown) => res({ data: [], error: null });
  h.maybeSingle = () => h;
  return { from: () => h };
}

interface Attrib {
  symbol: string; t: string; netR: number; gate: string; passed: boolean;
  reason: string; kind: "REPLAYABLE" | "ACCOUNT_STATE";
}

if (import.meta.main) {
  const raw = JSON.parse(Deno.readTextFileSync("/tmp/cfg.json"))[0].config_json;
  const liveJson = typeof raw === "string" ? JSON.parse(raw) : raw;
  const baseCfg = mapNestedToFlat(liveJson) as Record<string, unknown>;
  Object.assign(baseCfg, SCALPER);          // STYLE_OVERRIDES, as production applies them

  const rows: R1Row[] = [];
  for (const e of Deno.readDirSync(new URL("./.cache/", import.meta.url))) {
    if (!/^r1_.*\.json$/.test(e.name)) continue;
    rows.push(...JSON.parse(Deno.readTextFileSync(new URL(`./.cache/${e.name}`, import.meta.url))) as R1Row[]);
  }
  const taken = rows.filter((r) => r.stage === "TRADE_TAKEN" && !r.ambiguous)
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  console.log(`baseline cohort: ${taken.length} Route 1 trades\n`);

  const corpus: Record<string, Record<string, Candle[]>> = {};
  const attribs: Attrib[] = [];
  const perTrade: Array<{ row: R1Row; replayFail: string[]; accountFail: string[] }> = [];
  const db = stubDb();
  let errors = 0;

  for (const r of taken) {
    if (!corpus[r.symbol]) {
      corpus[r.symbol] = {
        m5: loadCorpus(r.symbol, "5m"), h1: loadCorpus(r.symbol, "1h"),
        d1: loadCorpus(r.symbol, "1d"),
      };
    }
    const c = corpus[r.symbol];
    const tMs = Date.parse(r.t);
    // Causal slices: closed bars only, same convention as the baseline run.
    const m5 = c.m5.filter((b) => Date.parse(b.datetime) + 300_000 <= tMs).slice(-1440);
    const h1 = c.h1.filter((b) => Date.parse(b.datetime) + 3_600_000 <= tMs).slice(-120);
    const d1 = c.d1.filter((b) => Date.parse(b.datetime) + 86_400_000 <= tMs).slice(-260);
    if (m5.length < 200) { errors++; continue; }

    const cfg = applyPairOverrides({ ...baseCfg } as never, r.symbol) as Record<string, unknown>;
    const analysis = runConfluenceAnalysis(
      m5, d1.length >= 10 ? d1 : null, cfg, h1.length ? h1 : undefined, tMs,
    ) as Record<string, unknown>;
    analysis.stopLoss = r.sl;
    analysis.takeProfit = r.tp;
    analysis.direction = r.direction;

    let gates: Array<{ passed: boolean; reason: string }>;
    try {
      gates = await runSafetyGates(
        db, "research", r.symbol, r.direction as string, analysis, cfg,
        { balance: 10_000, peak_balance: 10_000, daily_pnl_base: 10_000,
          daily_pnl_base_date: r.t.slice(0, 10) },
        [], d1, {}, null, null, false,
      ) as Array<{ passed: boolean; reason: string }>;
    } catch (e) {
      errors++;
      console.log(`  gate error ${r.symbol} ${r.t}: ${(e as Error).message.slice(0, 90)}`);
      continue;
    }

    const replayFail: string[] = [], accountFail: string[] = [];
    for (const g of gates) {
      const kind = isAccountState(g.reason) ? "ACCOUNT_STATE" : "REPLAYABLE";
      attribs.push({ symbol: r.symbol, t: r.t, netR: r.netR as number,
        gate: gateLabel(g.reason), passed: g.passed, reason: g.reason.slice(0, 120), kind });
      if (!g.passed) (kind === "REPLAYABLE" ? replayFail : accountFail).push(gateLabel(g.reason));
    }
    perTrade.push({ row: r, replayFail, accountFail });
  }

  Deno.writeTextFileSync(new URL("./.cache/r1_gate_attrib.json", import.meta.url),
    JSON.stringify({ attribs, perTrade }));
  console.log(`evaluated ${perTrade.length} trades, ${errors} errors, ${attribs.length} gate observations`);
}
