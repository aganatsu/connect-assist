import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Toggling a per-trade override flicked back to its old value within a second.
 *
 * The resync effect depended on `position` — an object:
 *
 *   useEffect(() => { ...reset every toggle from the server... }, [position]);
 *
 * react-query polls paper_positions, so `position` is a NEW OBJECT on every
 * refetch even when nothing about it changed. The effect therefore re-ran on
 * every poll and overwrote whatever the user had just set.
 *
 * Depending on the position's identity plus its PERSISTED overrides keeps the
 * useful behaviour — resync when the row genuinely changes — without the
 * effect firing on reference churn.
 */

const editor = await Deno.readTextFile(
  new URL("../../../src/components/TradeOverrideEditor.tsx", import.meta.url),
);

Deno.test("the resync effect no longer depends on the object reference", () => {
  assert(!/\}, \[position\]\);/.test(editor), "[position] re-runs on every poll");
  assert(
    /\}, \[position\?\.position_id, overridesKey\]\);/.test(editor),
    "must depend on identity and persisted overrides",
  );
});

Deno.test("the override key compares by value, not by reference", () => {
  // trade_overrides arrives as a string from some paths and jsonb from others.
  // A raw object dependency would churn exactly like `position` did.
  assert(/typeof position\?\.trade_overrides === "string"/.test(editor));
  assert(/JSON\.stringify\(position\?\.trade_overrides \?\? null\)/.test(editor));
});

Deno.test("identical polls produce an identical key", () => {
  // The property that makes the fix work.
  const key = (o: unknown) => typeof o === "string" ? o : JSON.stringify(o ?? null);
  assertEquals(key('{"breakEvenEnabled":true}'), key('{"breakEvenEnabled":true}'));
  assertEquals(key({ breakEvenEnabled: true }), key({ breakEvenEnabled: true }));
  assertEquals(key(null), key(undefined));
  // And a genuine change still produces a different key, so resync still works.
  assert(key({ breakEvenEnabled: true }) !== key({ breakEvenEnabled: false }));
  assert(key(null) !== key({ breakEvenEnabled: true }));
});

Deno.test("switching to a different position still resyncs", () => {
  // The effect must not become so stable that opening another trade shows the
  // previous one's values.
  assert(/position\?\.position_id/.test(editor), "identity must be in the dependency list");
});

Deno.test("the reason is recorded where the dependency is", () => {
  // A bare dependency array invites someone to "fix the lint warning" by
  // putting `position` back.
  assert(/fresh object on every\s*\n\s*\/\/ refetch/.test(editor));
  assert(/eslint-disable-next-line react-hooks\/exhaustive-deps/.test(editor),
    "the suppression should be explicit rather than the rule being silently wrong");
});
