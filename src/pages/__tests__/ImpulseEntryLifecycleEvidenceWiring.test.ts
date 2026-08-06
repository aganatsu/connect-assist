import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rejectedSetups = readFileSync(
  "src/pages/RejectedSetups.tsx",
  "utf8",
);
const scanTab = readFileSync("src/components/config/ScanTab.tsx", "utf8");

describe("impulse entry lifecycle evidence", () => {
  it("renders transition evidence in Rejected Setups Shadow Evidence", () => {
    expect(rejectedSetups).toContain("ImpulseEntryLifecycleEvidenceCard");
    expect(rejectedSetups).toContain('from("impulse_entry_lifecycles")');
    expect(rejectedSetups).toContain(
      'from("impulse_entry_lifecycle_transitions")',
    );
    expect(rejectedSetups).toContain("Deeper advances");
    expect(rejectedSetups).toContain("Impulse invalidations");
  });

  it("unlocks Enforce only after a reviewed eligible certificate", () => {
    expect(scanTab).toContain('<SelectItem value="enforce" disabled={!lifecycleEnforceUnlocked}>');
    expect(scanTab).toContain("Enforce (locked until evidence review)");
    expect(rejectedSetups).toContain("Review & Unlock Enforce");
    expect(rejectedSetups).toContain("review_impulse_lifecycle_certificate");
  });
});
