// A pre-armed setup must not report itself as merely "watching".
//
// Observed 2026-08-13: the scan card showed USD/CHF as WATCHING while the
// Watchlist tab was empty. Neither was lying.
//
//   scan detail   status "watching_zone"  — set after the pre-arm, never updated
//   Watchlist tab empty                   — api.ts:753 queries only
//                                           ["watching","qualified"], and the
//                                           staged row moves to 'pending' the
//                                           moment it is armed (measured at
//                                           43-80ms after creation)
//   Zone Setups   holds the real row      — queries pending_orders
//
// Three surfaces, three different truths. The engine was correct throughout;
// the label was the only thing wrong, and it pointed the user at the one tab
// that structurally cannot show an armed setup.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

function preArmBlock(): string {
  const start = scanner.indexOf("const preparePreArmLifecycle");
  const end = scanner.indexOf("scanDetails.push(detail);", start);
  assert(start > 0 && end > start, "pre-arm block not found");
  return scanner.slice(start, end);
}

Deno.test("a successful pre-arm is recorded, not just a failed one", () => {
  const block = preArmBlock();
  assert(
    block.includes("preArmedThisScan = true"),
    "the insert previously recorded only its error path, so success was " +
      "indistinguishable from never having tried",
  );
});

Deno.test("an armed setup reports zone_setup_active, not watching_zone", () => {
  const block = preArmBlock();
  assert(
    /detail\.status = preArmedThisScan \? "zone_setup_active" : "watching_zone"/.test(block),
    "reporting watching_zone for an armed setup sends the user to a tab that " +
      "queries watching/qualified and can never contain it",
  );
});

Deno.test("the skip reason tells the user which tab to look in", () => {
  const block = preArmBlock();
  assert(
    /Pre-armed[\s\S]{0,160}Zone Setups/.test(block),
    "the reason text must name the surface that actually holds the row — the " +
      "failure here was navigational, not computational",
  );
});

Deno.test("an unarmed watch still reports watching_zone", () => {
  // Pre-arming is config-gated. With it off, or when no plan could be built,
  // the setup genuinely is only watched and the old label is correct.
  const block = preArmBlock();
  assert(block.includes('"watching_zone"'), "the unarmed path must be unchanged");
});

Deno.test("a duplicate-key pre-arm counts as armed", () => {
  // A duplicate means the order already exists for this candidate — it IS
  // armed, just not by this scan. Treating that as unarmed would flip the
  // status back to watching on every subsequent cycle.
  const block = preArmBlock();
  const guard = block.slice(block.indexOf("preArmError &&"));
  assert(
    /duplicate key/i.test(guard.slice(0, 200)),
    "duplicate must stay outside the error branch so it falls through to armed",
  );
});
