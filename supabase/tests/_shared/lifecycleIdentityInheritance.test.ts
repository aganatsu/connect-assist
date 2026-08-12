// A pending order must not mint a new identity when a durable one exists.
//
// Step 3 of docs/PENDING_ORDER_PREARMING_PLAN.md.
//
// Measured 2026-08-12: 30 of 1,325 pending_orders rows carried a candidate_id.
// bot-scanner fell back to crypto.randomUUID() whenever an order was not
// promoted from staging (~8877), and the breaker path randomised
// UNCONDITIONALLY (~10780) — even though existingStaged is in scope there and a
// watchlist row for that symbol/direction may already own the lifecycle.
//
// Minting is not itself wrong: a fresh UUID is the BIRTH of a lifecycle. Minting
// while a durable source exists forks the identity, and the two halves can never
// be reconciled afterwards — the watchlist row and the pending order become
// different opportunities that happen to describe the same setup.
//
// `generate` is injected so these tests can assert it is NOT called. Asserting
// only on the returned value would pass even if a UUID were minted and then
// discarded, which is the bug shaped as a near-miss.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { resolveLifecycleCandidateId } from "../../functions/_shared/setupLifecycle.ts";

function counter() {
  let calls = 0;
  return {
    generate: () => {
      calls++;
      return `minted-${calls}`;
    },
    get calls() {
      return calls;
    },
  };
}

Deno.test("promoted evidence wins — the order came from that watchlist row", () => {
  const g = counter();
  const id = resolveLifecycleCandidateId({
    inheritedCandidateId: "promoted-abc",
    stagedCandidateId: "staged-xyz",
    stagedRowId: "row-123",
  }, g.generate);
  assertEquals(id.candidateId, "promoted-abc");
  assertEquals(id.source, "promoted_evidence");
  assertEquals(id.inherited, true);
  assertEquals(g.calls, 0, "must not mint when a durable source exists");
});

Deno.test("falls back to the staged row's candidate_id", () => {
  const g = counter();
  const id = resolveLifecycleCandidateId({
    stagedCandidateId: "staged-xyz",
    stagedRowId: "row-123",
  }, g.generate);
  assertEquals(id.candidateId, "staged-xyz");
  assertEquals(id.source, "staged_candidate");
  assertEquals(g.calls, 0);
});

Deno.test("falls back to the staged row id when candidate_id was never populated", () => {
  // 1,295 of 1,325 historical rows have no candidate_id. The row id is still
  // durable and still points at exactly one watchlist row, which beats minting.
  const g = counter();
  const id = resolveLifecycleCandidateId({ stagedRowId: "row-123" }, g.generate);
  assertEquals(id.candidateId, "row-123");
  assertEquals(id.source, "staged_row");
  assertEquals(id.inherited, true);
  assertEquals(g.calls, 0);
});

Deno.test("mints only when there is genuinely nothing to inherit", () => {
  const g = counter();
  const id = resolveLifecycleCandidateId({}, g.generate);
  assertEquals(id.candidateId, "minted-1");
  assertEquals(id.source, "generated");
  assertEquals(
    id.inherited,
    false,
    "a direct pending order with no watchlist row is the birth of a lifecycle — " +
      "minting there is correct, not a fallback",
  );
  assertEquals(g.calls, 1);
});

Deno.test("blank and whitespace ids are not durable sources", () => {
  const g = counter();
  const id = resolveLifecycleCandidateId({
    inheritedCandidateId: "",
    stagedCandidateId: "   ",
    stagedRowId: null,
  }, g.generate);
  assertEquals(
    id.source,
    "generated",
    "an empty string would otherwise become a shared identity across every setup " +
      "that also had one — worse than minting",
  );
});

Deno.test("resolution is deterministic for the same inputs", () => {
  const a = resolveLifecycleCandidateId({ stagedCandidateId: "x" }, () => "n1");
  const b = resolveLifecycleCandidateId({ stagedCandidateId: "x" }, () => "n2");
  assertEquals(a.candidateId, b.candidateId, "rescans must resolve to the same identity");
});

// ─── Wiring ──────────────────────────────────────────────────────────

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("neither pending creation path mints unconditionally any more", () => {
  assert(
    !/const pendingCandidateId =\s*\n?\s*pendingLifecycleEvidence\?\.candidateId \|\| crypto\.randomUUID\(\);/
      .test(scanner),
    "the normal path must consult the resolver, not fall straight through to a UUID",
  );
  assert(
    !/const breakerCandidateId = crypto\.randomUUID\(\);/.test(scanner),
    "the breaker path randomised unconditionally despite existingStaged being in scope",
  );
});

Deno.test("both paths offer the staged row as an inheritance source", () => {
  const uses = scanner.match(/resolveLifecycleCandidateId\(\{[\s\S]{0,320}?\}/g) ?? [];
  assertEquals(uses.length, 2, "normal and breaker pending creation");
  for (const use of uses) {
    assert(
      use.includes("stagedCandidateId") && use.includes("stagedRowId"),
      "a call that omits the staged sources can still silently mint: " + use,
    );
  }
});
