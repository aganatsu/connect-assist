import { describe, expect, it } from "vitest";
import { collectLatestScanDetails } from "./scanLogHistory";

describe("collectLatestScanDetails", () => {
  it("keeps the newest detail for every pair across rotating scans", () => {
    const result = collectLatestScanDetails([
      {
        scanned_at: "2026-08-23T15:20:00.000Z",
        details_json: [
          { __meta: true, session: "newest" },
          { pair: "EUR/USD", score: 42 },
        ],
      },
      {
        scanned_at: "2026-08-23T15:15:00.000Z",
        details_json: JSON.stringify([
          { __meta: true, session: "older" },
          { pair: "NZD/CAD", score: 25 },
          { pair: "EUR/USD", score: 12 },
        ]),
      },
    ]);

    expect(result.meta).toEqual({ __meta: true, session: "newest" });
    expect(result.details).toEqual([
      {
        pair: "EUR/USD",
        score: 42,
        scanObservedAt: "2026-08-23T15:20:00.000Z",
        inLatestScan: true,
      },
      {
        pair: "NZD/CAD",
        score: 25,
        scanObservedAt: "2026-08-23T15:15:00.000Z",
        inLatestScan: false,
      },
    ]);
  });

  it("retains a skipped pair record and ignores malformed rows", () => {
    const result = collectLatestScanDetails([
      {
        scanned_at: "2026-08-23T15:20:00.000Z",
        details_json: [
          { pair: "GBP/JPY", status: "skipped", reason: "Insufficient data" },
          { status: "skipped", reason: "Missing pair" },
          null,
        ],
      },
      { scanned_at: "2026-08-23T15:15:00.000Z", details_json: "not-json" },
    ]);

    expect(result.details).toEqual([
      {
        pair: "GBP/JPY",
        status: "skipped",
        reason: "Insufficient data",
        scanObservedAt: "2026-08-23T15:20:00.000Z",
        inLatestScan: true,
      },
    ]);
  });
});
