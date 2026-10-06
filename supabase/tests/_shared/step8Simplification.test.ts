/**
 * STEP 8 — simplification switches: defaults, the log-only transform, the
 * order-geometry R:R check, Unified-vs-Impulse comparison, and the wiring in
 * bot-scanner / zone-confirmation-scanner. The database safety net (no
 * position / real order while locked; dry-run never becomes real) is proven in
 * paperSettlementLedger.test.ts.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyLoggedOnlyGates, LEGACY_SWITCHES, orderEffectiveRR, resolveSimplification, unifiedVsImpulse,
  type GateResult,
} from "../../functions/_shared/simplification.ts";

const MINIMAL = {
  simplification: {
    scoreGateMode: "log", reactionGateMode: "log", rrGateMode: "order_geometry", orderRRMin: 1.0,
    newsGateMode: "log", unifiedModifiersEnabled: false, dryRunWhenLocked: true,
  },
};

Deno.test("absent or malformed switches resolve to LEGACY behaviour (deploying changes nothing)", () => {
  assertEquals(resolveSimplification(null), LEGACY_SWITCHES);
  assertEquals(resolveSimplification({}), LEGACY_SWITCHES);
  assertEquals(resolveSimplification({ simplification: { scoreGateMode: "off", rrGateMode: "x", orderRRMin: -1, unifiedModifiersEnabled: "no", dryRunWhenLocked: "yes" } }), LEGACY_SWITCHES);
});

Deno.test("the approved minimal switches resolve exactly", () => {
  const s = resolveSimplification(MINIMAL);
  assertEquals(s, { scoreGateMode: "log", reactionGateMode: "log", rrGateMode: "order_geometry", orderRRMin: 1.0, newsGateMode: "log", unifiedModifiersEnabled: false, dryRunWhenLocked: true,
    // step 9 sizing switches are not part of the step 8 config → legacy defaults
    sizingMode: "legacy", riskPercent: 0.5, maxLotsPerTrade: 20 });
});

const gates: GateResult[] = [
  { gateId: "reaction", passed: false, reason: "Reaction Confirmation BLOCKED: Ranging market" },
  { gateId: "score", passed: false, reason: "Score 15 < 20 threshold" },
  { gateId: "rr_legacy", passed: false, reason: "R:R 0.9 raw, 0.8 effective" },
  { gateId: "news_event", passed: false, reason: "News filter: high-impact event within 60min" },
  { gateId: "news_alignment", passed: true, reason: "News confirms" },
  { passed: false, reason: "Already long on EUR/USD — no duplicate" }, // stacking: never switchable
];

Deno.test("legacy switches leave every gate result untouched", () => {
  const t = applyLoggedOnlyGates(gates, LEGACY_SWITCHES);
  assertEquals(t.gates, gates);
  assertEquals(t.wouldHaveBlocked, []);
});

Deno.test("minimal switches: score, reaction, legacy R:R and news become logged passes; stacking still blocks", () => {
  const t = applyLoggedOnlyGates(gates, resolveSimplification(MINIMAL));
  assertEquals(t.wouldHaveBlocked.map((w) => w.gateId), ["reaction", "score", "rr_legacy", "news_event"]);
  for (const g of t.gates.slice(0, 4)) {
    assertEquals(g.passed, true);
    assertEquals(g.wouldBlock, true);
    assert(g.reason.startsWith("[logged only — would block]"));
  }
  assertEquals(t.gates[4].wouldBlock, false, "a passing logged gate records wouldBlock false");
  assertEquals(t.gates[5].passed, false, "the stacking guard is kept");
  assertEquals(t.gates.every((g) => g.passed), false);
});

Deno.test("each switch is independent", () => {
  const onlyNews = applyLoggedOnlyGates(gates, resolveSimplification({ simplification: { newsGateMode: "log" } }));
  assertEquals(onlyNews.wouldHaveBlocked.map((w) => w.gateId), ["news_event"]);
  assertEquals(onlyNews.gates[1].passed, false, "score still gates");
});

Deno.test("order R:R: tpRatio 1.1 minus spread — passes with a wide stop, fails when spread dominates", () => {
  // EUR/USD long, limit 1.10000, stop 1.09800 (20 pips), TP = 1.1 × risk = 22 pips.
  const wide = orderEffectiveRR({ entry: 1.10000, stop: 1.09800, target: 1.10220, symbol: "EUR/USD" });
  assert(Math.abs(wide.rawRR - 1.1) < 1e-9);
  assert(wide.effectiveRR >= 1.0, `20-pip stop clears 1.0 after spread: ${wide.effectiveRR}`);
  // 3-pip stop: TP 3.3 pips; the spread eats most of the reward.
  const tight = orderEffectiveRR({ entry: 1.10000, stop: 1.09970, target: 1.10033, symbol: "EUR/USD" });
  assert(tight.effectiveRR < 1.0, `3-pip stop fails after spread: ${tight.effectiveRR}`);
  // Commission is a cost too.
  const withComm = orderEffectiveRR({ entry: 1.10000, stop: 1.09800, target: 1.10220, symbol: "EUR/USD", commissionPerLot: 7 });
  assert(withComm.effectiveRR < wide.effectiveRR);
  // Degenerate geometry never passes.
  assertEquals(orderEffectiveRR({ entry: 1.1, stop: 1.1, target: 1.1022, symbol: "EUR/USD" }).effectiveRR, 0);
});

Deno.test("Unified vs Impulse comparison records both legs and their differences", () => {
  const c = unifiedVsImpulse({
    direction: "long", tpRatio: 1.1, pipSize: 0.0001,
    unified: { entryPrice: 1.1010, slPrice: 1.0990, state: "confirmed", score: 11 },
    impulse: { refinedEntry: 1.1000, high: 1.1015, low: 1.0995, originSL: 1.0980 },
  });
  assertEquals(c.unified!.entry, 1.1010);
  assert(Math.abs(c.unified!.tp - (1.1010 + 0.0020 * 1.1)) < 1e-12);
  assertEquals(c.impulse!.entry, 1.1000);
  assert(Math.abs(c.entryDiffPips! - 10) < 1e-9);
  assert(Math.abs(c.riskRatioUnifiedToImpulse! - 1) < 1e-9);
  const noUnified = unifiedVsImpulse({ direction: "short", tpRatio: 1.1, pipSize: 0.0001, unified: null, impulse: { high: 1.2, low: 1.19, originSL: 1.21 } });
  assertEquals(noUnified.unified, null);
  assert(Math.abs(noUnified.impulse!.entry - 1.195) < 1e-12, "zone midpoint when no refined entry");
});

// ─── wiring (source) ────────────────────────────────────────────────────────

const scanner = Deno.readTextFileSync(new URL("../../functions/bot-scanner/index.ts", import.meta.url));
const zcs = Deno.readTextFileSync(new URL("../../functions/zone-confirmation-scanner/index.ts", import.meta.url));

Deno.test("dry run: only when locked AND switched on; otherwise locked stays paused", () => {
  assert(/const dryRunActive = account\.entries_locked === true && simp\.dryRunWhenLocked;/.test(scanner));
  assert(/const isPaused = dryRunActive \? false : \(account\.is_paused \|\| account\.entries_locked === true\);/.test(scanner));
});

Deno.test("score gate: decision gate honours the switch and always records would-block", () => {
  assert(/\(detail as any\)\.scoreGate = \{ mode: simp\.scoreGateMode, wouldBlock: scoreWouldBlock/.test(scanner));
  assert(/if \(\(simp\.scoreGateMode === "log" \|\| !scoreWouldBlock\) && analysis\.direction && !isPaused\)/.test(scanner));
});

Deno.test("log-only transform runs on the full gate list right before allPassed", () => {
  const t = scanner.indexOf("const t = applyLoggedOnlyGates(gates as any, simp);");
  const a = scanner.indexOf("const allPassed = gates.every(g => g.passed);");
  assert(t > 0 && a > t && a - t < 800);
  const newsAlign = scanner.indexOf("// ── News Impact Alignment Gate ──");
  assert(newsAlign > 0 && newsAlign < t, "news-alignment gate is pushed before the transform");
  for (const id of ["reaction", "score", "rr_legacy", "news_event", "news_alignment"]) {
    assert(scanner.includes(`gateId: "${id}"`), `gate ${id} is tagged`);
  }
});

Deno.test("order-geometry R:R is checked on the placed order, before sizing, and recorded always", () => {
  const rr = scanner.indexOf("const orr = orderEffectiveRR({ entry: limitEntry.price, stop: limitSL, target: limitTP");
  const size = scanner.indexOf("const limitSizingResult = computePositionSize(");
  const tp = scanner.indexOf("limitTP = limitEntry.price + riskFromLimit * config.tpRatio;");
  assert(tp > 0 && rr > tp && size > rr, "after the limit TP, before sizing");
  assert(/if \(simp\.rrGateMode === "order_geometry" && orrBlocks\)/.test(scanner));
});

Deno.test("ICT FVG would-block is recorded in every mode; it vetoes only in hard mode", () => {
  assert(/\(detail as any\)\.ictFVGGate = \{ mode: pairConfig\.ictFVGInvalidationGateMode, wouldBlock: ictFvgWouldBlock/.test(scanner));
  assert(/if \(pairConfig\.ictFVGInvalidationGateMode === "hard" && ictFvgWouldBlock\)/.test(scanner));
});

Deno.test("Unified modifiers off: detected and compared, but no bypass and standalone signal source", () => {
  const i = scanner.indexOf("unifiedZoneData.confirmation?.entryReady === true && !simp.unifiedModifiersEnabled) {");
  assert(i > 0);
  const block = scanner.slice(i, i + 900);
  assert(/\(detail as any\)\.signalSource = "standalone";/.test(block));
  assert(!/unifiedGatePassed = true/.test(block), "no Impulse-gate bypass");
  assert(/modifiersApplied: false/.test(block));
  assert(/\(detail as any\)\.unifiedComparison = unifiedVsImpulse\(/.test(scanner));
});

Deno.test("dry-run orders are flagged at insert, market entries are refused in dry run", () => {
  assert(/dry_run: dryRunActive,/.test(scanner));
  assert(/legacyWouldAdmit:/.test(scanner) && /unifiedComparison: \(detail as any\)\.unifiedComparison/.test(scanner));
  const g = scanner.indexOf("if (dryRunActive && !(effectiveLimitEnabled && limitEntry)) {");
  assert(g > 0 && /dry_run_market_skipped/.test(scanner.slice(g, g + 400)));
});

Deno.test("the hunt records a hypothetical fill for dry-run orders and never claims them", () => {
  const d = scanner.indexOf("if ((pending as any).dry_run === true) {");
  const claim = scanner.indexOf("const claim = await claimRoute2Fill(supabase, {");
  assert(d > 0 && d < claim, "dry-run branch precedes the real claim");
  const block = scanner.slice(d, d + 1200);
  assert(/status: "filled"/.test(block) && /\[DRY RUN — hypothetical\]/.test(block) && /continue;/.test(block));
  assert(!/claimRoute2Fill/.test(block));
  const z = zcs.indexOf("if ((pending as any).dry_run === true) continue;");
  assert(z > 0 && z < zcs.indexOf("claimRoute2Fill(supabase, {"), "the fast poller never fills dry-run orders");
});
