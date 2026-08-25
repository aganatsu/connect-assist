import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const pagesDir = resolve(__dirname, "..");
const NO_WORKSPACE = new Set(["Login.tsx", "Signup.tsx", "ResetPassword.tsx", "AuthCallback.tsx", "NotFound.tsx"]);

describe("workspace visual system", () => {
  it("gives every protected route the shared page frame and identity header", () => {
    const app = readFileSync(resolve(pagesDir, "../App.tsx"), "utf8");
    const routed = [...app.matchAll(/from "\.\/pages\/([A-Za-z0-9_]+)"/g)].map(
      (match) => `${match[1]}.tsx`,
    );
    const present = new Set(readdirSync(pagesDir));
    const protectedPages = routed.filter((file) => present.has(file) && !NO_WORKSPACE.has(file));

    const missingFrame = protectedPages.filter(
      (file) => !readFileSync(resolve(pagesDir, file), "utf8").includes("<WorkspacePage"),
    );
    const missingHeader = protectedPages.filter(
      (file) => !readFileSync(resolve(pagesDir, file), "utf8").includes("<WorkspaceHeader"),
    );

    expect(
      missingFrame,
      `Protected pages without WorkspacePage: ${missingFrame.join(", ")}`,
    ).toEqual([]);
    expect(
      missingHeader,
      `Protected pages without WorkspaceHeader: ${missingHeader.join(", ")}`,
    ).toEqual([]);
  });
});
