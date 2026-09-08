import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The broker SL/TP editor seeded its inputs once, on click:
 *
 *   setEditingId(pos.id);
 *   setEditSL(pos.stopLoss?.toString() || "");
 *
 * and sent them unconditionally on save:
 *
 *   if (editSL) updates.stopLoss = parseFloat(editSL);
 *   if (editTP) updates.takeProfit = parseFloat(editTP);
 *
 * `positions` refreshes underneath an open editor. So if the bot trailed the
 * stop while the panel was open, Save wrote the pre-trail value back to the
 * broker — silently giving up locked-in protection on a live position.
 *
 * And because editSL is always non-empty once seeded, a TAKE-PROFIT-ONLY edit
 * still rewrote the stop. The user need not have touched it.
 *
 * Fix: send only fields the user actually changed, and when a field they are
 * changing has also moved underneath them, say so before overwriting.
 */

const tab = await Deno.readTextFile(
  new URL("../../../src/components/BrokerTradesTab.tsx", import.meta.url),
);

/** Mirrors the save handler's decision. */
function updatesFor(
  seed: { sl: string; tp: string },
  edited: { sl: string; tp: string },
) {
  const u: Record<string, number> = {};
  if (edited.sl !== seed.sl) u.stopLoss = parseFloat(edited.sl);
  if (edited.tp !== seed.tp) u.takeProfit = parseFloat(edited.tp);
  return u;
}

Deno.test("a take-profit-only edit does not touch the stop", () => {
  // The exact scenario that loses money: user widens the target, bot has
  // trailed the stop, old behaviour sent both.
  const u = updatesFor({ sl: "1.2000", tp: "1.2100" }, { sl: "1.2000", tp: "1.2150" });
  assertEquals(Object.keys(u), ["takeProfit"]);
  assertEquals(u.takeProfit, 1.2150);
  assert(!("stopLoss" in u), "the stop must not be sent when it was not edited");
});

Deno.test("a stop-only edit does not touch the target", () => {
  const u = updatesFor({ sl: "1.2000", tp: "1.2100" }, { sl: "1.2020", tp: "1.2100" });
  assertEquals(Object.keys(u), ["stopLoss"]);
});

Deno.test("editing neither sends nothing", () => {
  assertEquals(updatesFor({ sl: "1.2000", tp: "1.2100" }, { sl: "1.2000", tp: "1.2100" }), {});
  assert(/toast\.info\("Nothing changed"\)/.test(tab), "and says so rather than firing a no-op write");
});

Deno.test("clearing a field is an edit, not an absence", () => {
  // "" !== "1.2000", so clearing the stop is a deliberate change. The old code
  // used `if (editSL)`, which treated an empty string as 'leave alone' — so a
  // user could not remove a stop at all.
  const u = updatesFor({ sl: "1.2000", tp: "" }, { sl: "", tp: "" });
  assert("stopLoss" in u, "clearing must be sent");
  assert(Number.isNaN(u.stopLoss), "as NaN — the API layer decides what that means");
  assert(
    !/if \(editSL\) updates\.stopLoss/.test(tab),
    "the truthiness check that swallowed clears must be gone",
  );
});

Deno.test("drift on a field the user is changing is confirmed, not silent", () => {
  assert(/const slEdited = editSL !== seedSL;/.test(tab));
  assert(/liveSL !== seedSL/.test(tab), "must compare live against the seed, not against the input");
  assert(/window\.confirm\(/.test(tab), "and require confirmation before overwriting");
  assert(/Overwrite with your values\?/.test(tab));
});

Deno.test("drift on a field the user is NOT changing is left alone", () => {
  // The whole point: the bot trailed the stop, the user edited only the target,
  // so the stop is simply not in the payload and the trail survives untouched.
  const u = updatesFor({ sl: "1.2000", tp: "1.2100" }, { sl: "1.2000", tp: "1.2200" });
  assert(!("stopLoss" in u));
});

Deno.test("the seed is captured at open, from the same values shown", () => {
  const i = tab.indexOf("const sl0 = pos.stopLoss?.toString()");
  assert(i > -1, "the seed must be taken from the position at click time");
  const block = tab.slice(i, i + 400);
  for (const c of ["setEditSL(sl0)", "setSeedSL(sl0)", "setEditTP(tp0)", "setSeedTP(tp0)"]) {
    assert(block.includes(c), `${c} missing — input and seed must start equal`);
  }
});

Deno.test("drift is visible before Save, not only at it", () => {
  // A confirm dialog at save time is a last line of defence; the field should
  // already be showing that the ground moved.
  assert(/border-warn text-warn/.test(tab), "the input must highlight when it drifts");
  assert(/The bot moved this stop to/.test(tab), "with a tooltip saying what happened");
});
