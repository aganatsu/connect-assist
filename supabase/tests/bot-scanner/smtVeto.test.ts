/**
 * smtVeto.test.ts — Gate 9b: SMT Opposite Veto
 * ──────────────────────────────────────────────
 * Validates that the SMT Opposite Veto gate correctly blocks trades
 * when the SMT Divergence factor detail contains the exact phrase
 * "opposite to signal direction", and passes in all other cases.
 *
 * The gate logic (from bot-scanner/index.ts, Gate 9b):
 *   const smtFactor = analysis.factors?.find(f => f.name === "SMT Divergence");
 *   if (smtFactor && smtFactor.detail && smtFactor.detail.includes("opposite to signal direction")) {
 *     gates.push({ passed: false, reason: "SMT divergence opposite — vetoed" });
 *   } else {
 *     gates.push({ passed: true, reason: "SMT veto: no opposition detected" });
 *   }
 *
 * We extract the gate logic into a local pure function for unit testing,
 * then also verify the source code presence in bot-scanner/index.ts.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { readFileSync } from "node:fs";

// ─── Local replica of Gate 9b logic (pure function, no side effects) ──────
interface GateResult {
  passed: boolean;
  reason: string;
}

interface Factor {
  name: string;
  present: boolean;
  weight: number;
  detail: string;
}

function smtVetoGate(factors: Factor[] | undefined | null): GateResult {
  const smtFactor = factors?.find((f) => f.name === "SMT Divergence");
  if (smtFactor && smtFactor.detail && smtFactor.detail.includes("opposite to signal direction")) {
    return { passed: false, reason: `SMT divergence opposite — vetoed` };
  } else {
    return { passed: true, reason: `SMT veto: no opposition detected` };
  }
}

// ─── Test 1: SMT detail contains "opposite to signal direction" → gate FAILS ──
Deno.test("Gate 9b: SMT opposite to signal direction → veto (trade blocked)", () => {
  const factors: Factor[] = [
    { name: "Market Structure", present: true, weight: 1.5, detail: "2 CHoCH (close-based)" },
    { name: "Order Block", present: true, weight: 1.8, detail: "Price inside bullish OB" },
    { name: "SMT Divergence", present: false, weight: 0, detail: "SMT detected (bearish) but opposite to signal direction" },
  ];

  const result = smtVetoGate(factors);
  assertEquals(result.passed, false, "Gate should FAIL when SMT is opposite to signal direction");
  assertEquals(result.reason, "SMT divergence opposite — vetoed");
});

// ─── Test 2: SMT aligned with signal → gate PASSES ──
Deno.test("Gate 9b: SMT aligned with signal direction → pass (trade proceeds)", () => {
  const factors: Factor[] = [
    { name: "Market Structure", present: true, weight: 1.5, detail: "2 BOS (close-based)" },
    { name: "SMT Divergence", present: true, weight: 1.0, detail: "SMT aligned: SMT detected (bullish) — aligned with signal" },
  ];

  const result = smtVetoGate(factors);
  assertEquals(result.passed, true, "Gate should PASS when SMT aligns with signal");
  assertEquals(result.reason, "SMT veto: no opposition detected");
});

// ─── Test 3: SMT factor present:false with "No SMT" detail → gate PASSES ──
Deno.test("Gate 9b: SMT not detected (no divergence found) → pass", () => {
  const factors: Factor[] = [
    { name: "Market Structure", present: true, weight: 1.2, detail: "1 BOS" },
    { name: "SMT Divergence", present: false, weight: 0, detail: "No SMT divergence detected on GBP/USD" },
  ];

  const result = smtVetoGate(factors);
  assertEquals(result.passed, true, "Gate should PASS when no SMT divergence is detected");
  assertEquals(result.reason, "SMT veto: no opposition detected");
});

// ─── Test 4: SMT factor missing entirely from factorScores → gate PASSES ──
Deno.test("Gate 9b: SMT factor missing from factors array → pass (cannot veto on missing data)", () => {
  const factors: Factor[] = [
    { name: "Market Structure", present: true, weight: 1.5, detail: "2 CHoCH" },
    { name: "Order Block", present: true, weight: 1.8, detail: "Inside OB" },
    // No SMT Divergence factor at all
  ];

  const result = smtVetoGate(factors);
  assertEquals(result.passed, true, "Gate should PASS when SMT factor is entirely absent");
  assertEquals(result.reason, "SMT veto: no opposition detected");

  // Also test with undefined/null factors array
  const resultUndefined = smtVetoGate(undefined);
  assertEquals(resultUndefined.passed, true, "Gate should PASS when factors is undefined");

  const resultNull = smtVetoGate(null);
  assertEquals(resultNull.passed, true, "Gate should PASS when factors is null");
});

// ─── Test 5: Detail contains "opposite" in different context → must NOT veto ──
// The match must require the FULL phrase "opposite to signal direction"
Deno.test("Gate 9b: Detail with 'opposite' in different context → pass (no false positive)", () => {
  const factors: Factor[] = [
    { name: "SMT Divergence", present: false, weight: 0, detail: "SMT detected on opposite leg structure — no divergence confirmed" },
  ];

  const result = smtVetoGate(factors);
  assertEquals(result.passed, true, "Gate should PASS — 'opposite' alone without full phrase must not trigger veto");

  // Additional edge case: partial phrase match that shouldn't trigger
  const factors2: Factor[] = [
    { name: "SMT Divergence", present: false, weight: 0, detail: "opposite direction detected but not to signal" },
  ];
  const result2 = smtVetoGate(factors2);
  assertEquals(result2.passed, true, "Gate should PASS — scrambled words must not trigger veto");

  // Edge case: "opposite to signal" without "direction" at end
  const factors3: Factor[] = [
    { name: "SMT Divergence", present: false, weight: 0, detail: "SMT opposite to signal strength" },
  ];
  const result3 = smtVetoGate(factors3);
  assertEquals(result3.passed, true, "Gate should PASS — 'opposite to signal strength' is not the target phrase");
});

// ─── Structural verification: Gate 9b exists in bot-scanner source ──
Deno.test("Gate 9b: Source code presence verification in bot-scanner/index.ts", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url).pathname, "utf-8");

  // Verify the gate comment exists
  const hasGateComment = source.includes("Gate 9b: SMT Opposite Veto");
  assertEquals(hasGateComment, true, "Gate 9b comment must exist in bot-scanner/index.ts");

  // Verify the exact matching phrase is used (not a partial match)
  const hasExactPhrase = source.includes('"opposite to signal direction"');
  assertEquals(hasExactPhrase, true, "Gate must match the exact phrase 'opposite to signal direction'");

  // Verify the gate produces the expected reason string
  const hasVetoReason = source.includes("SMT divergence opposite — vetoed");
  assertEquals(hasVetoReason, true, "Gate must produce the reason 'SMT divergence opposite — vetoed'");

  // Verify gate is positioned after Gate 9 and before Gate 10
  const gate9Idx = source.indexOf("// Gate 9: Min confluence");
  const gate9bIdx = source.indexOf("// Gate 9b: SMT Opposite Veto");
  const gate10Idx = source.indexOf("// Gate 10: Min R:R");
  assertEquals(gate9bIdx > gate9Idx, true, "Gate 9b must come after Gate 9");
  assertEquals(gate9bIdx < gate10Idx, true, "Gate 9b must come before Gate 10");
});
