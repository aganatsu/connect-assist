import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { marketFillSection } from "./attribution.ts";

const base = { filledAt: "2026-11-11T16:35:09.224Z", fillPrice: 74254.71, stop: 75041.3848, target: 72681.3604,
  pipSize: 1, lots: 0.64, riskUsd: 501.67, riskPercent: 0.5, positionId: "abc12345" };

Deno.test("market fill section: dry run → hypothetical fill, like the Route 2 fill trigger", () => {
  const f = marketFillSection({ ...base, dryRun: true });
  assertEquals([f.terminal_status, f.fill_kind, f.terminal_reason], ["hypothetical_fill", "hypothetical", "FILLED_MARKET"]);
});

Deno.test("market fill section: live → real fill, with the risk and geometry recorded", () => {
  const f = marketFillSection({ ...base, dryRun: false });
  assertEquals([f.terminal_status, f.fill_kind], ["filled", "real"]);
  assertEquals(f.fill_stop_distance_pips, 786.7);   // the BTC short of 2026-11-11
  assertEquals([f.fill_lots, f.fill_risk_usd, f.position_id], [0.64, 501.67, "abc12345"]);
  assertEquals(f.filled_at, f.terminal_at);
});
