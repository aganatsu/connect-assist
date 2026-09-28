/**
 * A tab panel that sets `display` must also hide itself when inactive.
 *
 * WHAT THIS CAUGHT. The IPO panel in BotView was
 *   className="flex-1 min-h-0 mt-0 overflow-hidden p-2 flex flex-col"
 * with no inactive guard. Radix hides an inactive panel with the `hidden`
 * ATTRIBUTE, which depends on the browser's `[hidden] { display: none }` — a
 * user-agent rule. Tailwind's `.flex { display: flex }` is an author rule, so
 * it wins, and the inactive panel kept `display: flex`.
 *
 * It then sat at `flex-1` over the whole SMC view: invisible, but first in hit
 * testing. Every click and scroll aimed at the scan panel went into it instead.
 * The page looked completely normal and kept refreshing its data, which is why
 * it read as "nothing is clickable" rather than as a layout bug. Confirmed with
 * `document.elementFromPoint`, which returned that div rather than the row
 * under the cursor.
 *
 * `flex-1` alone is safe — it sets flex-grow, not display. Only a standalone
 * display utility creates the trap.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Tailwind utilities that set `display` and would defeat the hidden attribute. */
const DISPLAY_UTILS = [
  "flex", "grid", "block", "inline", "inline-flex", "inline-block", "inline-grid",
  "table", "flow-root", "contents", "list-item",
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx|jsx)$/.test(p) ? [p] : [];
  });
}

/** Every `<TabsContent …>` opening tag in the tree, with its file and line. */
function tabsContents(): Array<{ file: string; line: number; tag: string; classes: string }> {
  const out: Array<{ file: string; line: number; tag: string; classes: string }> = [];
  for (const file of walk("src")) {
    const src = readFileSync(file, "utf8");
    // Opening tag only; className may span the tag but not nest another tag.
    for (const m of src.matchAll(/<TabsContent\b[^>]*>/g)) {
      const tag = m[0];
      const cls = /className="([^"]*)"/.exec(tag)?.[1] ?? "";
      const line = src.slice(0, m.index).split("\n").length;
      out.push({ file, line, tag, classes: cls });
    }
  }
  return out;
}

describe("TabsContent inactive hiding", () => {
  it("finds the tab panels to check", () => {
    // A zero-length sweep would pass every assertion below without testing
    // anything, which is the failure mode this guards.
    expect(tabsContents().length).toBeGreaterThan(5);
  });

  it("a panel that sets display also hides when inactive", () => {
    const offenders = tabsContents().filter((t) => {
      const tokens = t.classes.split(/\s+/).filter(Boolean);
      // Bare utility only. `flex-1`, `grid-cols-2`, `inline-size-…` set other
      // properties and leave the hidden attribute working.
      const setsDisplay = tokens.some((tok) => DISPLAY_UTILS.includes(tok));
      const guarded = t.classes.includes("data-[state=inactive]:hidden");
      return setsDisplay && !guarded;
    });

    expect(
      offenders.map((o) => `${o.file}:${o.line} — ${o.classes}`),
      "these panels keep display set while inactive, so they stay laid out and " +
      "intercept clicks meant for the active tab; add data-[state=inactive]:hidden",
    ).toEqual([]);
  });

  it("the IPO panel specifically carries the guard", () => {
    // Pinned by name because this is the one that shipped broken, and the
    // regression is silent: the UI renders and updates normally.
    const ipo = tabsContents().find((t) => t.tag.includes('value="ipo"'));
    expect(ipo, "the IPO tab panel is gone or was renamed").toBeTruthy();
    expect(ipo!.classes).toContain("flex");
    expect(ipo!.classes).toContain("data-[state=inactive]:hidden");
  });

  it("flex-1 on its own is not treated as a display utility", () => {
    // Guards the test itself: an over-eager matcher here would demand the
    // attribute on a dozen panels that never needed it.
    const tokens = "flex-1 min-h-0 mt-1".split(/\s+/);
    expect(tokens.some((t) => DISPLAY_UTILS.includes(t))).toBe(false);
  });
});
