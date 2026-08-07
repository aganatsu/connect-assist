import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("structure authority evidence wiring", () => {
  it("renders stored structure decisions without browser recalculation", () => {
    const page = fs.readFileSync(path.resolve("src/pages/RejectedSetups.tsx"), "utf8");
    const card = fs.readFileSync(path.resolve("src/components/StructureAuthorityEvidenceCard.tsx"), "utf8");
    expect(page).toContain("<StructureAuthorityEvidenceCard setups={setups}");
    expect(card).toContain("canonicalStructureDecision");
    expect(card).toContain("canonicalStructureAuthority");
    expect(card).toContain("Market Structure Authority Evidence");
    expect(card).not.toContain("buildCanonicalStructureAuthority");
  });
});
