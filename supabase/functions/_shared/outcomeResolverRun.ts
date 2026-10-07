/**
 * STEP 15 PR 3 — one pass of the dry-run outcome resolver.
 *
 * Reads unresolved hypothetical fills from trade_attribution and the stored
 * 5m bars (smc_scan_bars, latest revision per bar), resolves each with the pure
 * resolveHypothetical, and writes ONLY through:
 *   attribution_resolve_hypothetical  (section G, once)
 *   attribution_defer_hypothetical    (deduplicated deferral event)
 * No order, position, account, ledger or history write; no provider calls.
 */
import { type Bar, OUTCOME_METHOD, resolveHypothetical } from "./hypotheticalOutcome.ts";
import { SPECS } from "./smcAnalysis.ts";

export interface ResolverSummary {
  candidates: number;
  resolved: number;
  deferred: number;
  pending: number;
  invalid: number;
  errors: string[];
  results: { signal_id: string; symbol: string; status: string; detail?: unknown }[];
}

const PAGE = 1000;

/** Latest revision per bar_time, plus the newest observation time, for one symbol. */
export async function loadBars(supabase: any, symbol: string, fromIso: string): Promise<{ bars: Bar[]; lastObservationMs: number }> {
  const latest = new Map<string, { seen: string; row: any }>();
  let lastObs = 0;
  for (let off = 0; ; off += PAGE) {
    const { data, error } = await supabase.from("smc_scan_bars")
      .select("bar_time, open, high, low, close, first_seen_at")
      .eq("symbol", symbol).eq("timeframe", "5m").gte("bar_time", fromIso)
      .order("bar_time", { ascending: true }).order("first_seen_at", { ascending: true })
      .range(off, off + PAGE - 1);
    if (error) throw new Error(`smc_scan_bars ${symbol}: ${error.message}`);
    for (const r of data ?? []) {
      const seenMs = Date.parse(r.first_seen_at);
      if (seenMs > lastObs) lastObs = seenMs;
      const prev = latest.get(r.bar_time);
      if (!prev || r.first_seen_at > prev.seen) latest.set(r.bar_time, { seen: r.first_seen_at, row: r });
    }
    if (!data || data.length < PAGE) break;
  }
  const bars: Bar[] = [...latest.values()].map(({ row }) => ({
    t: Date.parse(row.bar_time), o: Number(row.open), h: Number(row.high), l: Number(row.low), c: Number(row.close),
  }));
  return { bars, lastObservationMs: lastObs };
}

export async function runOutcomeResolver(supabase: any, nowMs: number, limit = 100): Promise<ResolverSummary> {
  const out: ResolverSummary = { candidates: 0, resolved: 0, deferred: 0, pending: 0, invalid: 0, errors: [], results: [] };
  const { data: cands, error } = await supabase.from("trade_attribution")
    .select("signal_id, symbol, direction, filled_at, fill_price, fill_stop_price, fill_target_price, fill_risk_usd, cost_in_price")
    .eq("fill_kind", "hypothetical").is("closed_at", null)
    .order("filled_at", { ascending: true }).limit(limit);
  if (error) throw new Error(`trade_attribution: ${error.message}`);
  out.candidates = (cands ?? []).length;

  const bySymbol = new Map<string, any[]>();
  for (const c of cands ?? []) bySymbol.set(c.symbol, [...(bySymbol.get(c.symbol) ?? []), c]);

  for (const [symbol, list] of bySymbol) {
    let barData: { bars: Bar[]; lastObservationMs: number };
    const fromIso = new Date(Math.min(...list.map((c) => Date.parse(c.filled_at))) - 5 * 60_000).toISOString();
    try {
      barData = await loadBars(supabase, symbol, fromIso);
    } catch (e: any) {
      out.errors.push(String(e?.message ?? e));
      continue;
    }
    const pipSize = (SPECS[symbol] || SPECS["EUR/USD"]).pipSize;
    for (const c of list) {
      const res = resolveHypothetical({
        direction: c.direction, fillAtMs: Date.parse(c.filled_at), fillPrice: Number(c.fill_price),
        stop: Number(c.fill_stop_price), target: Number(c.fill_target_price),
        riskUsd: c.fill_risk_usd == null ? null : Number(c.fill_risk_usd),
        costInPrice: c.cost_in_price == null ? null : Number(c.cost_in_price),
        pipSize, bars: barData.bars, lastObservationMs: barData.lastObservationMs, nowMs,
      });
      try {
        if (res.status === "resolved") {
          const payload = {
            method: OUTCOME_METHOD, exit_reason: res.exitReason, exit_price: res.exitPrice,
            closed_at: new Date(res.closedAtMs).toISOString(), bar_time: new Date(res.barTimeMs).toISOString(),
            r_gross: res.rGross, r_net: res.rNet, pnl_usd: res.pnlUsd, pnl_net_usd: res.pnlNetUsd,
            margin_pips: res.marginPips, bars_replayed: res.barsReplayed,
          };
          const { data: r, error: e } = await supabase.rpc("attribution_resolve_hypothetical", { p_signal_id: c.signal_id, p_outcome: payload });
          if (e) throw new Error(e.message);
          if (r === "resolved") out.resolved++;
          out.results.push({ signal_id: c.signal_id, symbol, status: r === "resolved" ? "resolved" : `skipped:${r}`, detail: payload });
        } else if (res.status === "deferred" || res.status === "invalid") {
          const gap = res.status === "deferred" ? new Date(res.gapStartMs).toISOString() : null;
          const { error: e } = await supabase.rpc("attribution_defer_hypothetical", {
            p_signal_id: c.signal_id, p_gap_start: gap,
            p_detail: { reason: res.reason, status: res.status, ...(res.status === "deferred" ? { gap_end: res.gapEndMs ? new Date(res.gapEndMs).toISOString() : null, bars_replayed: res.barsReplayed } : {}) },
          });
          if (e) throw new Error(e.message);
          if (res.status === "deferred") out.deferred++; else out.invalid++;
          out.results.push({ signal_id: c.signal_id, symbol, status: res.status, detail: res.reason });
        } else {
          out.pending++;
          out.results.push({ signal_id: c.signal_id, symbol, status: "pending", detail: res.reason });
        }
      } catch (e: any) {
        out.errors.push(`${c.signal_id}: ${e?.message ?? e}`);
      }
    }
  }
  return out;
}
