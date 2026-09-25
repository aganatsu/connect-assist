/**
 * Round-trip the decision capture through the REAL database schema.
 *
 * WHY THIS EXISTS AS A SEPARATE STEP. The zone snapshot was validated only
 * in-memory and shipped with two defects that only a real round trip would have
 * caught: timestamptz silently dropped sub-second precision, and
 * `double precision` returned 1.00102 for a stored 1.0010199999999998. Both
 * broke every digest. This writes representatives through PostgREST, reads them
 * back, and requires exact reconstruction.
 *
 * Probe rows are removed at the end.
 *
 * Usage:
 *   deno run --allow-net --allow-env local-runner/stage2h-roundtrip.ts
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  newCapture, toRow, hashPart, slimPositions, sanitizeConfigForCapture,
} from "../supabase/functions/_shared/smcDecisionCapture.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const UID = "57c79dee-db6b-4fae-b34a-4b64ce33ca34";
const CYCLE = "__RT_DECISION__";

/** Deep structural compare with a float tolerance, mirroring the parity harness. */
function diff(a: unknown, b: unknown, path = ""): string[] {
  const out: string[] = [];
  const nil = (v: unknown) => v === null || v === undefined;
  if (nil(a) && nil(b)) return out;
  if (typeof a === "number" && typeof b === "number") {
    if (!(Math.abs(a - b) < 1e-12)) out.push(`${path}: wrote=${a} read=${b}`);
    return out;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = (a ?? []) as unknown[], bb = (b ?? []) as unknown[];
    if (aa.length !== bb.length) { out.push(`${path}.length: wrote=${aa.length} read=${bb.length}`); return out; }
    for (let i = 0; i < aa.length; i++) out.push(...diff(aa[i], bb[i], `${path}[${i}]`));
    return out;
  }
  if (typeof a === "object" || typeof b === "object") {
    const ao = (a ?? {}) as Record<string, unknown>, bo = (b ?? {}) as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      out.push(...diff(ao[k], bo[k], path ? `${path}.${k}` : k));
    }
    return out;
  }
  if (a !== b) out.push(`${path}: wrote=${JSON.stringify(a)} read=${JSON.stringify(b)}`);
  return out;
}

// ── representatives, one per hazard the spec names ──────────────────────────
const cases: Record<string, (c: ReturnType<typeof newCapture>) => void> = {
  "timestamps + wall-clock instant": (c) => {
    c.ict_input = {
      killZone: { at: "2026-09-25T21:04:05.123Z", config: { london: true, ny: false } },
      nested: { deeper: { when: "2026-09-25 21:04:05+00" } },
    };
  },
  "float precision (the ulp that broke the bar store)": (c) => {
    c.risk_input = {
      consecutiveLosses: 3, tradesToday: 7,
      dailyPnLPercent: 1.001 + 2e-5,          // 1.0010199999999998
      weeklyPnLPercent: -0.30000000000000004, // classic 0.1+0.2 artefact
      tiny: 1e-12, big: 9007199254740991, negZero: -0,
    };
  },
  "empty arrays vs null vs absent": (c) => {
    c.portfolio_input = {
      openPositions: [], conflicts: null, currencyExposure: {},
      maxOpenPositions: 3, absent: undefined,
    };
    c.portfolio_output = { concentrationScore: 0, conflicts: [], currencyExposure: {} };
  },
  "multiple gate results with prose reasons": (c) => {
    c.gates_output = {
      gates: [
        { passed: true, reason: "Direction verdict OK (conf: 72%, agreement: 83%)" },
        { passed: false, reason: "Portfolio heat 6.2% > 5% — blocked" },
        { passed: false, reason: 'Quote has "nested" chars, commas, and a \\ backslash' },
        { passed: true, reason: "" },
      ],
      blocking: ["Portfolio heat 6.2% > 5% — blocked"],
      allPassed: false,
    };
  },
  "multiple positions + correlation arrays": (c) => {
    c.portfolio_input = {
      candidate: { symbol: "EUR/USD", direction: "long", size: 0.01 },
      openPositions: slimPositions([
        { position_id: "p2", symbol: "GBP/USD", direction: "long", size: "0.10",
          entry_price: "1.2345", stop_loss: "1.2300", take_profit: "1.2435",
          position_status: "open", bot_id: "smc" },
        { position_id: "p1", symbol: "USD/CHF", direction: "short", size: "0.05",
          entry_price: "0.82917", stop_loss: null, take_profit: null,
          position_status: "open", bot_id: "smc" },
      ]),
      correlations: [
        { pair: ["EUR/USD", "GBP/USD"], rho: 0.87 },
        { pair: ["EUR/USD", "USD/CHF"], rho: -0.91 },
      ],
    };
  },
  "deeply nested config with injected blobs stripped": (c) => {
    c.confluence_input = {
      pairConfig: sanitizeConfigForCapture({
        minConfluence: 40, htfBiasRequired: true, nested: { a: { b: { c: [1, 2, 3] } } },
        _htfLiquidityPools: { d: [{ level: 1.1, touches: 3 }], h4: [], h1: [] },
        _h4Candles: Array.from({ length: 60 }, (_, i) => ({ o: i })),
        aFunction: () => 1, anUndefined: undefined,
      }),
    };
  },
  "cascade: null output (the common case — stage never ran)": (c) => {
    c.cascade_input = null;
    c.cascade_output = null;
  },
  "cascade: non-null zone with nested objects and optionals": (c) => {
    c.cascade_input = {
      direction: "bullish", lastPrice: 1.16342,
      seriesLengths: { daily: 300, h4: 300, hourly: 300, entry: 300 },
      gating: { style: "swing_trader", dailyMin30: true, h4Min20: true },
      htfDataPresent: true, htfDataHash: "2d0bc1083f9a1b2c",
      zoneEngineOpts: {
        strictATRMult: undefined,      // optional field, must not resurface
        pipSize: 0.0001,
        fibMaxRetracement: 0.786,
        originOBRetest: false,
      },
    };
    c.cascade_output = {
      state: "triggered",
      reason: "Daily OB → 4H CHoCH → 1H FVG · entry armed",
      dailyZone: { poi: { type: "OB", high: 1.16500, low: 1.16100 }, fibLevel: 0.705,
                   htfLayers: ["D_OB", "HTF_FIB_70.5"], score: 7.5 },
      confirmation: { type: "CHoCH", index: 287, price: 1.163419999999999, tags: [] },
      entryZone: { high: 1.1634, low: 1.1628, refined: true, subZones: [
        { high: 1.1634, low: 1.1631 }, { high: 1.1631, low: 1.1628 },
      ] },
      priceAtEntry: true, distancePips: 0, entry: 1.16342, sl: 1.1601,
    };
  },
  "cascade: engine error is an outcome too": (c) => {
    c.cascade_output = { state: "error", reason: "Cannot read properties of undefined" };
  },
  "unicode and long prose": (c) => {
    c.final_decision = {
      status: "rejected",
      reason: "zone_score_gate:5.5/6 — price not at zone · ⚠️ blocked",
      skipReason: "no_impulse_zone",
      score: 5.5, entry: null, stopLoss: null, takeProfit: null, tradePlaced: false,
    };
  },
};

let failures = 0;
console.log("\nSTAGE 2H ROUND-TRIP — decision capture through the real schema\n");

for (const [name, apply] of Object.entries(cases)) {
  const cap = newCapture(CYCLE, UID, "smc", `__RT_${name.slice(0, 12)}`, "scalper");
  cap.reached_stage = "final";
  apply(cap);
  const row = toRow(cap);

  const ins = await db.from("smc_scan_decision").upsert([row], { onConflict: "scan_cycle_id,symbol" });
  if (ins.error) { console.log(`  ✗ ${name}\n      insert failed: ${ins.error.message}`); failures++; continue; }

  const { data } = await db.from("smc_scan_decision").select("*")
    .eq("scan_cycle_id", CYCLE).eq("symbol", row.symbol).limit(1);
  const read = data?.[0] as Record<string, unknown> | undefined;
  if (!read) { console.log(`  ✗ ${name}\n      row not found after write`); failures++; continue; }

  const fields = [
    "direction_input", "confluence_input", "gates_input", "portfolio_input",
    "ict_input", "risk_input", "session_news_input",
    "gates_output", "portfolio_output", "final_decision",
    "cascade_input", "cascade_output",
  ];
  const diffs: string[] = [];
  for (const f of fields) diffs.push(...diff(row[f], read[f], f));

  // The digest must survive the round trip too — that is the property a replay
  // depends on, and the one that silently broke twice in the bar store.
  // Mapping is explicit and 1:1; deriving it by string replacement collided
  // _input and _output onto one hash column and produced three false failures.
  const hashOf: Record<string, string> = {
    direction_input: "direction_hash",
    confluence_input: "confluence_hash",
    gates_input: "gates_hash",
    portfolio_input: "portfolio_hash",
    ict_input: "ict_hash",
    risk_input: "risk_hash",
    session_news_input: "session_news_hash",
    gates_output: "gates_output_hash",
    portfolio_output: "portfolio_output_hash",
    final_decision: "final_hash",
    cascade_input: "cascade_input_hash",
    cascade_output: "cascade_output_hash",
  };
  for (const [f, h] of Object.entries(hashOf)) {
    const recomputed = hashPart(read[f]);
    if (recomputed !== row[h]) diffs.push(`${h}: wrote=${row[h]} recomputedFromRead=${recomputed}`);
  }

  if (diffs.length) {
    console.log(`  ✗ ${name}`);
    for (const d of diffs.slice(0, 8)) console.log(`      ${d}`);
    failures++;
  } else {
    console.log(`  ✓ ${name}`);
  }
}

await db.from("smc_scan_decision").delete().eq("scan_cycle_id", CYCLE);
const { count } = await db.from("smc_scan_decision")
  .select("*", { count: "exact", head: true }).eq("scan_cycle_id", CYCLE);
console.log(`\n  probe rows remaining: ${count ?? 0}`);
console.log(`  ${failures === 0 ? "ROUND_TRIP_OK" : `ROUND_TRIP_FAILED (${failures})`}\n`);
if (failures) Deno.exit(1);
