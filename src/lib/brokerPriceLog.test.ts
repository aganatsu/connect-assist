import { describe, expect, it, vi } from "vitest";
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
import { foldBrokerLog, type BrokerLogRow } from "./brokerPriceLog";

const row = (symbol: string, event: BrokerLogRow["event"], slippage_pips: number | string | null = null, rollover_window: boolean | null = null, entry_zone_type: string | null = "IZ-OB"): BrokerLogRow =>
  ({ symbol, event, slippage_pips, rollover_window, entry_zone_type });

describe("foldBrokerLog", () => {
  it("summarises fills, missing copies, closes and broker-only closes per pair", () => {
    const out = foldBrokerLog([
      row("USD/JPY", "open", 0.5), row("USD/JPY", "open", "1.5", null, "V3A-OB"), row("USD/JPY", "open_skipped"), row("USD/JPY", "open_failed"),
      row("USD/JPY", "close_mirrored", 0.4), row("USD/JPY", "broker_closed_first", 1.0, true), row("USD/JPY", "broker_closed_first", null, false),
      row("EUR/USD", "open", null),
    ]);
    expect(out.map((s) => s.symbol)).toEqual(["EUR/USD", "USD/JPY"]);
    expect(out[0]).toMatchObject({ fills: 1, avgEntrySlip: null, closes: 0 });
    expect(out[1]).toEqual({ symbol: "USD/JPY", fills: 2, noCopy: 2, avgEntrySlip: 1, closes: 3, avgCloseSlip: 0.7, brokerFirst: 2, brokerFirstRollover: 1, v3: 1 });
  });
  it("is empty for no rows", () => expect(foldBrokerLog([])).toEqual([]));
});
