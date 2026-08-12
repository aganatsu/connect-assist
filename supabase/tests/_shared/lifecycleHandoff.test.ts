// A materially changed setup is a NEW opportunity, with a recorded link back.
//
// Step 4 of docs/PENDING_ORDER_PREARMING_PLAN.md.
//
// #318 already distinguishes "same setup re-detected" from "setup materially
// changed" via shouldSupersedePendingOrder(). What was missing is the record:
// a superseded candidate simply vanished and its successor appeared unrelated.
//
// That matters because identity is now load-bearing. Measured 2026-08-12, only
// 7 of 30 pending orders carrying a candidate_id matched a watchlist row — 23
// had forked. #322 stops new forks; this makes deliberate replacements
// distinguishable from accidental ones.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

const migration = await Deno.readTextFile(
  new URL("../../migrations/20260812060000_add_lifecycle_handoff.sql", import.meta.url),
);

function supersedeBlock(): string {
  const start = scanner.indexOf("Replace stale pending");
  const end = scanner.indexOf("GUARD: reject pending orders whose SL/TP orientation", start);
  assert(start > 0 && end > start, "supersede block not found");
  return scanner.slice(start, end);
}

Deno.test("migration adds both the link and the reason", () => {
  assert(migration.includes("superseded_candidate_id"), "the predecessor link");
  assert(
    migration.includes("handoff_reason"),
    "a link without a reason cannot distinguish 'entry moved' from 'score changed' " +
      "when reviewing why a chain forked",
  );
});

Deno.test("migration indexes the link so a chain can be walked", () => {
  assert(
    /CREATE INDEX[\s\S]{0,200}superseded_candidate_id/.test(migration),
    "finding every successor of a candidate is the whole point of recording it",
  );
});

Deno.test("the predecessor is captured only on the material-change path", () => {
  const block = supersedeBlock();
  const decide = block.indexOf("shouldSupersedePendingOrder(");
  const capture = block.indexOf("supersededCandidateId = existing.candidate_id");
  assert(decide > 0 && capture > 0, "both anchors must exist");
  assert(
    decide < capture,
    "capture must follow the decision — recording a handoff for an UNCHANGED setup " +
      "would invent lifecycle churn that #318 specifically stopped",
  );
});

Deno.test("an unchanged setup writes no handoff", () => {
  const block = supersedeBlock();
  const keepIdx = block.indexOf("supersedeDecision.supersede");
  const keepBranch = block.slice(keepIdx, block.indexOf("continue;", keepIdx));
  assert(
    !keepBranch.includes("supersededCandidateId ="),
    "the keep-alive branch must not record a handoff; the identity simply continues",
  );
});

Deno.test("a handoff mints a NEW identity rather than inheriting", () => {
  // Inheriting here would give the successor the same candidate_id as the
  // candidate it replaced, making superseded_candidate_id self-referential and
  // the chain meaningless.
  assert(
    /supersededCandidateId\s*\n?\s*\?\s*\{\s*candidateId: crypto\.randomUUID\(\)/.test(scanner),
    "material change must produce a new lifecycle identity, not reuse the predecessor's",
  );
});

Deno.test("the watchlist row moves onto the new identity", () => {
  // Leaving staged_setups pointing at the superseded candidate would fork
  // staged from pending — the exact break #322 exists to prevent, reintroduced
  // through the handoff path.
  const handoff = scanner.slice(scanner.indexOf("if (supersededCandidateId) {"));
  const body = handoff.slice(0, 1200);
  assert(
    body.includes('from("staged_setups")') && body.includes("candidate_id: pendingCandidateId"),
    "the watchlist row must follow the handoff, or staged and pending diverge",
  );
});

Deno.test("both columns are persisted on the insert", () => {
  assert(
    scanner.includes("superseded_candidate_id: supersededCandidateId"),
    "capturing the predecessor in a variable is useless if it is never written",
  );
  assert(scanner.includes("handoff_reason: handoffReason"));
});

Deno.test("handoff variables default to null, so a normal order records no chain", () => {
  assert(
    /let supersededCandidateId: string \| null = null;/.test(scanner),
    "the first candidate in a chain has no predecessor and must record none",
  );
  assert(/let handoffReason: string \| null = null;/.test(scanner));
});
