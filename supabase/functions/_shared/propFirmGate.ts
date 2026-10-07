/**
 * Prop Firm Gate — integration layer between bot-scanner and the account risk
 * limits (accountRiskLimits.ts).
 *
 * Step 13: the active prop_firm_config row is the risk PROFILE. Every limit is
 * a value on that row — FTMO's hard limits (max_daily_loss_pct,
 * max_overall_loss_pct) and our buffers (daily_entry_stop_pct,
 * daily_flatten_pct, overall_entry_stop_equity, overall_flatten_equity).
 *
 * Called from bot-scanner ONCE per scan cycle, BEFORE the Route 2 hunt, and
 * its decision applies to Route 2 fills and to new placement alike.
 *
 *   day        tradingDayAt(now, day_boundary_tz) — the only day boundary
 *   day start  settlement-ledger balance at that boundary
 *   equity     paper balance + floating P/L in USD − commissions + swaps
 *   decision   evaluateAccountRisk — missing data blocks entries, never flattens
 *
 * No size reduction, no profit-target shutdown.
 */

import {
  computeEquity,
  dataError,
  dayStartBalanceFromLedger,
  evaluateAccountRisk,
  tradingDayAt,
  validateProfile,
  type OpenPositionInput,
  type RiskDecision,
} from "./accountRiskLimits.ts";
import type { PropFirmComplianceResult, PropFirmEventType, EventSeverity } from "./propFirmRisk.ts";
import { settlePaperPosition, describeSettlementMiss } from "./paperSettlement.ts";

export interface PropFirmGateResult {
  enabled: boolean;
  allowed: boolean;
  reason: string;
  /** Always 1: automatic size reduction is off. */
  maxPositionSizeMultiplier: number;
  /** True only after a SUCCESSFUL calculation crossed a flatten threshold. */
  shouldCloseAll: boolean;
  compliance: PropFirmComplianceResult | null;
  configId: string | null;
  decision?: RiskDecision;
  tradingDay?: string;
}

export interface RiskAccount {
  id: string;
  ledger_epoch_id: string | null;
  balance: number | string;
}

const result = (configId: string | null, d: RiskDecision, tradingDay?: string, lockedReason?: string | null): PropFirmGateResult => ({
  enabled: true,
  allowed: d.allowEntries && !lockedReason,
  reason: lockedReason && d.severity === "ok" ? `locked for the trading day: ${lockedReason}` : d.reason,
  maxPositionSizeMultiplier: 1,
  shouldCloseAll: d.flatten && d.severity === "flatten",
  compliance: null,
  configId,
  decision: d,
  tradingDay,
});

/**
 * Returns { enabled: false } when no profile is active. Otherwise the decision
 * for this cycle. Never throws: any failure is a fail-closed data error.
 */
export async function runPropFirmGate(
  supabase: any,
  userId: string,
  botId: string,
  account: RiskAccount,
  openPositions: OpenPositionInput[],
  scanCycleId: string,
  opts: {
    rateMap: Record<string, number> | undefined;
    /** Not-yet-charged commission per lot (round trip). 0 on paper. */
    commissionPerLotRoundTrip?: number;
    now?: Date;
  },
): Promise<PropFirmGateResult> {
  let configId: string | null = null;
  try {
    // ── 1. Profile ──
    const { data: profile, error: cfgErr } = await supabase
      .from("prop_firm_config").select("*")
      .eq("user_id", userId).eq("bot_id", botId).eq("is_active", true)
      .maybeSingle();
    if (cfgErr) return result(null, dataError(`profile read failed: ${cfgErr.message}`));
    if (!profile) {
      return { enabled: false, allowed: true, reason: "No active prop firm config", maxPositionSizeMultiplier: 1, shouldCloseAll: false, compliance: null, configId: null };
    }
    configId = profile.id;
    const v = validateProfile(profile);
    if (!v.ok) return result(configId, dataError(v.reason));
    if ((profile.equity_source ?? "paper") !== "paper") {
      return result(configId, dataError(`equity_source '${profile.equity_source}' is not supported until broker↔ledger reconciliation exists`));
    }

    // ── 2. Trading day and its start balance (ledger) ──
    const now = opts.now ?? new Date();
    const day = tradingDayAt(now, v.profile.day_boundary_tz);
    if (!account?.id || !account.ledger_epoch_id) return result(configId, dataError("account ledger epoch unknown"), day.tradingDay);
    const ledger = () => supabase.from("paper_account_ledger").select("balance_after,created_at,kind")
      .eq("account_id", account.id).eq("epoch_id", account.ledger_epoch_id);
    const before = await ledger().lt("created_at", day.startsAt.toISOString()).order("seq", { ascending: false }).limit(1);
    const first = await ledger().order("seq", { ascending: true }).limit(1);
    if (before.error || first.error) return result(configId, dataError(`ledger read failed: ${(before.error ?? first.error).message}`), day.tradingDay);
    const dayStart = dayStartBalanceFromLedger(before.data?.[0] ?? null, first.data?.[0] ?? null);

    // ── 3. Equity ──
    const eq = computeEquity({
      balance: Number(account.balance),
      positions: openPositions,
      rateMap: opts.rateMap,
      commissionPerLotRoundTrip: opts.commissionPerLotRoundTrip ?? 0,
    });

    // ── 4. Decision ──
    const decision = evaluateAccountRisk(profile, dayStart, eq);

    // ── 5. Day state (record only; the decision above does not depend on it,
    //       except that a lock holds until the next boundary) ──
    let lockedReason: string | null = null;
    if (dayStart.ok) {
      lockedReason = await persistDayState(supabase, configId!, day.tradingDay, dayStart.balance, decision);
    }

    if (decision.severity !== "ok") {
      console.warn(`[prop-firm-gate] ${scanCycleId} | ${decision.severity} | ${decision.reason}`);
    }
    console.log(`[prop-firm-gate] ${scanCycleId} | day=${day.tradingDay} start=${dayStart.ok ? dayStart.balance.toFixed(2) : "?"} equity=${eq.ok ? eq.equity.toFixed(2) : "?"} | allowed=${decision.allowEntries && !lockedReason} | ${decision.severity}`);
    return result(configId, decision, day.tradingDay, lockedReason);
  } catch (e: any) {
    return result(configId, dataError(`gate error: ${e?.message ?? e}`));
  }
}

/**
 * Upserts today's prop_firm_daily_state from the ledger-derived day start,
 * closes the previous day's row (end_of_day_balance = today's start), and
 * locks the day on an entry stop or flatten. Returns the active lock reason.
 * Persistence failures are logged, never thrown.
 */
async function persistDayState(
  supabase: any, configId: string, tradingDay: string, dayStartBalance: number, d: RiskDecision,
): Promise<string | null> {
  try {
    const { data: row } = await supabase.from("prop_firm_daily_state").select("*")
      .eq("config_id", configId).eq("trading_day", tradingDay).maybeSingle();
    const equity = d.equity;
    let state = row;
    if (!state) {
      const { data: prev } = await supabase.from("prop_firm_daily_state")
        .select("id,highest_eod_balance_ever,end_of_day_balance,trading_day")
        .eq("config_id", configId).lt("trading_day", tradingDay).order("trading_day", { ascending: false }).limit(1);
      const p = prev?.[0];
      if (p && p.end_of_day_balance == null) {
        await supabase.from("prop_firm_daily_state").update({ end_of_day_balance: dayStartBalance }).eq("id", p.id);
      }
      const highestEod = Math.max(Number(p?.highest_eod_balance_ever ?? dayStartBalance), dayStartBalance);
      const { data: inserted } = await supabase.from("prop_firm_daily_state").insert({
        config_id: configId, trading_day: tradingDay,
        day_start_balance: dayStartBalance, day_start_equity: equity ?? dayStartBalance,
        highest_equity_today: equity ?? dayStartBalance, lowest_equity_today: equity ?? dayStartBalance,
        current_equity: equity, highest_eod_balance_ever: highestEod,
      }).select().single();
      state = inserted ?? null;
      if (state) await logPropFirmEvent(supabase, configId, "day_reset", "info", `Trading day ${tradingDay} started at ledger balance $${dayStartBalance.toFixed(2)}`, dayStartBalance, equity ?? dayStartBalance, 0, 0);
    }
    if (!state) return null;

    const upd: Record<string, unknown> = {};
    if (Number(state.day_start_balance) !== dayStartBalance) upd.day_start_balance = dayStartBalance; // the ledger is authoritative
    if (equity != null) {
      upd.current_equity = equity;
      if (equity > Number(state.highest_equity_today)) upd.highest_equity_today = equity;
      if (equity < Number(state.lowest_equity_today)) upd.lowest_equity_today = equity;
    }
    let lock: string | null = state.is_locked ? (state.lock_reason ?? "locked") : null;
    if (!lock && (d.severity === "entry_stop" || d.severity === "flatten")) {
      lock = d.reason;
      Object.assign(upd, { is_locked: true, locked_at: new Date().toISOString(), lock_reason: d.reason });
      await logPropFirmEvent(supabase, configId, d.severity === "flatten" ? "emergency_close" : "daily_soft_lock",
        d.severity === "flatten" ? "critical" : "warning", d.reason,
        d.dayStartBalance ?? 0, equity ?? 0, d.dailyLossUsd ?? 0, 0);
    }
    if (Object.keys(upd).length) await supabase.from("prop_firm_daily_state").update(upd).eq("id", state.id);
    return lock;
  } catch (e: any) {
    console.warn(`[prop-firm-gate] day state persistence failed (decision unaffected): ${e?.message}`);
    return null;
  }
}

/**
 * Emergency close all open positions.
 * Called when prop firm compliance triggers shouldCloseAll.
 *
 * Each position settles on its own through settle_paper_position, so the
 * balance moves by exactly the P&L of the positions that actually closed.
 * Previously the balance update re-summed P&L over EVERY open position —
 * including FX positions skipped on a weekend and any whose close failed —
 * and credited it in one unconditional write.
 *
 * `pnlFor` lets the caller supply the instrument-aware P&L (contract size and
 * quote->USD conversion). Without it the legacy `diff * size * 100_000`
 * approximation is used, which is wrong for JPY-quoted pairs, metals and
 * crypto.
 */
export async function propFirmEmergencyClose(
  supabase: any,
  userId: string,
  botId: string,
  openPositions: any[],
  reason: string,
  scanCycleId: string,
  opts?: { fxMarketClosed?: boolean; pnlFor?: (pos: any, exitPrice: number) => number },
): Promise<number> {
  // Weekend guard: when FX market is closed, only close crypto positions.
  // FX positions can't be executed on weekends anyway, and stale prices
  // could produce incorrect P&L calculations.
  let positionsToClose = openPositions;
  if (opts?.fxMarketClosed) {
    const cryptoSymbols = new Set(["BTCUSD", "ETHUSD", "XRPUSD", "SOLUSD", "LTCUSD", "ADAUSD", "DOTUSD", "DOGEUSD", "AVAXUSD", "LINKUSD"]);
    const cryptoOnly = openPositions.filter((p: any) => {
      const sym = (p.symbol || "").replace("/", "").toUpperCase();
      return cryptoSymbols.has(sym) || sym.endsWith("USD") && sym.startsWith("BTC") || sym.startsWith("ETH");
    });
    const fxSkipped = openPositions.length - cryptoOnly.length;
    if (fxSkipped > 0) {
      console.log(`[prop-firm-emergency] FX market closed — skipping ${fxSkipped} FX position(s), only closing ${cryptoOnly.length} crypto position(s)`);
    }
    positionsToClose = cryptoOnly;
  }

  let closedCount = 0;

  for (const pos of positionsToClose) {
    try {
      const entry = parseFloat(pos.entry_price || "0");
      const current = parseFloat(pos.current_price || pos.entry_price || "0");
      const size = parseFloat(pos.size || "0");
      const diff = pos.direction === "long" ? current - entry : entry - current;
      const pnl = opts?.pnlFor ? opts.pnlFor(pos, current) : diff * size * 100_000; // Simplified P&L fallback

      const settlement = await settlePaperPosition(supabase, {
        positionRowId: pos.id, userId, botId, source: "prop_firm_emergency",
        history: {
          order_id: pos.order_id || crypto.randomUUID().slice(0, 8),
          symbol: pos.symbol,
          direction: pos.direction,
          size: pos.size,
          entry_price: pos.entry_price,
          exit_price: current.toString(),
          open_time: pos.open_time || new Date().toISOString(),
          closed_at: new Date().toISOString(),
          close_reason: "prop_firm_emergency",
          pnl: pnl.toFixed(2),
          signal_score: pos.signal_score || "0",
        },
      });
      if (settlement.outcome !== "settled") {
        console.warn(`[prop-firm-emergency] ${pos.symbol} ${pos.position_id} — ${describeSettlementMiss(settlement)}`);
        continue;
      }

      closedCount++;
      console.log(`[prop-firm-emergency] Closed ${pos.symbol} ${pos.direction} — PnL: $${pnl.toFixed(2)} — reason: ${reason}`);
    } catch (e: any) {
      console.warn(`[prop-firm-emergency] Failed to close ${pos.symbol}: ${e?.message}`);
    }
  }

  console.log(`[prop-firm-emergency] ${scanCycleId} | Closed ${closedCount}/${openPositions.length} positions — ${reason}`);
  return closedCount;
}

// ─── Helper: Log prop firm event ──────────────────────────────────────────────

async function logPropFirmEvent(
  supabase: any,
  configId: string,
  eventType: PropFirmEventType,
  severity: EventSeverity,
  message: string,
  balance: number,
  equity: number,
  dailyLoss: number,
  drawdown: number,
): Promise<void> {
  try {
    await supabase.from("prop_firm_events").insert({
      config_id: configId,
      event_type: eventType,
      severity,
      message,
      balance_at_event: balance,
      equity_at_event: equity,
      daily_loss_at_event: dailyLoss,
      drawdown_at_event: drawdown,
    });
  } catch (e: any) {
    console.warn(`[prop-firm-event] Failed to log event: ${e?.message}`);
  }
}
