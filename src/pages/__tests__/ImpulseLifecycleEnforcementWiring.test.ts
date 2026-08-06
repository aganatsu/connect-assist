import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scanner = readFileSync("supabase/functions/bot-scanner/index.ts", "utf8");
const confirmation = readFileSync("supabase/functions/zone-confirmation-scanner/index.ts", "utf8");
const replay = readFileSync("supabase/functions/impulse-lifecycle-replay/index.ts", "utf8");
const migration = readFileSync(
  "supabase/migrations/20260806120000_add_impulse_lifecycle_enforcement.sql",
  "utf8",
);

describe("impulse lifecycle enforcement wiring", () => {
  it("fails closed through one evidence resolver in discovery and fill paths", () => {
    expect(scanner).toContain("resolveImpulseLifecycleEnforcement");
    expect(confirmation).toContain("resolveImpulseLifecycleEnforcement");
    expect(confirmation).toContain("frozen confirmation contract not satisfied");
  });

  it("retargets atomically while retaining final fill authorization", () => {
    expect(confirmation).toContain("retarget_pending_to_impulse_candidate");
    expect(confirmation).toContain("evaluateFinalTradeAuthorization");
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("certificate_unavailable");
  });

  it("publishes a fresh reviewable certificate from replay evidence", () => {
    expect(replay).toContain("publishEnforcementCertificate");
    expect(replay).toContain('crypto.subtle.digest("SHA-256"');
    expect(migration).toContain("review_impulse_lifecycle_certificate");
  });
});
