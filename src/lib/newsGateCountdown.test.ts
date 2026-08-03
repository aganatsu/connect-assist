import { describe, expect, it } from "vitest";
import { formatNewsGateCountdown } from "./newsGateCountdown";

describe("formatNewsGateCountdown", () => {
  it("counts down to a scheduled news event", () => {
    const reason =
      "News filter: high-impact event within 240min (scheduled 2026-08-03T16:00:00.000Z) — ISM Manufacturing PMI";
    expect(formatNewsGateCountdown(
      reason,
      new Date("2026-08-03T14:30:00.000Z").getTime(),
    )).toBe(
      "News filter: high-impact event in 90min — ISM Manufacturing PMI",
    );
  });

  it("shows elapsed time after the release", () => {
    const reason =
      "News filter: high-impact event within 240min (scheduled 2026-08-03T16:00:00.000Z) — ISM Manufacturing PMI";
    expect(formatNewsGateCountdown(
      reason,
      new Date("2026-08-03T16:12:00.000Z").getTime(),
    )).toBe(
      "News filter: high-impact event 12min since release — ISM Manufacturing PMI",
    );
  });

  it("provides an approximate countdown for legacy scan records", () => {
    const reason =
      "News filter: high-impact event within 240min — ISM Manufacturing PMI";
    expect(formatNewsGateCountdown(
      reason,
      new Date("2026-08-03T15:00:00.000Z").getTime(),
      "2026-08-03T14:00:00.000Z",
    )).toBe(
      "News filter: high-impact event approximately 180min remaining — ISM Manufacturing PMI",
    );
  });
});
