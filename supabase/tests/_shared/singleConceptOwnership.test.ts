/**
 * singleConceptOwnership.test.ts — the anti-duplication ratchet.
 *
 * Every trading concept in this system must have exactly ONE implementation.
 *
 * This repo has been written by several different agents across 300+ branches.
 * Each one, arriving with no context, faces the same choice: understand the
 * existing detector well enough to modify it, or write a new one that definitely
 * works. Writing new always wins locally. The aggregate was four fill models,
 * two premium/discount functions and two SMT detectors — all of which drifted.
 *
 * Nine consolidation branches tried to fix this by adding an arbiter *between*
 * the copies, which turns 2 implementations into 3. This test deletes instead:
 * a second implementation is a build failure, not a code review someone has to
 * catch.
 *
 * See docs/CONCEPT_INVENTORY.md for the full inventory and rationale.
 *
 * ── Adding a concept here ───────────────────────────────────────────────
 * When you consolidate a concept down to one owner, add its name to
 * SINGLE_OWNER so it can never be duplicated again.
 *
 * ── If this test fails ──────────────────────────────────────────────────
 * You (or an agent) added a second implementation of an existing concept.
 * Do NOT add an arbiter module to reconcile them, and do NOT add the name to
 * DELIBERATELY_DISTINCT to make the test pass. Modify the existing owner, or
 * delete it and replace it. Two implementations of one concept always drift.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const functionsRoot = new URL("../../functions/", import.meta.url);

/**
 * Concepts that must have exactly one implementation.
 * Grow this list as concepts are consolidated.
 */
const SINGLE_OWNER: string[] = [
  // ── Core SMC detection ──
  "detectFVGs",
  "detectOrderBlocks",
  "detectSwingPoints",
  "analyzeMarketStructure",
  "detectLiquidityPools",
  "detectUnicornSetups",
  "detectSweepReclaim",
  // ── Session and discovery scheduling ──
  "getSessionAffinity",
  "selectRotatingImpulseUniverse",
  // ── Consolidated 2026-08-10 (were duplicated in bot-scanner) ──
  "detectSMTDivergence",
  "calculatePremiumDiscount",
  "detectAMDPhase",
  // ── Risk / sizing ──
  "calculatePositionSize",
  "computePositionSize",
  "normalizeBrokerVolumeDown",
  "calculateSLTP",
  "finalizePaperPositionClose",
  "reconcileFullBrokerClose",
  "calcPnl",
  "checkBrokerConnectionAvailabilityAtExecution",
  "checkBrokerConnectionSizingAtExecution",
  "checkPortfolioHeatAtExecution",
  "checkCorrelationExposure",
  "resolveRoundTripCommission",
  // ── Game Plan generation ──
  "generateInstrumentGamePlan",
  // ── Post-placement direction ──
  "compareDirectionVerdicts",
  "isVerdictComplete",
  "buildDirectionVerdictThesisOptions",
  // ── Entry confirmation ──
  "detectZoneConfirmation",
  "selectICTEntryZone",
  "buildNestedPoiEntryPlan",
  "closedCandleTouchesRange",
];

/**
 * Concepts that legitimately have more than one implementation because they are
 * genuinely different ideas that were given colliding names. These are NOT
 * duplicates. Each entry must state why, and each must eventually be renamed so
 * the collision disappears.
 */
const DELIBERATELY_DISTINCT: Record<string, { count: number; why: string }> = {
  detectBreakerBlocks: {
    count: 2,
    why:
      "smcAnalysis = base_breaker_zone (is price at an inverted OB? scoring context). " +
      "breakerBlockDetection = sweep_displacement_retest_breaker_setup (entry trigger). " +
      "Named in breakerCandidateAuthority.ts. TODO: rename to detectBreakerZones / " +
      "detectBreakerRetestSetups so the collision disappears.",
  },
  detectJudasSwing: {
    count: 2,
    why:
      "smcAnalysis = session-based Judas. ictJudasSwing = pre-MSS Judas (mssIndex, " +
      "sweepLookback). Different concepts. TODO: rename.",
  },
  checkMaxDrawdown: {
    count: 2,
    why:
      "gateMaxDrawdown = account-level gate. propFirmRisk = prop-firm trailing/fixed " +
      "drawdown. Mutually exclusive paths with explicit delegation at Gate 8.",
  },
};

function collectSourceFiles(dir: URL, out: URL[] = []): URL[] {
  for (const entry of Deno.readDirSync(dir)) {
    const child = new URL(
      entry.name + (entry.isDirectory ? "/" : ""),
      dir,
    );
    if (entry.isDirectory) {
      collectSourceFiles(child, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(child);
    }
  }
  return out;
}

/**
 * A one-line delegating alias is NOT a second implementation. The codebase
 * convention is:
 *
 *   function detectSession(_config?: any): SessionResult { return sharedDetectSession(); }
 *
 * Definition, body and closing brace on a single line. That is the correct way
 * to expose a shared owner under a local name, so it is not counted.
 */
function isOneLineAlias(line: string): boolean {
  return /\breturn\b/.test(line) && line.trimEnd().endsWith("}");
}

function definitionSites(fnName: string, files: URL[]): string[] {
  const pattern = new RegExp(
    `^\\s*(export\\s+)?(async\\s+)?function\\s+${fnName}\\s*[(<]`,
  );
  const sites: string[] = [];
  for (const file of files) {
    const text = Deno.readTextFileSync(file);
    if (!text.includes(fnName)) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!pattern.test(lines[i])) continue;
      if (isOneLineAlias(lines[i])) continue; // delegating alias — allowed
      sites.push(
        `${file.pathname.split("/functions/")[1]}:${i + 1}`,
      );
    }
  }
  return sites;
}

const sourceFiles = collectSourceFiles(functionsRoot);

Deno.test("single ownership: each locked concept has exactly one implementation", () => {
  const violations: string[] = [];

  for (const fnName of SINGLE_OWNER) {
    const sites = definitionSites(fnName, sourceFiles);
    if (sites.length !== 1) {
      violations.push(
        `  ${fnName}: expected 1 implementation, found ${sites.length}\n` +
          sites.map((s) => `      ${s}`).join("\n"),
      );
    }
  }

  assertEquals(
    violations.join("\n"),
    "",
    "\n\nConcept ownership violated — a second implementation was added.\n\n" +
      violations.join("\n") +
      "\n\nDo not add an arbiter module to reconcile them, and do not add the name\n" +
      "to DELIBERATELY_DISTINCT to silence this. Modify the existing owner, or\n" +
      "delete it and replace it. See docs/CONCEPT_INVENTORY.md.\n",
  );
});

Deno.test("single ownership: nested POI adapter delegates eligibility and ranking", () => {
  const source = Deno.readTextFileSync(
    new URL("_shared/impulseZoneEngine.ts", functionsRoot),
  );
  const start = source.indexOf("export function buildNestedPoiEntryPlan");
  const end = source.indexOf("export function findStructuralLeg", start);
  const adapter = start >= 0 && end > start ? source.slice(start, end) : "";

  assertEquals(adapter.includes("selectICTEntryZone({"), true);
  assertEquals(adapter.includes(".sort("), false);
  assertEquals(adapter.includes("legacyScoreContribution"), false);
  assertEquals(adapter.includes("lifecycle ==="), false);
});

Deno.test("single ownership: nested POI touch delegates to the pending-zone owner", () => {
  const pending = Deno.readTextFileSync(
    new URL("_shared/pendingZoneTouch.ts", functionsRoot),
  );
  const lifecycle = Deno.readTextFileSync(
    new URL("_shared/tradeLifecycleAuthority.ts", functionsRoot),
  );
  const engine = Deno.readTextFileSync(
    new URL("_shared/impulseZoneEngine.ts", functionsRoot),
  );

  assertEquals(
    pending.includes("export function closedCandleTouchesRange"),
    true,
  );
  assertEquals(
    lifecycle.includes("closedCandleTouchesRange(input.candle, active)"),
    true,
  );
  assertEquals(lifecycle.includes("input.candle.high >= active.low"), false);
  assertEquals(engine.includes("nestedPoiTriggerTouchedByClosedCandle"), false);
});

Deno.test("single ownership: deliberately-distinct concepts keep their documented count", () => {
  for (const [fnName, spec] of Object.entries(DELIBERATELY_DISTINCT)) {
    const sites = definitionSites(fnName, sourceFiles);
    assertEquals(
      sites.length,
      spec.count,
      `${fnName} should have exactly ${spec.count} implementations ` +
        `(found ${sites.length} at ${
          sites.join(", ")
        }).\nWhy ${spec.count}: ${spec.why}`,
    );
  }
});

Deno.test("single ownership: locked concepts are not also listed as deliberately distinct", () => {
  const overlap = SINGLE_OWNER.filter((n) => n in DELIBERATELY_DISTINCT);
  assertEquals(
    overlap,
    [],
    `A concept cannot be both single-owner and deliberately distinct: ${
      overlap.join(", ")
    }`,
  );
});
