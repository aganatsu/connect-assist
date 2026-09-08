import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The mobile open-positions card rendered SL and TP as read-only text and
 * offered no controls at all — no edit, no close. On a phone a trader could
 * watch a position move against them with no way to move the stop or get out.
 * The desktop table had both.
 *
 * The save path carries the drift protection added when the editor was found
 * writing a stale stop back to the broker. Copying that logic into a second
 * layout is how it would rot on one of them, so beginEdit and saveEdits are
 * extracted and both layouts call the same functions.
 */

const tab = await Deno.readTextFile(
  new URL("../../../src/components/BrokerTradesTab.tsx", import.meta.url),
);

const mobileBlock = (() => {
  const i = tab.indexOf('<div className="md:hidden space-y-1.5 p-2">');
  const j = tab.indexOf("{/* Desktop: Table */}", i);
  assert(i > -1 && j > i, "the mobile open-positions block was not found");
  return tab.slice(i, j);
})();

Deno.test("the mobile card can edit SL and TP", () => {
  assert(/setEditSL\(e\.target\.value\)/.test(mobileBlock), "no stop input");
  assert(/setEditTP\(e\.target\.value\)/.test(mobileBlock), "no target input");
  assert(/Edit SL\/TP/.test(mobileBlock), "no way to enter edit mode");
});

Deno.test("the mobile card can close a position", () => {
  assert(/closeMut\.mutate\(pos\.id\)/.test(mobileBlock), "no close action");
  assert(/window\.confirm\(/.test(mobileBlock), "closing must be confirmed");
});

Deno.test("both layouts share one save implementation", () => {
  // Two copies of the stale-write protection is one copy too many.
  assertEquals((tab.match(/saveEdits\(pos\)/g) ?? []).length, 2, "desktop and mobile both call it");
  assertEquals((tab.match(/const saveEdits = useCallback/g) ?? []).length, 1, "defined once");
  assertEquals((tab.match(/beginEdit\(pos\)/g) ?? []).length, 2);
  assertEquals((tab.match(/const beginEdit = useCallback/g) ?? []).length, 1);
});

Deno.test("the drift protection is not duplicated inline anywhere", () => {
  // If a layout ever re-inlines it, this catches the second copy.
  assertEquals((tab.match(/Overwrite with your values\?/g) ?? []).length, 1);
  assertEquals((tab.match(/const slEdited = editSL !== seedSL;/g) ?? []).length, 1);
});

Deno.test("mobile shows drift too, not just desktop", () => {
  // The phone is where a trailing stop is most likely to move unnoticed.
  assert(/border-warn text-warn/.test(mobileBlock), "the input must highlight on drift");
  assert(/Bot moved the stop to/.test(mobileBlock), "and explain it in words, not just colour");
});

Deno.test("inputs are numeric-friendly on a phone keyboard", () => {
  const inputs = mobileBlock.match(/<input[\s\S]*?\/>/g) ?? [];
  assertEquals(inputs.length, 2, "expected exactly the SL and TP inputs");
  for (const inp of inputs) {
    assert(/inputMode="decimal"/.test(inp), "must open a numeric keypad");
    assert(/step="any"/.test(inp), "must not round to whole numbers");
  }
});

Deno.test("touch targets are not the desktop's 10px controls", () => {
  // The desktop uses p-0.5 icon buttons; those are unusable on a phone.
  const buttons = mobileBlock.match(/className="[^"]*rounded py-2[^"]*"/g) ?? [];
  assert(buttons.length >= 4, "edit, close, save and cancel should all be full-height taps");
});

Deno.test("closed trades stay read-only", () => {
  // The second mobile block is trade history; it has nothing to act on.
  const j = tab.indexOf('<div className="md:hidden space-y-1.5 p-2">',
    tab.indexOf("{/* Desktop: Table */}"));
  const historyBlock = tab.slice(j, tab.indexOf("{/* Desktop: Table */}", j));
  assert(!/closeMut|saveEdits|beginEdit/.test(historyBlock),
    "history must not gain trade controls");
});
