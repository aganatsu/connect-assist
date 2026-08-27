import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scanner = readFileSync("supabase/functions/bot-scanner/index.ts", "utf8");
const botView = readFileSync("src/pages/BotView.tsx", "utf8");

describe("watchlist persistence status", () => {
  it("only reports WATCHING after a successful staged setup write", () => {
    expect(scanner).toContain("if (zoneWatchInsertError) throw zoneWatchInsertError");
    expect(scanner).toContain("if (zoneWatchUpdateError) throw zoneWatchUpdateError");
    expect(scanner).toContain("if (zoneWatchPersisted)");
    expect(scanner).toContain("zoneWatchPersisted = true");
  });

  it("shows write failures and disabled staging as distinct states", () => {
    expect(scanner).toContain('detail.status = "watchlist_persistence_failed"');
    expect(scanner).toContain('detail.status = "waiting_zone_untracked"');
    expect(botView).toContain("WATCHLIST ERROR");
    expect(botView).toContain("ZONE AWAY");
  });

  it("does not label an impulse candidate without a zone as no impulse", () => {
    expect(botView).toContain('skipped_no_impulse_zone: { label: "No valid entry zone"');
    expect(botView).not.toContain('skipped_no_impulse_zone: { label: "No impulse zone"');
  });
});
