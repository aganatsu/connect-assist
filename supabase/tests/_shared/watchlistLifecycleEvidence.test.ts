import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deriveWatchlistInvalidation } from "../../functions/_shared/watchlistInvalidation.ts";
import {
  buildWatchlistLifecycleEvidence,
  deriveWatchlistLifecyclePhase,
  WATCHLIST_LIFECYCLE_EVIDENCE_VERSION,
} from "../../functions/_shared/watchlistLifecycleEvidence.ts";

const root = new URL("../../../", import.meta.url);
const scanner = Deno.readTextFileSync(
  new URL("supabase/functions/bot-scanner/index.ts", root),
);
const panel = Deno.readTextFileSync(
  new URL("src/components/WatchlistPanel.tsx", root),
);
const migration = Deno.readTextFileSync(
  new URL(
    "supabase/migrations/20260802143000_add_watchlist_lifecycle_evidence.sql",
    root,
  ),
);
const phaseMigration = Deno.readTextFileSync(
  new URL(
    "supabase/migrations/20260802180000_add_watchlist_lifecycle_phases.sql",
    root,
  ),
);

Deno.test("structural lifecycle evidence records the BTC boundary truth", () => {
  const invalidation = deriveWatchlistInvalidation({
    direction: "short",
    zone: { low: 63_310, high: 63_627.66 },
    proposedLevel: 63_451.585,
    bufferPrice: 20,
  });
  const evidence = buildWatchlistLifecycleEvidence({
    reasonCode: "structural_boundary_breached",
    observedAt: "2026-08-02T00:10:00Z",
    observedPrice: 63_650,
    frozenDirection: "short",
    invalidation,
  });

  assertEquals(evidence.version, WATCHLIST_LIFECYCLE_EVIDENCE_VERSION);
  assertEquals(evidence.reasonCode, "structural_boundary_breached");
  assertEquals(evidence.observedPrice, 63_650);
  assertEquals(evidence.boundary?.level, 63_647.66);
  assertEquals(evidence.boundary?.zone, {
    low: 63_310,
    high: 63_627.66,
  });
  assertEquals(evidence.boundary?.bufferPrice, 20);
});

Deno.test("production phase resolver follows the observed liquidity and confirmation chain", () => {
  assertEquals(
    deriveWatchlistLifecyclePhase({
      executionEligible: false,
    }),
    {
      phase: "monitoring_pre_zone",
      milestones: ["monitoring_pre_zone"],
    },
  );

  assertEquals(
    deriveWatchlistLifecyclePhase({
      executionEligible: true,
      hasZone: true,
      unifiedState: "waiting_for_sweep",
      priceAtZone: true,
      entryTriggerState: "unswept",
    }),
    {
      phase: "local_trigger_active",
      milestones: [
        "zone_discovered",
        "at_zone",
        "local_trigger_active",
      ],
    },
  );

  assertEquals(
    deriveWatchlistLifecyclePhase({
      executionEligible: true,
      hasZone: true,
      unifiedState: "confirmed",
      priceAtZone: true,
      entryTriggerState: "swept_rejected",
      confirmationReady: true,
    }),
    {
      phase: "confirmation_ready",
      milestones: [
        "zone_discovered",
        "at_zone",
        "local_trigger_active",
        "local_trigger_swept",
        "sweep_rejected",
        "confirmation_ready",
      ],
    },
  );
});

Deno.test("scanner assigns canonical codes to terminal and retained Watchlist decisions", () => {
  for (
    const reasonCode of [
      "structural_boundary_breached",
      "ttl_expired",
      "manual_dismissal",
      "fresh_direction_disagreement_retained",
      "fresh_score_below_watch_threshold_retained",
      "waiting_for_local_sweep",
      "waiting_for_reconfirmation",
    ]
  ) {
    assertStringIncludes(scanner, reasonCode);
  }
  assertEquals(scanner.includes("SL level breached"), false);
});

Deno.test("database audit and UI preserve and explain the same lifecycle evidence", () => {
  assertStringIncludes(migration, "lifecycle_reason_code");
  assertStringIncludes(migration, "lifecycle_evidence");
  assertStringIncludes(migration, "reason_code");
  assertStringIncludes(
    migration,
    "'lifecycleEvidence', NEW.lifecycle_evidence",
  );
  assertStringIncludes(panel, "STRUCTURE BROKEN");
  assertStringIncludes(panel, "Frozen zone:");
  assertStringIncludes(panel, "Boundary buffer:");
  assertStringIncludes(panel, "Observed price:");
  assertStringIncludes(panel, "WAITING FOR LOCAL SWEEP");
  assertStringIncludes(panel, "LOCAL TRIGGER ACTIVE");
  assertStringIncludes(panel, "SWEEP REJECTED");
  assertStringIncludes(panel, "Observed chain:");
  assertStringIncludes(phaseMigration, "lifecycle_phase");
  assertStringIncludes(
    phaseMigration,
    "NEW.lifecycle_phase IS DISTINCT FROM OLD.lifecycle_phase",
  );
  assertStringIncludes(phaseMigration, "'entry_authorized'");
  assertStringIncludes(phaseMigration, "'position_managing'");
  assertStringIncludes(scanner, "deriveWatchlistLifecyclePhase");
  assertStringIncludes(
    scanner.replace(/\s+/g, " "),
    "stagedDecisionFields( originatingZone, executionEligible, frozenEntryZone, )",
  );
  assert(
    panel.indexOf("Observed price:") <
      panel.indexOf("Boundary:"),
  );
});
