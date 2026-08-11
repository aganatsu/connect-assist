import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Layout is per-page: each route component wraps itself in <AppShell>, which
 * supplies the icon rail, search and status bar. A page that forgets it renders
 * fine and traps the user — there is no nav to leave by. Manual Impulse shipped
 * that way.
 */
const pagesDir = resolve(__dirname, "..");

// Pages that intentionally render without the shell (pre-login, 404).
const NO_SHELL = new Set(["Login.tsx", "Signup.tsx", "ResetPassword.tsx", "NotFound.tsx"]);

describe("page layout", () => {
  it("every routed page wraps itself in AppShell", () => {
    const app = readFileSync(resolve(pagesDir, "../App.tsx"), "utf8");
    // Only check pages actually imported as routes.
    const routed = [...app.matchAll(/from "\.\/pages\/([A-Za-z0-9_]+)"/g)].map(
      (m) => `${m[1]}.tsx`,
    );
    const present = new Set(readdirSync(pagesDir));
    const missing = routed
      .filter((f) => present.has(f) && !NO_SHELL.has(f))
      .filter((f) => !readFileSync(resolve(pagesDir, f), "utf8").includes("<AppShell>"));
    expect(
      missing,
      `Pages without AppShell (no nav — user is trapped): ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
