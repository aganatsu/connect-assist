import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { newCapture, toRow, hashPart, slimPositions, sanitizeConfigForCapture, readiness }
  from "../../functions/_shared/smcDecisionCapture.ts";

Deno.test("the capture module is pure — no database, network, logging or clock", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/smcDecisionCapture.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
  for (const b of ["createClient","supabase-js","fetch(","Deno.env",".from(","Date.now(","console."]) {
    assert(!code.includes(b), `capture module reaches ${b}`);
  }
});

Deno.test("the decision write is fail-open and happens after the pair loop", async () => {
  const src = await Deno.readTextFile("supabase/functions/bot-scanner/index.ts");
  const at = src.indexOf('from("smc_scan_decision")');
  assert(at > 0, "the decision write is gone");
  const loopEnd = src.indexOf("// Update counters — scope to this bot's account");
  assert(at < loopEnd, "the write must run after the pair loop, not inside a decision");
  const block = src.slice(at - 2200, at + 600);
  assert(/catch \(e: any\) \{[\s\S]*?decisionFailures\+\+;[\s\S]*?console\.warn/.test(block),
    "a failure must be caught, counted and warned — never rethrown");
  // Nothing downstream may branch on the counters.
  for (const m of src.matchAll(/decisions(?:Written|Failures)/g)) {
    const around = src.slice(Math.max(0, m.index! - 60), m.index! + 60);
    assert(!/\bif\s*\([^)]*decision(?:sWritten|Failures)/i.test(around),
      `a decision branches on the capture counter: ${around.trim()}`);
  }
});

Deno.test("positions are slimmed and order-stable, so digests track decisions not row order", () => {
  const a = slimPositions([{ position_id: "p2", symbol: "B" }, { position_id: "p1", symbol: "A" }]);
  const b = slimPositions([{ position_id: "p1", symbol: "A" }, { position_id: "p2", symbol: "B" }]);
  assertEquals(hashPart(a), hashPart(b), "database row order must not change the digest");
  assertEquals((a[0] as any).position_id, "p1");
  // Audit columns that churn without changing a decision must be dropped.
  const s = slimPositions([{ position_id: "p", symbol: "X", updated_at: "now", broker_order_id: "9" }]);
  assert(!("updated_at" in (s[0] as any)) && !("broker_order_id" in (s[0] as any)));
});

Deno.test("injected blobs are replaced by digests, not stored twice", () => {
  const out = sanitizeConfigForCapture({
    minConfluence: 40, _htfLiquidityPools: { d: [1,2,3] }, _h4Candles: [1,2,3], fn: () => 1,
  });
  assertEquals(out.minConfluence, 40);
  assert(!("_htfLiquidityPools" in out) && !("_h4Candles" in out));
  assert(typeof out._htfLiquidityPools__hash === "string");
  assert(!("fn" in out), "functions never survive jsonb; they must not be hashed either");
});

Deno.test("every stored artefact has a digest, including the two outputs", () => {
  const c = newCapture("s","u","smc","EUR/USD","scalper");
  c.gates_output = { gates: [] }; c.portfolio_output = { concentrationScore: 0 };
  c.final_decision = { status: "rejected" };
  const r = toRow(c);
  for (const h of ["gates_output_hash","portfolio_output_hash","final_hash"]) {
    assert(typeof r[h] === "string", `${h} missing — an artefact with no digest cannot be drift-checked`);
  }
  // Absent stages hash to null rather than to the hash of nothing.
  assertEquals(r.direction_hash, null);
});

Deno.test("readiness is measured from the row, not asserted", () => {
  const c = newCapture("s","u","smc","EUR/USD","scalper");
  c.direction_input = { style: "scalper" };
  const r = toRow(c);
  const rd = readiness(r);
  assertEquals(rd.direction, true);
  assertEquals(rd.gates, false, "a stage with no captured input is not ready");
});
