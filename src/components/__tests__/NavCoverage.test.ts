import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The app renders IconRail, not AppSidebar (see AppShell.tsx). Both files list
 * navigation items, so a route added to the wrong one is invisible with no
 * error — which is exactly what happened when Manual Impulse shipped.
 *
 * This asserts every route reachable from App.tsx is present in the nav that is
 * actually rendered.
 */
const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

// Routes intentionally reached from elsewhere rather than the rail: the
// dashboard is the logo/home target, and auth pages are pre-login.
const NOT_IN_NAV = new Set([
  "/", "*", "/login", "/auth", "/auth/callback", "/signup", "/reset-password",
]);

describe("navigation coverage", () => {
  it("AppShell renders IconRail, so IconRail is the nav that matters", () => {
    expect(read("components/AppShell.tsx")).toContain("<IconRail");
  });

  it("every app route appears in the rendered nav", () => {
    const app = read("App.tsx");
    const rail = read("components/IconRail.tsx");
    const routes = [...app.matchAll(/<Route path="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((r) => !NOT_IN_NAV.has(r));
    const missing = routes.filter((r) => !rail.includes(`url: "${r}"`));
    expect(
      missing,
      `Routes missing from IconRail (users cannot reach these): ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
