/**
 * STEP 17-B — skipped_tp_too_small is log-only in the locked dry run, a hard
 * block everywhere else; no later gate is bypassed; the tag reaches the
 * decision record, the order's dry_run_context and attribution.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateTpSmallGate, TP_SMALL_GATE_ID } from "../../functions/_shared/tpSmallGate.ts";
import { buildAttribution, type AttributionInput } from "../../functions/_shared/attribution.ts";

Deno.test("locked dry run + TP too small → logged and tagged, NOT blocked", () => {
  const g = evaluateTpSmallGate({ symbol: "GBP/USD", tpPips: 14.9, minTpPips: 20, dryRunActive: true });
  assertEquals([g.wouldBlock, g.mode, g.block], [true, "log", false]);
  assertEquals(g.record, { gateId: TP_SMALL_GATE_ID, wouldBlock: true, mode: "log", symbol: "GBP/USD", tpPips: 14.9, minTpPips: 20,
    basis: "legacy_market_target_from_last_price", reason: "TP 14.9p < min 20p" });
});

Deno.test("unlocked / live (dry run not active) → the existing hard block, unchanged", () => {
  const g = evaluateTpSmallGate({ symbol: "GBP/USD", tpPips: 14.9, minTpPips: 20, dryRunActive: false });
  assertEquals([g.wouldBlock, g.mode, g.block, g.record], [true, "hard", true, null]);
});

Deno.test("a TP at or above the minimum is untouched in both modes (exactly at the minimum passes, as before: `<`)", () => {
  for (const dryRunActive of [true, false]) {
    for (const tpPips of [20, 27.5]) {
      const g = evaluateTpSmallGate({ symbol: "GBP/USD", tpPips, minTpPips: 20, dryRunActive });
      assertEquals([g.wouldBlock, g.block, g.record], [false, false, null]);
    }
  }
});

// ── wiring in bot-scanner ───────────────────────────────────────────────────
const scanner = Deno.readTextFileSync(new URL("../../functions/bot-scanner/index.ts", import.meta.url));
const gateAt = scanner.indexOf("const tpGate = evaluateTpSmallGate({ symbol: pair, tpPips: actualTpPips, minTpPips, dryRunActive });");
const gateBlock = scanner.slice(gateAt, scanner.indexOf("// ── Portfolio Correlation Advisory", gateAt));

Deno.test("wiring: the hard-block branch is the previous code verbatim, taken only when tpGate.block", () => {
  assert(gateAt > 0);
  assert(/if \(tpGate\.block\) \{\s*console\.log\(`\[\$\{pair\}\] TP too small: \$\{actualTpPips\.toFixed\(1\)\} pips < min \$\{minTpPips\} pips\. Trade not worth the spread cost\. SKIPPING\.`\);\s*detail\.status = "skipped_tp_too_small";\s*detail\.skipReason = `TP \$\{actualTpPips\.toFixed\(1\)\}p < min \$\{minTpPips\}p`;\s*scanDetails\.push\(detail\);\s*continue;\s*\}/.test(gateBlock));
  assert(/const minTpPips = MIN_TP_PIPS\[pair\] \?\? 12;\s*const actualTpPips = Math\.abs\(tp - analysis\.lastPrice\) \/ spec\.pipSize;/.test(scanner), "same measurement and table");
  assert(/const dryRunActive = account\.entries_locked === true && simp\.dryRunWhenLocked;/.test(scanner), "dry run = entries locked + dryRunWhenLocked");
});

Deno.test("wiring: the logged branch tags the detail and the logged-only list, and does NOT skip the setup", () => {
  const logged = gateBlock.slice(gateBlock.indexOf("if (tpGate.record) {"));
  assert(logged.includes("(detail as any).tpTooSmall = tpGate.record;"));
  assert(logged.includes("(detail as any).loggedOnlyGates = [...((detail as any).loggedOnlyGates ?? []), { gateId: tpGate.record.gateId, reason: tpGate.record.reason }];"));
  assert(!/continue;/.test(logged), "the logged branch continues through the pipeline");
});

Deno.test("no later gate is bypassed: market-entry refusal, distance cap, Route 2 stop, order R:R and placement all follow, none reads the TP tag", () => {
  const idx = (s: string) => scanner.indexOf(s, gateAt);
  const order = [
    idx('detail.status = "market_entry_disabled";'),
    idx("// ── ROUTE 2 DISTANCE GUARD"),
    idx("const anchored = route2StopFromLimit({"),
    idx('detail.status = "zone_setup_rejected_rr";'),
    idx("await placeRoute2Order(supabase,"),
  ];
  assert(order.every((x) => x > gateAt), "every later gate is after the TP gate");
  assert(order.every((x, i) => i === 0 || x > order[i - 1]), "in the production order");
  const after = scanner.slice(gateAt + gateBlock.length, order[4]);
  assert(!/tpTooSmall[^:]*\?\s*continue|if \(\(detail as any\)\.tpTooSmall\)/.test(after), "nothing short-circuits on the tag");
  // safety gates, caps, correlation, cooldown, Step 13, impulse hard gate run BEFORE the TP gate (unchanged)
  assert(scanner.indexOf("const gates = await runSafetyGates(") < gateAt);
  assert(scanner.indexOf('const izGateMode = pairConfig.impulseZoneGateMode ?? "hard";') < gateAt);
});

Deno.test("tagging reaches the decision record (only when present), the order's dry_run_context and attribution", () => {
  assert(scanner.includes("...(d.tpTooSmall ? { tpTooSmall: d.tpTooSmall } : {}),"), "final_decision: the key appears only for tagged setups");
  assert(/loggedOnlyWouldBlock: \(detail as any\)\.loggedOnlyGates \?\? \[\],\s*\/\/ Step 17-B[^\n]*\n\s*tpTooSmall: \(detail as any\)\.tpTooSmall \?\? null,/.test(scanner), "dry_run_context");
  assert(scanner.includes("tpSmallGate: (detail as any).tpTooSmall ?? null,"), "buildAttribution input");
});

// ── attribution ─────────────────────────────────────────────────────────────
// the same complete input shape the Step 15 attribution tests use
const INPUT: AttributionInput = {
  signalId: "11111111-1111-4111-8111-111111111111", decisionId: "22222222-2222-4222-8222-222222222222",
  scanCycleId: "33333333-3333-4333-8333-333333333333", userId: "u", botId: "smc", symbol: "GBP/USD", direction: "long", dryRun: true,
  decisionAt: "2026-10-08T12:00:00Z", configVersion: "1037e6170289f865e4d6618dcf28b94d", strategyVersion: "smc-zone-impulse-control-v1",
  switches: { sizingMode: "fill_time", riskPercent: 0.5, maxLotsPerTrade: 20, stopAnchor: "limit", unifiedModifiersEnabled: false },
  legacyRiskPercent: 0.5, management: { breakEvenEnabled: false, trailingStopEnabled: false, partialTPEnabled: false, maxHoldEnabled: false, maxHoldHours: 0 },
  caps: { mode: "unified", maxOpenPositions: 3, maxPerSymbol: 1 }, impulseSlCapMultiplier: 1.5, riskProfileVersion: null,
  entrySource: "refinedEntry", izGateMode: "hard", gamePlanEnabled: true,
  gamePlanContext: { bias: "bullish", biasConfidence: 55, isFocusPair: true },
  directionVerdict: { verdict: "long", confidence: 75, agreement: 0.5 },
  impulse: { hasZone: true, selectedTF: "1H", impulse: { high: 1.3260, low: 1.3190 }, bestZone: { type: "fvg", low: 1.3195, high: 1.3215, fibLevel: 0.618, refinedEntry: 1.322, totalScore: 3 } },
  unifiedDetected: null, unifiedComparison: null,
  gateScore: 60, decisionScoreGate: { mode: "log", score: 60, threshold: 20, wouldBlock: false },
  factors: [], gates: [{ passed: true, reason: "0/3 positions" }],
  ictFvgGate: { mode: "off", wouldBlock: false }, orderRR: { rawRR: 1.1, effectiveRR: 1.04, costInPrice: 0.00015, wouldBlock: false, min: 1, mode: "order_geometry" },
  loggedOnlyWouldBlock: [],
  riskGate: { enabled: false, allowed: true, reason: "no active risk profile" },
  zoneId: "GBP/USD|1H|long|1.3195|1.3215", entryDepth: 0.55,
  limitPrice: 1.322, stopPrice: 1.3195, targetPrice: 1.32475, pipSize: 0.0001,
  route2Stop: { anchor: "limit", floorPips: 25, capPips: 100.6, limit: { source: "floor", riskPips: 25 }, market: { sl: 1.3201, riskPipsFromLimit: 19, belowFloor: true } },
  plannedSizing: { lots: 2, uncappedLots: 2, riskPercentTarget: 0.5, riskUsdTarget: 500 }, balance: 100000, expiresAt: "2026-10-08T20:00:00Z",
};
const attrInput = (over: Partial<AttributionInput> = {}) => ({ ...INPUT, ...over }) as AttributionInput;

Deno.test("attribution: a tagged setup records the tp_too_small verdict with its numbers, is logged-only, and legacy would not admit it", () => {
  let a: any;
  try {
    a = buildAttribution(attrInput({
      loggedOnlyWouldBlock: [{ gateId: "tp_too_small", reason: "TP 14.9p < min 20p" }],
      tpSmallGate: { tpPips: 14.9, minTpPips: 20, basis: "legacy_market_target_from_last_price", reason: "TP 14.9p < min 20p" },
    }));
  } catch (e) { throw new Error(`buildAttribution input shape: ${(e as Error).message}`); }
  const v = (a.gates as any[]).find((g) => g.gate_id === "tp_too_small");
  assertEquals(v, { gate_id: "tp_too_small", mode: "log", passed: false, would_block: true, reason: "TP 14.9p < min 20p", tp_pips: 14.9, min_tp_pips: 20, basis: "legacy_market_target_from_last_price" });
  assert((a.logged_only_would_block as string[]).includes("tp_too_small"));
  assertEquals(a.legacy_would_admit, false);
});

Deno.test("attribution: an untagged setup is unchanged (no tp_too_small verdict)", () => {
  const a: any = buildAttribution(attrInput({}));
  assert(!(a.gates as any[]).some((g) => g.gate_id === "tp_too_small"));
  assert(!(a.logged_only_would_block as string[]).includes("tp_too_small"));
});
