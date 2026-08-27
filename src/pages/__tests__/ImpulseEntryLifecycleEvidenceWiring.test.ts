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

  it("keeps evidence review advisory while allowing deliberate enforcement", () => {
    expect(scanTab).toContain('<SelectItem value="enforce">Enforce</SelectItem>');
    expect(scanTab).not.toContain("lifecycleEnforceUnlocked");
    expect(rejectedSetups).toContain("Review Evidence");
    expect(rejectedSetups).toContain("Runtime enforcement is selected separately in Bot Config");
    expect(rejectedSetups).not.toContain("ENFORCE LOCKED");
    expect(rejectedSetups).toContain("review_impulse_lifecycle_certificate");
  });
});
