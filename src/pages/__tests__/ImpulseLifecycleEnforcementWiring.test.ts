import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scanner = readFileSync("supabase/functions/bot-scanner/index.ts", "utf8");
const confirmation = readFileSync("supabase/functions/zone-confirmation-scanner/index.ts", "utf8");
const replay = readFileSync("supabase/functions/impulse-lifecycle-replay/index.ts", "utf8");
const migration = readFileSync(
  "supabase/migrations/20260826210000_align_impulse_lifecycle_saved_mode.sql",
  "utf8",
);
const evidenceMigration = readFileSync(
  "supabase/migrations/20260806120000_add_impulse_lifecycle_enforcement.sql",
  "utf8",
);

describe("impulse lifecycle enforcement wiring", () => {
  it("resolves saved mode at discovery and retains the frozen mode at fill", () => {
    expect(scanner).toContain("resolveImpulseLifecycleEnforcement");
    expect(confirmation).toContain("const pendingLifecycleMode = lifecycleAfterLock?.mode");
    expect(confirmation).not.toContain("resolveImpulseLifecycleEnforcement");
    expect(confirmation).toContain("frozen confirmation contract not satisfied");
  });

  it("retargets atomically from the frozen setup mode while retaining final fill authorization", () => {
    expect(confirmation).toContain("retarget_pending_to_impulse_candidate");
    expect(confirmation).toContain("evaluateFinalTradeAuthorization");
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("'authorizedBy', 'frozen_setup_config'");
    expect(migration).not.toContain("certificate_unavailable");
  });

  it("publishes a fresh reviewable certificate from replay evidence", () => {
    expect(replay).toContain("publishEnforcementCertificate");
    expect(replay).toContain('crypto.subtle.digest("SHA-256"');
    expect(evidenceMigration).toContain("review_impulse_lifecycle_certificate");
  });
});
