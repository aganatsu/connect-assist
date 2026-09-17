import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * iOS viewport and touch-target contract.
 *
 * 100vh on iOS Safari is the TOOLBAR-COLLAPSED height. With the toolbar
 * visible, the bottom of a 100vh layout sits behind it — and the mobile shell
 * is overflow-hidden with MobileNav fixed to bottom-0, so that strip cannot be
 * scrolled to. The navigation ends up behind the browser chrome.
 *
 * The fix has to keep a vh fallback: browsers without dvh (iOS < 15.4) ignore
 * a lone `height: 100dvh` entirely and collapse to height:auto, which is worse
 * than the bug. Two declarations, vh first.
 */

const css = readFileSync("src/index.css", "utf8");

const componentFiles = ["src/components", "src/pages"].flatMap((dir) =>
  readdirSync(dir).filter((f) => f.endsWith(".tsx")).map((f) => join(dir, f)),
);

describe("viewport height", () => {
  it("every vh utility declares vh before dvh", () => {
    // Order matters: the fallback must come first or it overrides the fix.
    for (const cls of ["h-app", "min-h-app", "h-page", "min-h-page-tall"]) {
      const m = css.match(new RegExp(`\\.${cls}\\s*\\{[^}]*\\}`, "g"));
      expect(m, `${cls} is defined`).toBeTruthy();
      const block = m!.join(" ");
      const vh = block.indexOf("100vh");
      const dvh = block.indexOf("100dvh");
      expect(vh, `${cls} has a vh fallback`).toBeGreaterThan(-1);
      expect(dvh, `${cls} has dvh`).toBeGreaterThan(-1);
      expect(vh, `${cls}: vh must precede dvh`).toBeLessThan(dvh);
    }
  });

  it("no component sets a raw viewport height", () => {
    // A single h-screen reintroduces the bug on that screen only, which is the
    // hardest version to notice.
    const offenders: string[] = [];
    for (const f of componentFiles) {
      if (f.includes("/ui/")) continue;            // shadcn primitives use svh
      const src = readFileSync(f, "utf8");
      if (/\bh-screen\b|\bmin-h-screen\b|calc\(100vh/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

describe("touch targets", () => {
  it("the floor is at least Apple's 44px", () => {
    const mobile = css.slice(css.indexOf("@media (max-width: 767px)"));
    const m = mobile.match(/min-height:\s*(\d+)px/);
    expect(m, "a tap-target floor exists").toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(44);
  });

  it("inputs stay at 16px so iOS does not zoom on focus", () => {
    // Below 16px, Safari zooms the whole page when a field takes focus and
    // does not zoom back out. Easy to lose in a typography pass.
    const mobile = css.slice(css.indexOf("@media (max-width: 767px)"));
    expect(mobile).toMatch(/input,\s*select,\s*textarea\s*\{\s*font-size:\s*16px/);
  });
});

describe("safe areas", () => {
  it("viewport-fit=cover is paired with inset padding", () => {
    // cover lets content into the notch and home-indicator area. Without the
    // insets applied, the bottom nav sits under the home indicator.
    const html = readFileSync("index.html", "utf8");
    expect(html).toContain("viewport-fit=cover");
    expect(css).toContain("env(safe-area-inset-bottom");
    const nav = readFileSync("src/components/MobileNav.tsx", "utf8");
    const bar = readFileSync("src/components/MobileTopBar.tsx", "utf8");
    expect(nav).toContain("safe-area-bottom");
    expect(bar).toContain("safe-area-top");
  });
});
