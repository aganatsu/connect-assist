/**
 * Prop Firm Gate — Integration layer between bot-scanner and propFirmRisk.ts
 *
 * This module handles:
 * 1. Loading prop firm config from DB
 * 2. Loading/creating daily state
 * 3. Running compliance checks
 * 4. Persisting state updates and events
 * 5. Triggering emergency close-all when needed
 *
 * Called from bot-scanner ONCE per scan cycle (not per-pair).
 */

import {
  checkPropFirmCompliance,
  createDailyState,
  updateDailyStateWithEquity,
  getResetHourUTC,
  getCESTTradingDay,
  type PropFirmConfig,
  type PropFirmDailyState,
  type PropFirmComplianceResult,
  type PropFirmEventType,
  type EventSeverity,
} from "./propFirmRisk.ts";

export interface PropFirmGateResult {
  enabled: boolean;
  allowed: boolean;
  reason: string;
  maxPositionSizeMultiplier: number;
  shouldCloseAll: boolean;
  compliance: PropFirmComplianceResult | null;
  configId: string | null;
}

/**
 * Run the prop firm compliance gate.
 *
 * Returns { enabled: false } if no active prop firm config exists.
 * Returns { allowed: true/false, ... } with compliance details otherwise.
 *
 * This function:
 * - Loads the active prop_firm_config for the user
 * - Loads or creates today's daily state
 * - Fetches current equity (from broker or paper balance + floating P&L)
 * - Runs all compliance checks
 * - Updates daily state with new equity reading
 * - Logs events if thresholds are crossed
 * - Returns the gate decision
 */
export async function runPropFirmGate(
  supabase: any,
  userId: string,
  botId: string,
  paperBalance: number,
  openPositions: any[],
  scanCycleId: string,
  opts?: {
    brokerEquity?: number; // If live mode, pass actual broker equity
    isLiveAccount?: boolean; // Whether this is a live (broker-connected) account
    fxMarketClosed?: boolean; // Whether FX market is currently closed (weekends)
  },
): Promise<PropFirmGateResult> {
  // ── 1. Load active prop firm config ──
  const { data: pfConfig, error: cfgErr } = await supabase
    .from("prop_firm_config")
    .select("*")
    .eq("user_id", userId)
    .eq("bot_id", botId)
    .eq("is_active", true)
    .maybeSingle();

  if (cfgErr) {
    console.warn(`[prop-firm-gate] Config query error: ${cfgErr.message}`);
    return { enabled: false, allowed: true, reason: "Config query error (non-blocking)", maxPositionSizeMultiplier: 1, shouldCloseAll: false, compliance: null, configId: null };
  }

  if (!pfConfig) {
    return { enabled: false, allowed: true, reason: "No active prop firm config", maxPositionSizeMultiplier: 1, shouldCloseAll: false, compliance: null, configId: null };
  }

  const config: PropFirmConfig = pfConfig;

  // ── 2. Determine current equity ──
  // For live accounts: use broker equity (includes floating P&L)
  // For paper accounts: balance + sum of unrealized P&L from open positions
  let currentEquity: number;
  if (opts?.brokerEquity && opts.brokerEquity > 0) {
    currentEquity = opts.brokerEquity;
  } else if (opts?.isLiveAccount) {
    // SAFETY: Live account but broker equity fetch failed.
    // Do NOT fall back to paper balance — it's almost certainly wrong.
    // Skip the prop firm gate entirely rather than act on bad data.
    console.warn(`[prop-firm-gate] ⚠️ LIVE account but broker equity unavailable. Skipping prop firm check to avoid false emergency on stale/wrong data.`);
    return {
      enabled: true,
      allowed: true,
      reason: "Broker equity unavailable — prop firm check skipped (safety)",
      maxPositionSizeMultiplier: 1,
      shouldCloseAll: false,
      compliance: null,
      configId: config.id,
    };
  } else {
    // Calculate paper equity: balance + floating P&L
    let floatingPnL = 0;
    for (const pos of openPositions) {
      const entry = parseFloat(pos.entry_price || "0");
      const current = parseFloat(pos.current_price || pos.entry_price || "0");
      const size = parseFloat(pos.size || "0");
      if (entry > 0 && current > 0 && size > 0) {
        const diff = pos.direction === "long" ? current - entry : entry - current;
        // Approximate P&L in account currency (simplified — uses pip value estimation)
        // For accurate P&L, we'd need lot units and quote-to-USD rate, but for the gate
        // check we use the same approximation as the paper account balance tracking.
        const pnlEstimate = diff * size * 100_000; // Assumes standard lot = 100K units
        floatingPnL += pnlEstimate;
      }
    }
    currentEquity = paperBalance + floatingPnL;
  }

  // ── 2b. Sanity check: equity vs initial_balance ──
  // If currentEquity is less than 50% of initial_balance, this is almost certainly
  // a data error (stale price, wrong account, etc.), not a real 50%+ drawdown.
  // Skip the check rather than triggering a false emergency.
  if (currentEquity < config.initial_balance * 0.50) {
    console.warn(`[prop-firm-gate] ⚠️ SANITY CHECK FAILED: equity $${currentEquity.toFixed(2)} is less than 50% of initial_balance $${config.initial_balance}. Likely data error — skipping prop firm check.`);
    return {
      enabled: true,
      allowed: true,
      reason: `Equity sanity check failed ($${currentEquity.toFixed(2)} < 50% of $${config.initial_balance}) — skipped`,
      maxPositionSizeMultiplier: 1,
      shouldCloseAll: false,
      compliance: null,
      configId: config.id,
    };
  }

  // ── 3. Load or create today's daily state ──
  const now = new Date();
  const resetHour = getResetHourUTC(now);
  const tradingDay = getCESTTradingDay(now, resetHour);

  let dailyState: PropFirmDailyState;
  const { data: existingState } = await supabase
    .from("prop_firm_daily_state")
    .select("*")
    .eq("config_id", config.id)
    .eq("trading_day", tradingDay)
    .maybeSingle();

  if (existingState) {
    dailyState = existingState;
  } else {
    // Get the previous day's highest EOD balance (or initial balance if first day)
    const { data: prevStates } = await supabase
      .from("prop_firm_daily_state")
      .select("highest_eod_balance_ever, end_of_day_balance")
      .eq("config_id", config.id)
      .order("trading_day", { ascending: false })
      .limit(1);

    const prevHighestEOD = prevStates?.[0]?.highest_eod_balance_ever
      ?? parseFloat(String(config.initial_balance));

    const newState = createDailyState(
      config.id,
      tradingDay,
      paperBalance, // Use current balance as day start (close enough for first scan of day)
      currentEquity,
      prevHighestEOD,
    );

    const { data: inserted, error: insertErr } = await supabase
      .from("prop_firm_daily_state")
      .insert({ ...newState, trading_day: tradingDay })
      .select()
      .single();

    if (insertErr) {
      // Race condition: another scan cycle may have created it
      const { data: retry } = await supabase
        .from("prop_firm_daily_state")
        .select("*")
        .eq("config_id", config.id)
        .eq("trading_day", tradingDay)
        .maybeSingle();
      dailyState = retry || { ...newState, id: "temp" } as any;
    } else {
      dailyState = inserted;
    }

    // Log day reset event
    await logPropFirmEvent(supabase, config.id, "day_reset", "info",
      `New trading day started: ${tradingDay}`, paperBalance, currentEquity, 0, 0);
  }

  // ── 4. Update daily state with current equity reading ──
  const equityUpdates = updateDailyStateWithEquity(dailyState, currentEquity);
  if (Object.keys(equityUpdates).length > 0) {
    await supabase
      .from("prop_firm_daily_state")
      .update(equityUpdates)
      .eq("id", dailyState.id);
    // Apply updates to local state for compliance check
    Object.assign(dailyState, equityUpdates);
  }

  // ── 5. Check if already locked today ──
  if (dailyState.is_locked) {
    return {
      enabled: true,
      allowed: false,
      reason: `Prop firm locked: ${dailyState.lock_reason || "daily limit reached"}`,
      maxPositionSizeMultiplier: 0,
      shouldCloseAll: false, // Already closed when lock was first triggered
      compliance: null,
      configId: config.id,
    };
  }

  // ── 6. Run compliance checks ──
  const compliance = checkPropFirmCompliance(config, dailyState, currentEquity, paperBalance);

  // ── 7. Log events and update lock state ──
  if (compliance.overall.event) {
    await logPropFirmEvent(
      supabase, config.id,
      compliance.overall.event.type,
      compliance.overall.event.severity,
      compliance.overall.event.message,
      paperBalance, currentEquity,
      dailyState.day_start_balance - currentEquity, // daily loss
      dailyState.highest_eod_balance_ever - currentEquity, // drawdown
    );
  }

  // Lock the day if soft_lock or hard_lock
  if (compliance.overall.severity === "soft_lock" || compliance.overall.severity === "hard_lock") {
    if (!dailyState.is_locked) {
      await supabase
        .from("prop_firm_daily_state")
        .update({
          is_locked: true,
          locked_at: new Date().toISOString(),
          lock_reason: compliance.overall.reason,
        })
        .eq("id", dailyState.id);
    }
  }

  console.log(`[prop-firm-gate] ${scanCycleId} | equity=$${currentEquity.toFixed(2)} | daily_loss=$${(dailyState.day_start_balance - currentEquity).toFixed(2)} | allowed=${compliance.overall.allowed} | severity=${compliance.overall.severity} | size_mult=${compliance.overall.maxPositionSizeMultiplier.toFixed(2)}`);

  return {
    enabled: true,
    allowed: compliance.overall.allowed,
    reason: compliance.overall.reason,
    maxPositionSizeMultiplier: compliance.overall.maxPositionSizeMultiplier,
    shouldCloseAll: compliance.overall.shouldCloseAll,
    compliance,
    configId: config.id,
  };
}

/**
 * Emergency close all open positions.
 * Called when prop firm compliance triggers shouldCloseAll.
 */
export async function propFirmEmergencyClose(
  supabase: any,
  userId: string,
  botId: string,
  openPositions: any[],
  reason: string,
  scanCycleId: string,
  opts?: { fxMarketClosed?: boolean },
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
      const pnl = diff * size * 100_000; // Simplified P&L

      // Close the paper position
      await supabase.from("paper_positions").delete().eq("id", pos.id);

      // Record in trade history
      await supabase.from("paper_trade_history").insert({
        user_id: userId,
        position_id: pos.position_id,
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
        bot_id: botId,
      });

      closedCount++;
      console.log(`[prop-firm-emergency] Closed ${pos.symbol} ${pos.direction} — PnL: $${pnl.toFixed(2)} — reason: ${reason}`);
    } catch (e: any) {
      console.warn(`[prop-firm-emergency] Failed to close ${pos.symbol}: ${e?.message}`);
    }
  }

  // Update account balance after all closes
  if (closedCount > 0) {
    // Recalculate balance from trade history (most accurate)
    const { data: acct } = await supabase
      .from("paper_accounts")
      .select("balance")
      .eq("user_id", userId)
      .eq("bot_id", botId)
      .maybeSingle();

    if (acct) {
      let totalPnL = 0;
      for (const pos of openPositions) {
        const entry = parseFloat(pos.entry_price || "0");
        const current = parseFloat(pos.current_price || pos.entry_price || "0");
        const size = parseFloat(pos.size || "0");
        const diff = pos.direction === "long" ? current - entry : entry - current;
        totalPnL += diff * size * 100_000;
      }
      const newBalance = parseFloat(acct.balance) + totalPnL;
      await supabase
        .from("paper_accounts")
        .update({ balance: newBalance.toFixed(2) })
        .eq("user_id", userId)
        .eq("bot_id", botId);
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
