import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Step 1 of docs/FROZEN_DECISION_RECORD.md.
 *
 * pending_orders, paper_positions and staged_setups each carry
 *
 *   CHECK (frozen_strategy_context IS NULL
 *          OR frozen_strategy_hash = md5(frozen_strategy_context::text))
 *
 * and the hash must be md5 of POSTGRES's normalised rendering of the jsonb —
 * its own key ordering and whitespace. A hash computed in TypeScript over the
 * JSON that was sent will not match, and the insert is rejected. Every caller
 * would have to know that, and the fourth one added would not.
 *
 * So a BEFORE trigger computes it. These tests pin the properties that make
 * that safe, because the failure mode if it regresses is an insert that is
 * rejected at runtime with a constraint error rather than at build time.
 */

const mig = await Deno.readTextFile(
  new URL("../../migrations/20260915120000_frozen_decision_hash_trigger.sql", import.meta.url),
);
const base = await Deno.readTextFile(
  new URL("../../migrations/20260914000000_baseline_schema.sql", import.meta.url),
);

const TABLES = ["pending_orders", "paper_positions", "staged_setups"];

/** Executable SQL only. The comments discuss sha256 and the hash trap
 *  deliberately, so matching raw text fails on the file's own explanation. */
const sql = mig.split("\n").filter(l => !l.trim().startsWith("--")).join("\n");

Deno.test("every table carrying the constraint gets the trigger", () => {
  // A table with the CHECK but no trigger is the worst outcome: it only fails
  // when something finally writes a context to it, months later.
  for (const t of TABLES) {
    assert(
      new RegExp(`CHECK[^;]*frozen_strategy_hash`).test(base),
      "the constraint still exists in the baseline",
    );
    assert(
      new RegExp(`ON public\\.${t}\\b`).test(mig),
      `${t} must get a trigger`,
    );
  }
  assertEquals((mig.match(/CREATE TRIGGER/g) ?? []).length, TABLES.length);
});

Deno.test("the hash is md5, matching the constraint", () => {
  // strategy_activation_json_hash() also exists and uses sha256. Using it here
  // would satisfy nothing and fail every insert.
  assert(/md5\(NEW\.frozen_strategy_context::text\)/.test(sql), "md5 of the stored jsonb text");
  assert(!/sha256|digest\(/.test(sql), "must not reach for the sha256 hasher");
  assert(!/strategy_activation_json_hash\(/.test(sql));
});

Deno.test("a NULL context produces a NULL hash, not a hash of empty", () => {
  // Hashing '{}' would make "no decision was frozen" indistinguishable from
  // "an empty decision was frozen" — and every pre-existing row would look
  // like the latter.
  assert(/IF NEW\.frozen_strategy_context IS NULL THEN\s*\n\s*NEW\.frozen_strategy_hash := NULL;/
    .test(mig), "null in, null out");
});

Deno.test("it fires on UPDATE of the context, not only INSERT", () => {
  // If the context is ever amended without the hash following, the row
  // silently stops satisfying its own constraint — and because the CHECK is
  // NOT VALID, nothing re-tests it.
  assertEquals(
    (mig.match(/BEFORE INSERT OR UPDATE OF frozen_strategy_context/g) ?? []).length,
    TABLES.length,
    "all three fire on both",
  );
});

Deno.test("it is re-runnable", () => {
  // Supabase applies migrations once, but this one will be read and re-applied
  // by hand during development.
  assert(/CREATE OR REPLACE FUNCTION/.test(mig));
  assertEquals((mig.match(/DROP TRIGGER IF EXISTS/g) ?? []).length, TABLES.length);
});

Deno.test("nothing writes a context yet, so this changes no behaviour", () => {
  // Step 1 is deliberately inert. If a writer appears before the trigger
  // migration has been applied, inserts start failing the CHECK.
  const fns = ["bot-scanner", "paper-trading", "zone-confirmation-scanner"];
  for (const f of fns) {
    const src = Deno.readTextFileSync(
      new URL(`../../functions/${f}/index.ts`, import.meta.url),
    );
    assert(!/frozen_strategy_context:/.test(src),
      `${f} must not write a context until step 2`);
  }
});

Deno.test("the cross-timeframe subtree is deliberately left alone", () => {
  // All 34 generated columns read frozen_strategy_context -> crossTimeframeContext,
  // which belongs to a feature that is not running. Populating it to make those
  // columns show values would recreate the exact failure this work exists to
  // fix: a field that reads as meaningful and is not.
  assert(!/crossTimeframeContext/.test(sql), "the trigger must not invent that subtree");
  // And the guard that makes leaving it absent safe.
  assert(/\(frozen_strategy_context #> '\{crossTimeframeContext\}'::text\[\]\) IS NULL/.test(base),
    "the contract CHECK is guarded on IS NULL, so an absent subtree passes");
});
