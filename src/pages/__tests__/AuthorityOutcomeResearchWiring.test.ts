import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("authority outcome research wiring", () => {
  it("makes authority evidence primary and labels confluence diagnostic only", () => {
    const page = fs.readFileSync(path.resolve("src/pages/RejectedSetups.tsx"), "utf8");
    const card = fs.readFileSync(path.resolve("src/components/AuthorityOutcomeResearchCard.tsx"), "utf8");
    expect(page).toContain("getAuthorityOutcomeComparison");
    expect(page).toContain("Legacy Confluence Score vs Outcome");
    expect(page).toContain("Diagnostic only");
    expect(page).toContain("<details");
    expect(card).toContain("ICT Decision Evidence vs Outcome");
    expect(card).toContain("Compatible history");
    expect(card).toContain("Expectancy");
    expect(card).toContain("Dataset");
  });
});
