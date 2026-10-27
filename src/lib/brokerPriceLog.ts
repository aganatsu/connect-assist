/**
 * Broker vs bot price check (Impulse-on-V3 step 4c, owner decision S3 = measure first): a per-pair summary of broker_price_log,
 * shown in Bot Config → Structure engine. Measurement only; nothing trades off it.
 */
import { supabase } from "@/integrations/supabase/client";

export interface BrokerLogRow {
  symbol: string; event: "open" | "open_skipped" | "open_failed" | "close_mirrored" | "broker_closed_first";
  slippage_pips: number | string | null; rollover_window: boolean | null; entry_zone_type: string | null;
}
export interface BrokerPairSummary {
  symbol: string; fills: number; noCopy: number; avgEntrySlip: number | null; closes: number; avgCloseSlip: number | null;
  brokerFirst: number; brokerFirstRollover: number; v3: number;
}

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
/** Per pair: MT5 fills and their average slippage, fills with no MT5 copy, closes and their slippage, and broker-only closes. */
export function foldBrokerLog(rows: BrokerLogRow[]): BrokerPairSummary[] {
  const by = new Map<string, { s: BrokerPairSummary; entry: number[]; close: number[] }>();
  for (const r of rows) {
    const g = by.get(r.symbol) ?? { s: { symbol: r.symbol, fills: 0, noCopy: 0, avgEntrySlip: null, closes: 0, avgCloseSlip: null, brokerFirst: 0, brokerFirstRollover: 0, v3: 0 }, entry: [], close: [] };
    by.set(r.symbol, g);
    const slip = r.slippage_pips == null ? null : Number(r.slippage_pips);
    if (r.event === "open") { g.s.fills++; if (slip != null) g.entry.push(slip); if (r.entry_zone_type?.startsWith("V3")) g.s.v3++; }
    else if (r.event === "open_skipped" || r.event === "open_failed") g.s.noCopy++;
    else {
      g.s.closes++;
      if (slip != null) g.close.push(slip);
      if (r.event === "broker_closed_first") { g.s.brokerFirst++; if (r.rollover_window) g.s.brokerFirstRollover++; }
    }
  }
  return [...by.values()].map(({ s, entry, close }) => ({ ...s, avgEntrySlip: avg(entry), avgCloseSlip: avg(close) })).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any; // the table is not in the generated types
export async function brokerPriceSummary(sinceIso: string): Promise<BrokerPairSummary[]> {
  const { data, error } = await db.from("broker_price_log").select("symbol,event,slippage_pips,rollover_window,entry_zone_type").gte("observed_at", sinceIso).limit(5000);
  if (error) throw error;
  return foldBrokerLog(data ?? []);
}
