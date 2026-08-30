import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import { MIN_SL_PIPS, ATR_SL_FLOOR_MULTIPLIER, calculateATR, calcPnl, FALLBACK_RATES, SPECS, type Candle } from "../_shared/smcAnalysis.ts";
import { parseTradeOverrides } from "../_shared/resolveTradeConfig.ts";
import { resolvePositionManagementPolicy } from "../_shared/managementPolicy.ts";
import { computeTrailRatchet } from "../_shared/exitEngine.ts";
import { evaluateExit, priceAsBar } from "../_shared/exitEvaluation.ts";
import { finalizePaperPositionClose } from "../_shared/finalizePaperPositionClose.ts";
import { reconcileFullBrokerClose } from "../_shared/reconcileBrokerState.ts";
import { acquireApiCredit, setCreditCallerContext } from "../_shared/apiCreditBudget.ts";
import { fetchLivePrice, TWELVE_DATA_SYMBOLS } from "../_shared/candleSource.ts";
import { areNonCryptoMarketsClosed, isInstrumentMarketOpen } from "../_shared/gamePlanMarketScope.ts";


setCreditCallerContext("paper-trading");

const TD_CREDIT_LIMIT = 50;

/**
 * Fetch recent 15-minute candles from TwelveData and compute ATR(14).
 * Returns 0 if data is unavailable (graceful degradation to static floor only).
 * Results are cached for 15 minutes per symbol to reduce API calls.
 */
const ATR_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const atrCache: Map<string, { value: number; expiresAt: number }> = new Map();

async function fetchATR(symbol: string): Promise<number> {
  // Check cache first
  const cached = atrCache.get(symbol);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }
  const apiKey = Deno.env.get("TWELVE_DATA_API_KEY");
  if (!apiKey) return 0;
  const tdSymbol = TWELVE_DATA_SYMBOLS[symbol];
  if (!tdSymbol) return 0;
  // ATR degrades gracefully to the static floor, so a skipped fetch is safe.
  if (!await acquireApiCredit("twelvedata", TD_CREDIT_LIMIT, { label: "paper-trading/atr" })) {
    return 0;
  }
  try {
    // Fetch 20 candles (need at least 15 for ATR-14)
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=15min&outputsize=20&apikey=${apiKey}&order=ASC&timezone=UTC`;
    const res = await fetch(url);
    if (!res.ok) return 0;
    const data = await res.json();
    if (data?.status === "error" || !Array.isArray(data?.values)) return 0;
    const candles: Candle[] = data.values.map((v: any) => ({
      datetime: `${v.datetime.replace(" ", "T")}Z`,
      open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close),
    })).filter((c: Candle) =>
      Number.isFinite(c.open) && Number.isFinite(c.high) &&
      Number.isFinite(c.low) && Number.isFinite(c.close)
    );
    const atr = calculateATR(candles, 14);
    // Cache the result
    atrCache.set(symbol, { value: atr, expiresAt: Date.now() + ATR_CACHE_TTL_MS });
    return atr;
  } catch {
    return 0;
  }
}

async function updatePositionPrices(supabase: any, positions: any[], marketNow = new Date()): Promise<void> {
  if (!positions || positions.length === 0) return;
  const symbols = [...new Set(positions.map((p: any) => p.symbol))]
    .filter((sym) => isInstrumentMarketOpen(sym, marketNow));
  const priceMap: Record<string, number> = {};
  await Promise.all(symbols.map(async (sym) => {
    const price = await fetchLivePrice(sym);
    if (price !== null) priceMap[sym] = price;
  }));
  await Promise.all(positions.map(async (p: any) => {
    const livePrice = priceMap[p.symbol];
    if (livePrice !== undefined) {
      await supabase.from("paper_positions").update({ current_price: livePrice.toString() }).eq("id", p.id);
    }
  }));
}

// Module-level rateMap built once per invocation from live prices
let _rateMap: Record<string, number> = {};

async function buildRateMap(marketNow = new Date()): Promise<Record<string, number>> {
  const RATE_PAIRS = ["USD/JPY", "GBP/USD", "AUD/USD", "NZD/USD", "USD/CAD", "USD/CHF"];
  // Start with fallback rates so we always have something reasonable
  const map: Record<string, number> = { ...FALLBACK_RATES };
  if (areNonCryptoMarketsClosed(marketNow)) {
    console.log("[rateMap] Non-crypto markets are closed — using fallback conversion rates");
    return map;
  }
  await Promise.all(RATE_PAIRS.map(async (pair) => {
    const price = await fetchLivePrice(pair);
    if (price !== null) map[pair] = price; // Override fallback with live rate
  }));
  const liveCount = RATE_PAIRS.filter(p => map[p] !== FALLBACK_RATES[p]).length;
  if (liveCount < RATE_PAIRS.length) {
    console.warn(`[rateMap] Only ${liveCount}/${RATE_PAIRS.length} live rates fetched — using fallbacks for the rest`);
  }
  return map;
}

// ─── Structured close logging + audit row ───────────────────────────
async function logClose(
  supabase: any,
  userId: string,
  pos: any,
  args: {
    closeReason: string;
    closeSource: "scanner" | "broker_callback" | "user" | "sync" | "kill_switch" | "auto_engine";
    pnl: number;
    exitPrice: number;
    scanCycleId?: string | null;
    extra?: Record<string, any>;
  },
): Promise<void> {
  const mirroredIds: string[] = Array.isArray(pos.mirrored_connection_ids) ? pos.mirrored_connection_ids : [];
  const sl = pos.stop_loss ? parseFloat(pos.stop_loss) : null;
  const tp = pos.take_profit ? parseFloat(pos.take_profit) : null;
  const lastPrice = pos.current_price ? parseFloat(pos.current_price) : null;
  console.log("[close]", JSON.stringify({
    position_id: pos.position_id,
    symbol: pos.symbol,
    direction: pos.direction,
    broker_connection_ids: mirroredIds,
    pnl: args.pnl,
    exit_price: args.exitPrice,
    sl, tp, last_price: lastPrice,
    close_reason: args.closeReason,
    close_source: args.closeSource,
    scan_cycle_id: args.scanCycleId ?? null,
  }));
  try {
    // One audit row per broker (or one with null connection if paper-only)
    const rows = (mirroredIds.length > 0 ? mirroredIds : [null]).map((cid: string | null) => ({
      user_id: userId,
      position_id: pos.position_id,
      symbol: pos.symbol,
      broker_connection_id: cid,
      close_reason: args.closeReason,
      close_source: args.closeSource,
      pnl: args.pnl.toFixed(2),
      exit_price: args.exitPrice.toString(),
      scan_cycle_id: args.scanCycleId ?? null,
      detail_json: { sl, tp, last_price: lastPrice, direction: pos.direction, ...(args.extra || {}) },
    }));
    await supabase.from("close_audit_log").insert(rows);
  } catch (e: any) {
    console.warn(`[close] audit insert failed for ${pos.position_id}: ${e?.message}`);
  }
}


function generatePostMortem(
  position: any, exitPrice: number, pnl: number, pnlPips: number, closeReason: string,
): any {
  const entryPrice = parseFloat(position.entry_price);
  const signalScore = parseFloat(position.signal_score || "0");
  const signalReason = position.signal_reason || "";
  const openTime = position.open_time;
  const closedAt = new Date().toISOString();

  // Determine outcome
  const outcome = pnl > 0 ? "Win" : pnl < 0 ? "Loss" : "Breakeven";

  // Parse factors from signal reason (17 ICT factors — Trend Direction merged into Market Structure)
  const factorNames = [
    "Market Structure", "Order Block", "Fair Value Gap", "Premium/Discount",
    "Session Quality", "Judas Swing", "PD/PW Levels", "Reversal Candle", "Liquidity Sweep",
    "Displacement", "Breaker Block", "Unicorn Model", "Silver Bullet",
    "Macro Window", "SMT Divergence", "VWAP", "AMD Phase",
    "Currency Strength", "Daily Bias", "Volume Profile",
  ];
  const presentFactors = factorNames.filter(f => signalReason.includes(f));
  const absentFactors = factorNames.filter(f => !signalReason.includes(f));

  // Calculate hold duration
  let holdDuration = "Unknown";
  try {
    const openMs = new Date(openTime).getTime();
    const closeMs = new Date(closedAt).getTime();
    const diffMs = closeMs - openMs;
    const hours = Math.floor(diffMs / 3600000);
    const minutes = Math.floor((diffMs % 3600000) / 60000);
    holdDuration = `${hours}h ${minutes}m`;
  } catch {}

  // Generate insights
  let whatWorked = "";
  let whatFailed = "";
  let lessonLearned = "";

  if (outcome === "Win") {
    whatWorked = presentFactors.length > 0
      ? `Confluence factors aligned correctly: ${presentFactors.join(", ")}`
      : "Trade direction was correct";
    whatFailed = absentFactors.length > 0
      ? `Not all factors were present: missing ${absentFactors.join(", ")}`
      : "All factors aligned — textbook setup";
    lessonLearned = signalScore >= 65
      ? "High-confluence setup played out as expected. Continue targeting similar setups."
      : signalScore >= 10
      ? "Trade won despite moderate confluence. Consider if the setup was fortunate or skill-based."
      : "Trade won — note: score may be in legacy 0-10 format if from an older scan.";
  } else if (outcome === "Loss") {
    whatWorked = presentFactors.length > 0
      ? `These factors were correctly identified: ${presentFactors.join(", ")}`
      : "Signal was generated but lacked strong confluence";
    whatFailed = closeReason === "sl_hit"
      ? "Stop loss was hit — market structure changed after entry or SL was too tight"
      : `Trade closed with loss: ${closeReason}`;
    lessonLearned = signalScore < 55
      ? `Confluence score was ${signalScore > 10 ? signalScore.toFixed(1) + "%" : signalScore.toFixed(1) + "/10"}. Consider raising minimum threshold to reduce weak signals.`
      : "Setup had good confluence but market conditions shifted. Review if HTF bias was truly aligned.";
  } else {
    whatWorked = "Trade reached breakeven — partial validation of the setup";
    whatFailed = "Insufficient momentum for follow-through to TP";
    lessonLearned = "Consider tighter entry timing or wider TP targets for similar setups.";
  }

  return {
    outcome,
    pnl,
    pnlPips,
    holdDuration,
    exitReason: closeReason,
    confluenceScore: signalScore,
    factorsPresent: presentFactors,
    factorsAbsent: absentFactors,
    whatWorked,
    whatFailed,
    lessonLearned,
    entryPrice,
    exitPrice,
    direction: position.direction,
    symbol: position.symbol,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized", code: "missing_auth" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    // Use getClaims() for local JWT verification (JWKS-based). The JWKS fetch
    // can transiently fail with "Connection reset by peer" on cold boots — retry
    // a couple of times before returning 401 so a flaky network hop doesn't
    // surface as a fake "invalid_jwt" to the user.
    const token = authHeader.replace("Bearer ", "");
    let claimsData: any = null;
    let authError: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await supabase.auth.getClaims(token);
      claimsData = res.data;
      authError = res.error;
      if (!authError && claimsData?.claims?.sub) break;
      const msg = String(authError?.message ?? "");
      const transient = /Connection reset|jwks|ECONNRESET|fetch failed|network|timeout/i.test(msg);
      if (!transient) break;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
    if (authError || !claimsData?.claims?.sub) {
      return new Response(JSON.stringify({ error: "Unauthorized", code: "invalid_jwt", details: authError?.message }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const user = { id: claimsData.claims.sub as string };
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const serviceSupabase = serviceRoleKey
      ? createClient(Deno.env.get("SUPABASE_URL")!, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      : null;

    const { action, ...payload } = await req.json().catch(() => ({ action: "status" }));
    const marketNow = new Date();

    // Build live conversion rates only for write/engine actions. The dashboard
    // status endpoint is polled frequently and must stay fast/read-only; doing
    // multiple external API requests on every cold status worker was causing
    // runtime churn and intermittent hosted 503s.
    if (action !== "status" && Object.keys(_rateMap).length === 0) {
      try {
        _rateMap = await buildRateMap(marketNow);
      } catch (e: any) {
        console.warn(`rateMap build failed: ${e?.message} — using fallback rates`);
        _rateMap = { ...FALLBACK_RATES };
      }
    } else if (Object.keys(_rateMap).length === 0) {
      _rateMap = { ...FALLBACK_RATES };
    }

    // ── Get account state ──
    if (action === "status") {
      const { data: account, error: accountReadError } = await supabase.from("paper_accounts").select("*").eq("user_id", user.id).maybeSingle();
      if (accountReadError) {
        return respond({
          ok: false,
          state: "unknown",
          executionMode: "unknown",
          error: "Trading account status is unavailable: " + accountReadError.message,
          code: "account_status_read_failed",
        }, 503);
      }

      // H17: Daily PnL base reset — if the day has changed, reset daily_pnl_base to current balance
      if (account) {
        const todayDate = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
        const lastResetDate = account.daily_pnl_base_date || "";
        if (lastResetDate !== todayDate) {
          const currentBalance = parseFloat(String(account.balance ?? "10000"));
          await supabase.from("paper_accounts")
            .update({ daily_pnl_base: currentBalance.toString(), daily_pnl_base_date: todayDate })
            .eq("user_id", user.id);
          account.daily_pnl_base = currentBalance.toString();
          account.daily_pnl_base_date = todayDate;
          console.log(`[PnL Reset] User ${user.id}: daily_pnl_base reset to ${currentBalance} for ${todayDate}`);
        }
      }

      let { data: positions, error: positionsReadError } = await supabase.from("paper_positions").select("*").eq("user_id", user.id).eq("position_status", "open").order("open_time", { ascending: true });
      if (positionsReadError) {
        return respond({
          ok: false,
          state: "unknown",
          executionMode: "unknown",
          error: "Open-position status is unavailable: " + positionsReadError.message,
          code: "position_status_read_failed",
        }, 503);
      }
      // ── Refresh live prices on status poll for open markets ──
      // Without this, positions show stale entry-time prices ($0 PnL) between scanner cycles.
      // Uses the lightweight TwelveData /price endpoint (single quote per symbol).
      if (positions && positions.length > 0) {
        const symbols = ([...new Set(positions.map((p: any) => p.symbol))] as string[])
          .filter((sym) => isInstrumentMarketOpen(sym, marketNow));
        const priceMap: Record<string, number> = {};
        await Promise.all(symbols.map(async (sym: string) => {
          const price = await fetchLivePrice(sym);
          if (price !== null) priceMap[sym] = price;
        }));
        let priceUpdated = false;
        for (const p of positions) {
          const livePrice = priceMap[p.symbol];
          if (livePrice !== undefined && livePrice.toString() !== p.current_price) {
            p.current_price = livePrice.toString();
            priceUpdated = true;
          }
        }
        // Persist updated prices to DB (fire-and-forget for response speed)
        if (priceUpdated) {
          Promise.all(positions.map((p: any) => {
            const livePrice = priceMap[p.symbol];
            if (livePrice !== undefined) {
              return supabase.from("paper_positions").update({ current_price: livePrice.toString() }).eq("id", p.id);
            }
          })).catch(() => {});
        }
      }
      // Engine processing (SL/TP/trail/BE logic) only runs when explicitly triggered.
      // Dashboard polling must not perform broker mirror actions.
      // Extract global exit config once — used both by engine processing (below)
      // and by the response serializer (effectiveConfig per position).
      let runtimeManagementConfig: any = {};
      try {
        const { data: cfgRowTop } = await supabase.from("bot_configs").select("config_json").eq("user_id", user.id).is("connection_id", null).maybeSingle();
        runtimeManagementConfig = cfgRowTop?.config_json || {};
      } catch {}
      if (payload.processEngine === true && positions && positions.length > 0) {
        await updatePositionPrices(supabase, positions, marketNow);
        const { data: refreshed } = await supabase.from("paper_positions").select("*").eq("user_id", user.id).eq("position_status", "open").order("open_time", { ascending: true });
        positions = refreshed || positions;

        // ── SL/TP Hit Detection + Exit Flag Logic (Fix #9, #13) ──
        // Fetch live config once to allow global overrides (e.g. toggling maxHold off affects all open positions)
        let liveConfig: any = {};
        try {
          const { data: cfgRow } = await supabase.from("bot_configs").select("config_json").eq("user_id", user.id).is("connection_id", null).maybeSingle();
          liveConfig = cfgRow?.config_json || {};
        } catch {}
        runtimeManagementConfig = liveConfig;
        const closedIds: string[] = [];
        for (const pos of (positions || []).filter((candidate) =>
          isInstrumentMarketOpen(candidate.symbol, marketNow)
        )) {
          const currentPrice = parseFloat(pos.current_price);
          const entryPrice = parseFloat(pos.entry_price);
          let sl = pos.stop_loss ? parseFloat(pos.stop_loss) : null;
          const tp = pos.take_profit ? parseFloat(pos.take_profit) : null;
          let size = parseFloat(pos.size);
          let closeReason: string | null = null;
          let exitPrice = currentPrice;

          // Parse exit flags from signal_reason
          let signalData: any = {};
          try {
            signalData = JSON.parse(pos.signal_reason || "{}");
          } catch {}
          const columnExitFlags = pos.exit_flags && typeof pos.exit_flags === "object"
            ? pos.exit_flags
            : {};
          const exitFlags = { ...columnExitFlags, ...(signalData.exitFlags || {}) };
          const managementPolicy = resolvePositionManagementPolicy(
            { ...pos, exit_flags: exitFlags },
            runtimeManagementConfig,
          );

          // ── SL / TP hit detection — shared owner, see _shared/exitEvaluation.ts ──
          // This is the 5s poll path: it only holds a last price, so it passes a
          // zero-width bar and cannot see a wick that spikes through SL and
          // recovers between polls. bot-scanner re-evaluates the same positions
          // against a real closed bar every ~5 min and catches those, closing at
          // the correct gap-adjusted price. See PAPER_POLL_LIMITATION.
          //
          // close_reason on paper_positions is reused as an "sl state" tag while
          // the position is open: null/"" = original SL, "be" = break-even,
          // "trail" = trailing stop active.
          const slState: string = (pos.close_reason || "").toString();
          const spec = SPECS[pos.symbol] || SPECS["EUR/USD"];
          const exitDecision = evaluateExit(priceAsBar(currentPrice), {
            direction: pos.direction,
            stopLoss: sl,
            takeProfit: tp,
            pipSize: spec.pipSize,
            slippagePips: exitFlags.slippagePips ?? 0.5,
            slState,
          });
          if (exitDecision.hit) {
            closeReason = exitDecision.reason!;
            exitPrice = exitDecision.exitPrice!;
          }

          // Max Hold is owned by scannerManagement. It moves profitable trades to
          // protected entry; this polling path must not force-close the position.

          // Break-even activation: handled exclusively by scannerManagement (via bot-scanner manage cycle).
          // Paper-trading no longer independently activates BE to prevent race conditions.
          // Once scannerManagement sets breakEvenActivated=true + moves SL, this function sees the updated SL.

          // Trailing stop: FAST RATCHET only.
          // Activation is handled exclusively by scannerManagement. Paper-trading only ratchets
          // the SL forward every 5s once trailingStopActivated is already true.
          // Uses computeTrailRatchet() from exitEngine.ts — single source of truth for trail formula.
          const trailEnabled = managementPolicy.decision.trailingStopEnabled;
          const trailAlreadyActivated = exitFlags.trailingStopActivated === true;
          if (!closeReason && trailEnabled && trailAlreadyActivated && sl !== null) {
            const spec = SPECS[pos.symbol] || SPECS["EUR/USD"];
            const originalSl = Number(signalData.originalSL);
            const frozenRiskSl = Number.isFinite(originalSl) ? originalSl : sl;
            const riskPips = Math.abs(entryPrice - frozenRiskSl) / spec.pipSize;
            // Use the proportional trail distance stored by scannerManagement,
            // or fall back to max(configPips, 0.5 x riskPips).
            // NOTE: The Math.max floor below is intentionally kept even though
            // scannerManagement already applies the same floor before storing
            // trailingStopPips. Two reasons:
            //   1. Race-condition defense: paper-trading's ratchet runs on an
            //      irregular, frontend-polling-driven tick (not a guaranteed
            //      server cron), so it may read exitFlags before scannerManagement
            //      has written the floored value.
            //   2. Manual-override safety: per-trade config overrides can set
            //      trailingStopPips to a dangerously small value; this floor
            //      prevents the trail from being tighter than 50% of risk distance.
            const configuredTrailPips = managementPolicy.decision.trailingStopPips;
            const effectiveTrailPips = Math.max(
              configuredTrailPips,
              riskPips * 0.5,
            );
            const ratchet = computeTrailRatchet({
              entryPrice,
              currentPrice,
              currentSL: sl,
              direction: pos.direction as "long" | "short",
              pipSize: spec.pipSize,
              effectiveTrailPips,
              prevTrailLevel: exitFlags.trailingStopLevel ?? sl,
              // Paper-trading doesn't fetch candles — adaptive trail only runs in scannerManagement
              adaptiveTrailingEnabled: false,
            });
            if (ratchet.shouldTighten) {
              const ratchetedFlags = {
                ...exitFlags,
                trailingStopActivated: true,
                trailingStopLevel: ratchet.newSL,
                trailingStopPips: effectiveTrailPips,
              };
              await supabase.from("paper_positions").update({
                stop_loss: ratchet.newSL.toString(),
                close_reason: "trail",
                exit_flags: ratchetedFlags,
                signal_reason: JSON.stringify({ ...signalData, exitFlags: ratchetedFlags }),
              }).eq("id", pos.id);
              sl = ratchet.newSL;
              pos.close_reason = "trail";
              // Broker push removed: reconcileBrokerState() in bot-scanner's manage cycle
              // is the single broker-writer. It detects DB/broker SL mismatch and pushes.
              console.log(`Trail ratchet [${pos.position_id}]: SL→${ratchet.newSL.toFixed(5)} (${ratchet.trailDistancePips.toFixed(1)}p behind) | broker sync deferred to manage cycle`);
            }
          }

          // Partial take profit: handled exclusively by scannerManagement (Phase 1 consolidation).
          // scannerManagement does the full accounting (size reduction, history insert, balance update)
          // and pushes a "partial_tp_executed" action for bot-scanner to fire the broker partial close.
          // Paper-trading no longer independently activates partial-TP to prevent race conditions.

          // Close position if SL or TP triggered
          if (closeReason) {
            const pnlResult = calcPnl(pos.direction, entryPrice, exitPrice, size, pos.symbol, _rateMap);
            if (!pnlResult.valid) {
              console.error(
                `Auto-close refused [${pos.position_id}]: invalid P&L calculation (${pnlResult.reason})`,
              );
              continue;
            }
            const { pnl, pnlPips } = pnlResult;
            const closeBotId = pos.bot_id || "smc";
            if (!serviceSupabase) {
              console.error(
                `Auto-close refused [${pos.position_id}]: service authority is unavailable`,
              );
              continue;
            }
            const brokerClose = await reconcileFullBrokerClose({
              supabase: serviceSupabase,
              userId: user.id,
              botId: closeBotId,
              position: pos,
              route: "paper_auto_exit",
              closeReason,
            });
            if (!brokerClose.readyToFinalize) {
              console.warn(
                `Auto-close deferred [${pos.position_id}]: ${brokerClose.reason || brokerClose.state}`,
              );
              continue;
            }
            const finalization = await finalizePaperPositionClose(serviceSupabase, {
              positionRowId: pos.id,
              userId: user.id,
              botId: closeBotId,
              exitPrice,
              pnl,
              pnlPips,
              closeReason,
            });
            if (!finalization.closed) {
              console.log(`Auto-close skipped [${pos.position_id}]: ${finalization.code}`);
              continue;
            }
            if (finalization.balance !== undefined) account.balance = finalization.balance.toString();
            if (finalization.peak_balance !== undefined) account.peak_balance = finalization.peak_balance.toString();

            // Generate post-mortem
            const postMortem = generatePostMortem(pos, exitPrice, pnl, pnlPips, closeReason);
            await supabase.from("trade_post_mortems").insert({
              user_id: user.id, position_id: pos.position_id, symbol: pos.symbol,
              exit_reason: closeReason, exit_price: exitPrice.toString(), pnl: pnl.toFixed(2),
              what_worked: postMortem.whatWorked, what_failed: postMortem.whatFailed,
              lesson_learned: postMortem.lessonLearned, detail_json: postMortem,
            });

            closedIds.push(pos.id);

            await logClose(supabase, user.id, pos, {
              closeReason, closeSource: "auto_engine", pnl, exitPrice,
              extra: { brokerClose },
            });
          }
        }

        // Re-fetch positions after auto-closes
        if (closedIds.length > 0) {
          const { data: remaining, error: remainingReadError } = await supabase.from("paper_positions").select("*").eq("user_id", user.id).eq("position_status", "open").order("open_time", { ascending: true });
          if (remainingReadError) {
            return respond({
              ok: false,
              state: "unknown",
              executionMode: "unknown",
              error: "Open-position status is unavailable after closing positions: " + remainingReadError.message,
              code: "position_status_refresh_failed",
            }, 503);
          }
          positions = remaining;
          // Re-fetch account for updated balance
          const { data: updatedAccount, error: accountRefreshError } = await supabase.from("paper_accounts").select("*").eq("user_id", user.id).maybeSingle();
          if (accountRefreshError) {
            return respond({
              ok: false,
              state: "unknown",
              executionMode: "unknown",
              error: "Trading account status is unavailable after closing positions: " + accountRefreshError.message,
              code: "account_status_refresh_failed",
            }, 503);
          }
          if (updatedAccount) Object.assign(account, updatedAccount);
        }
      }
      const { data: pending, error: pendingReadError } = await supabase.from("paper_positions").select("*").eq("user_id", user.id).eq("position_status", "pending");
      const { data: history, error: historyReadError } = await supabase.from("paper_trade_history").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(500);
      // Fetch post-mortems for closed trades (keyed by position_id)
      const { data: postMortems, error: postMortemReadError } = await supabase.from("trade_post_mortems").select("position_id, what_worked, what_failed, lesson_learned, detail_json").eq("user_id", user.id).order("created_at", { ascending: false }).limit(500);
      const statusReadError = pendingReadError || historyReadError || postMortemReadError;
      if (statusReadError) {
        return respond({
          ok: false,
          state: "unknown",
          executionMode: "unknown",
          error: "Trading account history is unavailable: " + statusReadError.message,
          code: "account_history_read_failed",
        }, 503);
      }
      const pmByPosId: Record<string, any> = {};
      for (const pm of (postMortems || [])) { pmByPosId[pm.position_id] = pm; }

      const balance = parseFloat(account?.balance || "10000");
      const peakBalance = parseFloat(account?.peak_balance || "10000");
      const execMode = account?.execution_mode || "paper";
      const posArr = (positions || []).map((p: any) => {
        const mirroredIds: string[] = Array.isArray(p.mirrored_connection_ids) ? p.mirrored_connection_ids : [];
        // mirrorStatus is only meaningful in live mode. "mirrored" = trade is
        // linked to at least one broker; "orphan" = live mode but not linked
        // (typically because MetaAPI/OANDA was down/undeployed at open time,
        // so future SL/TP/reverse-close will NOT fan out to the broker).
        const mirrorStatus: "mirrored" | "orphan" | null =
          execMode === "live" ? (mirroredIds.length > 0 ? "mirrored" : "orphan") : null;
        return {
          id: p.position_id, symbol: p.symbol, direction: p.direction,
          size: parseFloat(p.size), entryPrice: parseFloat(p.entry_price),
          currentPrice: parseFloat(p.current_price),
          pnl: calcPnl(p.direction, parseFloat(p.entry_price), parseFloat(p.current_price), parseFloat(p.size), p.symbol, _rateMap).pnl,
          stopLoss: p.stop_loss ? parseFloat(p.stop_loss) : null,
          takeProfit: p.take_profit ? parseFloat(p.take_profit) : null,
          openTime: p.open_time, signalReason: p.signal_reason || "",
          signalScore: parseFloat(p.signal_score || "0"), orderId: p.order_id,
          botId: p.bot_id || "smc",
          mirroredConnectionIds: mirroredIds,
          mirrorStatus,
          tradeOverrides: parseTradeOverrides(p.trade_overrides),
          effectiveConfig: (() => {
            const policy = resolvePositionManagementPolicy(p, runtimeManagementConfig);
            return {
              ...policy.decision,
              partialTPPercent: policy.partialTPPercent,
              partialTPLevel: policy.partialTPLevel,
            };
          })(),
        };
      });
      const unrealizedPnl = posArr.reduce((s: number, p: any) => s + p.pnl, 0);
      const histArr = (history || []).map((t: any) => {
        const pm = pmByPosId[t.position_id] || null;
        return {
          id: t.position_id, symbol: t.symbol, direction: t.direction,
          size: parseFloat(t.size), entryPrice: parseFloat(t.entry_price),
          exitPrice: parseFloat(t.exit_price), pnl: parseFloat(t.pnl),
          pnlPips: parseFloat(t.pnl_pips), openTime: t.open_time,
          closedAt: t.closed_at, closeReason: t.close_reason,
          signalReason: t.signal_reason || "", signalScore: parseFloat(t.signal_score || "0"),
          orderId: t.order_id,
          botId: t.bot_id || "smc",
          stopLoss: t.stop_loss ? parseFloat(t.stop_loss) : null,
          takeProfit: t.take_profit ? parseFloat(t.take_profit) : null,
          postMortem: pm ? {
            whatWorked: pm.what_worked || null,
            whatFailed: pm.what_failed || null,
            lessonLearned: pm.lesson_learned || null,
            outcome: pm.detail_json?.outcome || null,
            holdDuration: pm.detail_json?.holdDuration || null,
            factorsPresent: pm.detail_json?.factorsPresent || [],
            factorsAbsent: pm.detail_json?.factorsAbsent || [],
          } : null,
        };
      });
      const wins = histArr.filter((t: any) => t.pnl > 0).length;
      const losses = histArr.filter((t: any) => t.pnl <= 0).length;
      const drawdown = peakBalance > 0 ? ((peakBalance - balance) / peakBalance) * 100 : 0;

      // Compute daily P&L from today's closed trades
      const todayStr = new Date().toISOString().split("T")[0];
      const dailyPnl = histArr
        .filter((t: any) => t.closedAt?.startsWith(todayStr))
        .reduce((s: number, t: any) => s + t.pnl, 0);

      // Build equity curve from trade history
      const equityCurve: { date: string; equity: number }[] = [];
      if (histArr.length > 0) {
        const sorted = [...histArr].sort((a: any, b: any) => (a.closedAt || "").localeCompare(b.closedAt || ""));
        // Use actual starting balance: current balance minus sum of all closed PnL
        const totalClosedPnl = sorted.reduce((s: number, t: any) => s + t.pnl, 0);
        let runningBalance = balance - totalClosedPnl;
        for (const t of sorted) {
          runningBalance += t.pnl;
          equityCurve.push({ date: t.closedAt, equity: runningBalance });
        }
      }

      return respond({
        ok: true, state: "available",
        balance, equity: balance + unrealizedPnl, unrealizedPnl,
        positions: posArr, pendingOrders: pending || [],
        tradeHistory: histArr, isRunning: account?.is_running || false,
        isPaused: account?.is_paused || false,
        startedAt: account?.started_at, totalTrades: histArr.length,
        winRate: histArr.length > 0 ? (wins / histArr.length) * 100 : 0,
        wins, losses, scanCount: account?.scan_count || 0,
        signalCount: account?.signal_count || 0,
        rejectedCount: account?.rejected_count || 0,
        executionMode: account?.execution_mode || "paper",
        killSwitchActive: account?.kill_switch_active || false,
        dailyPnl, drawdown, equityCurve,
        marginUsed: 0, freeMargin: balance + unrealizedPnl,
        marginLevel: 0, uptime: 0,
        strategy: {
          name: "SMC Default",
          winRate: histArr.length > 0 ? (wins / histArr.length) * 100 : 0,
          avgRR: 0, profitFactor: 0, expectancy: 0, maxDrawdown: drawdown,
        },
        log: [],
      });
    }

    // ── Place order ──
    if (action === "place_order") {
      const { symbol, direction, size, stopLoss, takeProfit, signalReason, signalScore } = payload;
      const { data: account, error: accountError } = await supabase.from("paper_accounts")
        .select("*").eq("user_id", user.id).maybeSingle();
      if (accountError) throw accountError;
      let executionMode = account?.execution_mode ?? "paper";
      if (!account) {
        const { data: createdAccount, error: accountInsertError } = await supabase
          .from("paper_accounts")
          .insert({ user_id: user.id, balance: "10000", peak_balance: "10000", daily_pnl_base: "10000" })
          .select("execution_mode")
          .single();
        if (accountInsertError) throw accountInsertError;
        executionMode = createdAccount?.execution_mode ?? "paper";
      }
      if (executionMode === "live") {
        return respond({
          success: false,
          error: "Manual live orders require the broker-first execution path. Switch to paper mode to place this order.",
          code: "manual_live_order_requires_broker_first",
        }, 409);
      }
      const positionId = crypto.randomUUID().slice(0, 8);
      const orderId = crypto.randomUUID().slice(0, 8);
      const now = new Date().toISOString();
      let entryPrice = payload.entryPrice || 0;

      // For market orders with no entry price, fetch live price
      if (!entryPrice || entryPrice === 0) {
        const livePrice = await fetchLivePrice(symbol);
        if (livePrice) {
          entryPrice = livePrice;
        } else {
          throw new Error("Could not fetch live price for " + symbol);
        }
      }

      // ── Enforce minimum SL distance (two-layer floor, matching bot-scanner) ──
      // Layer 1: Per-instrument static floor (MIN_SL_PIPS)
      // Layer 2: Dynamic ATR-based floor (adapts to current volatility)
      let adjustedSL = stopLoss;
      let adjustedTP = takeProfit;
      if (adjustedSL != null && entryPrice > 0) {
        const spec = SPECS[symbol];
        if (spec) {
          const staticMinSlPips = MIN_SL_PIPS[symbol] ?? 15;
          // Fetch ATR for dynamic floor (returns 0 if unavailable — graceful degradation)
          const atrVal = await fetchATR(symbol);
          const atrFloorPips = atrVal > 0 ? (atrVal * ATR_SL_FLOOR_MULTIPLIER) / spec.pipSize : 0;
          // Use whichever floor is larger
          const effectiveMinSlPips = Math.max(staticMinSlPips, atrFloorPips);
          const minSlDistance = effectiveMinSlPips * spec.pipSize;
          const actualSlDistance = Math.abs(entryPrice - adjustedSL);
          if (actualSlDistance < minSlDistance) {
            const floorSource = atrFloorPips > staticMinSlPips ? `ATR(${atrFloorPips.toFixed(1)}p)` : `static(${staticMinSlPips}p)`;
            console.log(`[paper-trading][${symbol}] SL too tight: ${(actualSlDistance / spec.pipSize).toFixed(1)} pips < min ${effectiveMinSlPips.toFixed(1)} pips [${floorSource}]. Widening SL.`);
            if (direction === "long") {
              adjustedSL = entryPrice - minSlDistance;
            } else {
              adjustedSL = entryPrice + minSlDistance;
            }
            // Recalculate TP based on widened SL if TP exists (preserve original R:R)
            if (adjustedTP != null) {
              const newRisk = Math.abs(entryPrice - adjustedSL);
              const originalRR = takeProfit != null && stopLoss != null && Math.abs(entryPrice - stopLoss) > 0
                ? Math.abs(takeProfit - entryPrice) / Math.abs(entryPrice - stopLoss)
                : 2.0; // default 2:1 R:R
              adjustedTP = direction === "long"
                ? entryPrice + newRisk * originalRR
                : entryPrice - newRisk * originalRR;
            }
          }
        }
      }

      const { error: positionInsertError } = await supabase.from("paper_positions").insert({
        user_id: user.id, position_id: positionId, symbol, direction, size: size.toString(),
        entry_price: entryPrice.toString(), current_price: entryPrice.toString(),
        stop_loss: adjustedSL?.toString() || null, take_profit: adjustedTP?.toString() || null,
        open_time: now, signal_reason: signalReason || "", signal_score: (signalScore || 0).toString(),
        order_id: orderId, position_status: "open",
      });
      if (positionInsertError) throw positionInsertError;

      return respond({ success: true, positionId, orderId });
    }

    // ── Update SL/TP on an open position ──
    if (action === "update_position") {
      const { positionId } = payload;
      const slRaw = payload.stopLoss;
      const tpRaw = payload.takeProfit;
      const { data: pos } = await supabase.from("paper_positions").select("*")
        .eq("user_id", user.id).eq("position_id", positionId).maybeSingle();
      if (!pos) throw new Error("Position not found");

      const updates: Record<string, any> = {};
      const parseLevel = (v: any) => {
        if (v === null || v === "" || v === undefined) return null;
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : undefined;
      };
      if (slRaw !== undefined) {
        const v = parseLevel(slRaw);
        if (v === undefined) throw new Error("Invalid stopLoss");
        updates.stop_loss = v === null ? null : v.toString();
      }
      if (tpRaw !== undefined) {
        const v = parseLevel(tpRaw);
        if (v === undefined) throw new Error("Invalid takeProfit");
        updates.take_profit = v === null ? null : v.toString();
      }

      // Sanity check vs entry/direction (warn-but-allow via error for clearly invalid)
      const entry = parseFloat(pos.entry_price);
      const isLong = pos.direction === "long";
      if (updates.stop_loss && updates.stop_loss !== null) {
        const sl = parseFloat(updates.stop_loss);
        if (isLong && sl >= entry) throw new Error("Stop loss must be below entry for long");
        if (!isLong && sl <= entry) throw new Error("Stop loss must be above entry for short");
      }
      if (updates.take_profit && updates.take_profit !== null) {
        const tp = parseFloat(updates.take_profit);
        if (isLong && tp <= entry) throw new Error("Take profit must be above entry for long");
        if (!isLong && tp >= entry) throw new Error("Take profit must be below entry for short");
      }

      // ── Per-Trade Management Overrides ──
      // Accepts tradeOverrides object to override global config for this specific trade.
      // Supported fields: breakEvenEnabled, breakEvenPips, trailingStopEnabled, trailingStopPips,
      //   trailingStopActivation, partialTPEnabled, partialTPPercent, partialTPLevel,
      //   maxHoldEnabled, maxHoldHours
      // Pass null to clear all overrides (revert to global config).
      if (payload.tradeOverrides !== undefined) {
        if (payload.tradeOverrides === null) {
          updates.trade_overrides = null; // Clear overrides — revert to global config
        } else {
          const booleanKeys = new Set([
            'breakEvenEnabled', 'trailingStopEnabled',
            'partialTPEnabled', 'maxHoldEnabled',
          ]);
          const numericBounds: Record<string, [number, number]> = {
            breakEvenPips: [1, 1000],
            breakEvenOffsetPips: [0, 100],
            trailingStopPips: [1, 1000],
            partialTPPercent: [10, 90],
            partialTPLevel: [0.5, 5],
            maxHoldHours: [1, 720],
          };
          const activationValues = new Set([
            'immediate', 'after_0.5r', 'after_1r', 'after_1.5r', 'after_2r',
          ]);
          const allowedKeys = new Set([
            ...booleanKeys,
            ...Object.keys(numericBounds),
            'trailingStopActivation',
          ]);
          const sanitized: Record<string, any> = {};
          for (const [key, rawValue] of Object.entries(payload.tradeOverrides)) {
            if (!allowedKeys.has(key)) throw new Error(`Unsupported trade override: ${key}`);
            if (booleanKeys.has(key)) {
              if (typeof rawValue !== 'boolean') throw new Error(`${key} must be true or false`);
              sanitized[key] = rawValue;
              continue;
            }
            if (key === 'trailingStopActivation') {
              if (typeof rawValue !== 'string' || !activationValues.has(rawValue)) {
                throw new Error('Invalid trailing stop activation');
              }
              sanitized[key] = rawValue;
              continue;
            }
            const value = Number(rawValue);
            const [minimum, maximum] = numericBounds[key];
            if (!Number.isFinite(value) || value < minimum || value > maximum) {
              throw new Error(`${key} must be between ${minimum} and ${maximum}`);
            }
            sanitized[key] = value;
          }
          // Merge with existing overrides (don't wipe fields not included in this update)
          const existing = pos.trade_overrides
            ? (typeof pos.trade_overrides === 'string' ? JSON.parse(pos.trade_overrides) : pos.trade_overrides)
            : {};
          updates.trade_overrides = JSON.stringify({ ...existing, ...sanitized });
        }
      }

      if (Object.keys(updates).length === 0) return respond({ success: true, unchanged: true });

      const { data: updated, error: updErr } = await supabase
        .from("paper_positions")
        .update(updates)
        .eq("id", pos.id)
        .select()
        .single();
      if (updErr) throw updErr;
      // Return resolved effective config so frontend can update immediately without refetch
      const updatedOverrides = parseTradeOverrides(updated.trade_overrides);
      let updGlobalCfg: any = {};
      try {
        const { data: _cfgRow } = await supabase.from("bot_configs").select("config_json").eq("user_id", user.id).is("connection_id", null).maybeSingle();
        updGlobalCfg = _cfgRow?.config_json || {};
      } catch {}
      const updatedPolicy = resolvePositionManagementPolicy(updated, updGlobalCfg);
      const updEffectiveConfig = {
        ...updatedPolicy.decision,
        partialTPPercent: updatedPolicy.partialTPPercent,
        partialTPLevel: updatedPolicy.partialTPLevel,
      };
      return respond({ success: true, position: updated, tradeOverrides: updatedOverrides, effectiveConfig: updEffectiveConfig });
    }

    // ── Close position ──
    if (action === "close_position") {
      const { positionId, exitPrice } = payload;
      const { data: pos } = await supabase.from("paper_positions").select("*")
        .eq("user_id", user.id).eq("position_id", positionId).single();
      if (!pos) throw new Error("Position not found");

      const ep = Number(exitPrice || pos.current_price);
      const pnlResult = calcPnl(pos.direction, parseFloat(pos.entry_price), ep, parseFloat(pos.size), pos.symbol, _rateMap);
      if (!pnlResult.valid) {
        return respond({
          success: false,
          code: "invalid_pnl_inputs",
          error: `Position cannot be closed until its accounting inputs are repaired (${pnlResult.reason})`,
        }, 422);
      }
      const { pnl, pnlPips } = pnlResult;
      const closeReason = payload.reason || "manual";

      if (!serviceSupabase) {
        return respond({
          success: false,
          code: "service_authority_unavailable",
          error: "Broker close authority is unavailable; the position remains open",
        }, 503);
      }
      const brokerClose = await reconcileFullBrokerClose({
        supabase: serviceSupabase,
        userId: user.id,
        botId: pos.bot_id || "smc",
        position: pos,
        route: "manual_close",
        closeReason,
      });
      if (brokerClose.state === "already_resolved") {
        return respond({
          success: true,
          alreadyClosed: true,
          code: "already_resolved",
          brokerClose,
        });
      }
      if (!brokerClose.readyToFinalize) {
        return respond({
          success: false,
          code: "broker_close_reconciliation_required",
          error: brokerClose.reason || "Exact broker closure is not confirmed",
          brokerClose,
        }, 409);
      }

      const finalization = await finalizePaperPositionClose(serviceSupabase, {
        positionRowId: pos.id,
        userId: user.id,
        botId: pos.bot_id || "smc",
        exitPrice: ep,
        pnl,
        pnlPips,
        closeReason,
      });
      if (!finalization.closed) {
        if (finalization.code === "already_resolved") {
          return respond({ success: true, alreadyClosed: true, code: finalization.code });
        }
        return respond({
          success: false,
          code: finalization.code,
          error: finalization.reason || "Internal close finalization failed",
          brokerClose,
        }, 409);
      }

      // Generate post-mortem
      const postMortem = generatePostMortem(pos, ep, pnl, pnlPips, closeReason);
      await supabase.from("trade_post_mortems").insert({
        user_id: user.id,
        position_id: pos.position_id,
        symbol: pos.symbol,
        exit_reason: closeReason,
        exit_price: ep.toString(),
        pnl: pnl.toString(),
        what_worked: postMortem.whatWorked,
        what_failed: postMortem.whatFailed,
        lesson_learned: postMortem.lessonLearned,
        detail_json: postMortem,
      });

      await logClose(supabase, user.id, pos, {
        closeReason,
        closeSource: "user",
        pnl,
        exitPrice: ep,
        extra: { brokerClose },
      });

      return respond({ success: true, pnl, pnlPips, postMortem, brokerClose });
    }

    // ── Engine controls ──
    if (action === "start_engine") {
      await ensureAccount(supabase, user.id);
      await supabase.from("paper_accounts").update({ is_running: true, is_paused: false, started_at: new Date().toISOString() }).eq("user_id", user.id);
      return respond({ success: true });
    }
    if (action === "pause_engine") {
      await supabase.from("paper_accounts").update({ is_paused: true }).eq("user_id", user.id);
      return respond({ success: true });
    }
    if (action === "stop_engine") {
      await supabase.from("paper_accounts").update({ is_running: false, is_paused: false }).eq("user_id", user.id);
      return respond({ success: true });
    }
    if (action === "kill_switch") {
      const active = payload.active;
      if (active) {
        const halt = await persistPaperEngineHalt(supabase, user.id, {
          paused: false,
          killSwitchActive: true,
        });
        if (!halt.ok) {
          return respond({
            success: false,
            code: "kill_switch_activation_failed",
            error: halt.error,
          }, 500);
        }
        if (!serviceSupabase) {
          return respond({
            success: false,
            code: "service_authority_unavailable",
            error: "Kill switch is active, but broker close authority is unavailable",
          }, 503);
        }
        // Close all open positions
        const { data: positions, error: positionsError } = await supabase.from("paper_positions").select("*")
          .eq("user_id", user.id).eq("position_status", "open");
        if (positionsError) {
          return respond({
            success: false,
            code: "kill_switch_position_read_failed",
            error:
              `Kill switch is active, but open positions could not be verified: ${positionsError.message}`,
          }, 503);
        }
        const unresolvedBrokerCloses: Array<Record<string, unknown>> = [];
        if (positions && positions.length > 0) {
          for (const pos of positions) {
            const ep = parseFloat(pos.current_price);
            const pnlResult = calcPnl(pos.direction, parseFloat(pos.entry_price), ep, parseFloat(pos.size), pos.symbol, _rateMap);
            if (!pnlResult.valid) {
              console.error(
                `Kill-switch accounting refused [${pos.position_id}]: invalid P&L calculation (${pnlResult.reason})`,
              );
              unresolvedBrokerCloses.push({
                positionId: pos.position_id,
                reason: `invalid_pnl_inputs:${pnlResult.reason}`,
              });
              continue;
            }
            const { pnl, pnlPips } = pnlResult;
            const brokerClose = await reconcileFullBrokerClose({
              supabase: serviceSupabase,
              userId: user.id,
              botId: pos.bot_id || "smc",
              position: pos,
              route: "kill_switch",
              closeReason: "kill_switch",
            });
            if (!brokerClose.readyToFinalize) {
              if (brokerClose.state !== "already_resolved") {
                unresolvedBrokerCloses.push({
                  positionId: pos.position_id,
                  reason: brokerClose.reason || brokerClose.state,
                  brokerClose,
                });
              }
              continue;
            }
            const finalization = await finalizePaperPositionClose(serviceSupabase, {
              positionRowId: pos.id,
              userId: user.id,
              botId: pos.bot_id || "smc",
              exitPrice: ep,
              pnl,
              pnlPips,
              closeReason: "kill_switch",
            });
            if (!finalization.closed) {
              console.log(`Kill-switch close skipped [${pos.position_id}]: ${finalization.code}`);
              if (finalization.code !== "already_resolved") {
                unresolvedBrokerCloses.push({
                  positionId: pos.position_id,
                  reason: finalization.reason || finalization.code,
                });
              }
              continue;
            }

            const postMortem = generatePostMortem(pos, ep, pnl, pnlPips, "kill_switch");
            await supabase.from("trade_post_mortems").insert({
              user_id: user.id, position_id: pos.position_id, symbol: pos.symbol,
              exit_reason: "kill_switch", exit_price: ep.toString(), pnl: pnl.toString(),
              what_worked: postMortem.whatWorked, what_failed: postMortem.whatFailed,
              lesson_learned: postMortem.lessonLearned, detail_json: postMortem,
            });
            await logClose(supabase, user.id, pos, {
              closeReason: "kill_switch",
              closeSource: "kill_switch",
              pnl,
              exitPrice: ep,
              extra: { brokerClose },
            });
          }


        }
        if (unresolvedBrokerCloses.length > 0) {
          return respond({
            success: false,
            code: "broker_close_reconciliation_required",
            error: `${unresolvedBrokerCloses.length} position(s) remain open until broker closure is proven`,
            unresolvedBrokerCloses,
          }, 409);
        }
      } else {
        await supabase.from("paper_accounts").update({ kill_switch_active: false }).eq("user_id", user.id);
      }
      return respond({ success: true });
    }

    // Helper: read configured starting balance from bot_configs (falls back to 10000)
    async function getConfiguredStartingBalance(): Promise<string> {
      try {
        const { data: cfgRow } = await supabase.from("bot_configs").select("config_json")
          .eq("user_id", user.id).is("connection_id", null).maybeSingle();
        const bal = cfgRow?.config_json?.account?.startingBalance;
        if (typeof bal === "number" && bal > 0) return bal.toFixed(2);
      } catch (_) { /* ignore — fall back to default */ }
      return "10000";
    }

    // ── Set Balance: set account balance to any custom amount ──
    if (action === "set_balance") {
      const newBalance = parseFloat(payload.balance);
      if (isNaN(newBalance) || newBalance < 0) {
        return respond({ error: "Invalid balance amount" });
      }
      const balStr = newBalance.toFixed(2);
      // Reset peak_balance to the new balance — this is a fresh starting point
      // Prevents drawdown gate from triggering (e.g., setting $100 with old peak of $10k = 99% drawdown)
      const todayDate = new Date().toISOString().split("T")[0];
      await supabase.from("paper_accounts").update({
        balance: balStr, peak_balance: balStr, daily_pnl_base: balStr,
        daily_pnl_base_date: todayDate, kill_switch_active: false,
      }).eq("user_id", user.id);
      return respond({ success: true, balance: balStr });
    }

    // ── Reset Balance Only: preserves positions, trade history, scan logs, reasonings, post-mortems ──
    if (action === "reset_balance_only") {
      const startBal = await getConfiguredStartingBalance();
      const todayDate = new Date().toISOString().split("T")[0];
      await supabase.from("paper_accounts").update({
        balance: startBal, peak_balance: startBal, daily_pnl_base: startBal,
        daily_pnl_base_date: todayDate, scan_count: 0, signal_count: 0, rejected_count: 0,
        kill_switch_active: false,
      }).eq("user_id", user.id);
      return respond({ success: true, startingBalance: startBal });
    }

    // ── Full Reset: wipes everything and resets balance to configured starting balance ──
    if (action === "reset_account") {
      const startBal = await getConfiguredStartingBalance();
      const todayDate = new Date().toISOString().split("T")[0];
      const halt = await persistPaperEngineHalt(supabase, user.id, {
        paused: true,
      });
      if (!halt.ok) {
        return respond({
          success: false,
          code: "account_reset_halt_failed",
          error: halt.error,
        }, 500);
      }
      const { data: positionsToReset, error: resetReadError } = await supabase
        .from("paper_positions")
        .select("*")
        .eq("user_id", user.id)
        .in("position_status", ["open", "pending"]);
      if (resetReadError) throw resetReadError;
      if ((positionsToReset || []).length > 0 && !serviceSupabase) {
        return respond({
          success: false,
          code: "service_authority_unavailable",
          error: "Account reset refused because broker close authority is unavailable",
        }, 503);
      }
      const resetBrokerCloses = [];
      for (const position of positionsToReset || []) {
        const brokerClose = await reconcileFullBrokerClose({
          supabase: serviceSupabase!,
          userId: user.id,
          botId: position.bot_id || "smc",
          position,
          route: "account_reset",
          closeReason: "account_reset",
        });
        resetBrokerCloses.push({
          positionId: position.position_id,
          ...brokerClose,
        });
      }
      const unresolved = resetBrokerCloses.filter((result) =>
        !result.readyToFinalize && result.state !== "already_resolved"
      );
      if (unresolved.length > 0) {
        return respond({
          success: false,
          code: "broker_close_reconciliation_required",
          error: "Account reset refused while broker exposure remains unresolved",
          unresolvedBrokerCloses: unresolved,
        }, 409);
      }
      await supabase.from("paper_positions").delete().eq("user_id", user.id);
      await supabase.from("paper_trade_history").delete().eq("user_id", user.id);
      await supabase.from("trade_reasonings").delete().eq("user_id", user.id);
      await supabase.from("trade_post_mortems").delete().eq("user_id", user.id);
      await supabase.from("scan_logs").delete().eq("user_id", user.id);
      await supabase.from("trades").delete().eq("user_id", user.id);
      await supabase.from("paper_accounts").update({
        balance: startBal, peak_balance: startBal, is_running: false, is_paused: true,
        scan_count: 0, signal_count: 0, rejected_count: 0, daily_pnl_base: startBal,
        daily_pnl_base_date: todayDate, kill_switch_active: false, execution_mode: "paper",
      }).eq("user_id", user.id);
      return respond({
        success: true,
        startingBalance: startBal,
        paused: true,
        brokerClose: resetBrokerCloses,
      });
    }

    if (action === "set_execution_mode") {
      const requestedMode = payload.mode;
      if (requestedMode !== "paper" && requestedMode !== "live") {
        return respond({
          error: "Execution mode must be either paper or live",
          code: "invalid_execution_mode",
        }, 400);
      }

      await ensureAccount(supabase, user.id);
      const { data: currentAccount, error: accountReadError } = await supabase
        .from("paper_accounts")
        .select("execution_mode")
        .eq("user_id", user.id)
        .maybeSingle();
      if (accountReadError) {
        return respond({
          error: `Could not read execution mode: ${accountReadError.message}`,
          code: "execution_mode_read_failed",
        }, 500);
      }
      if (!currentAccount) {
        return respond({
          error: "Trading account is unavailable",
          code: "account_missing",
        }, 404);
      }
      if (currentAccount.execution_mode === requestedMode) {
        return respond({
          success: true,
          executionMode: currentAccount.execution_mode,
          unchanged: true,
        });
      }

      if (requestedMode === "live") {
        const { data: activeBroker, error: brokerReadError } = await supabase
          .from("broker_connections")
          .select("id")
          .eq("user_id", user.id)
          .eq("is_active", true)
          .limit(1)
          .maybeSingle();
        if (brokerReadError) {
          return respond({
            error: `Could not verify broker connection: ${brokerReadError.message}`,
            code: "broker_verification_failed",
          }, 500);
        }
        if (!activeBroker) {
          return respond({
            error: "Connect and activate a broker before switching to live mode",
            code: "active_broker_required",
          }, 409);
        }
      }

      if (requestedMode === "paper") {
        const { data: openPosition, error: positionReadError } = await supabase
          .from("paper_positions")
          .select("id")
          .eq("user_id", user.id)
          .eq("position_status", "open")
          .limit(1)
          .maybeSingle();
        if (positionReadError) {
          return respond({
            error: `Could not verify open positions: ${positionReadError.message}`,
            code: "position_verification_failed",
          }, 500);
        }
        if (openPosition) {
          return respond({
            error: "Close all open positions before switching to paper mode",
            code: "open_positions_require_live_management",
          }, 409);
        }
      }

      const { data: persistedAccount, error: modeUpdateError } = await supabase
        .from("paper_accounts")
        .update({ execution_mode: requestedMode })
        .eq("user_id", user.id)
        .select("execution_mode")
        .maybeSingle();
      if (modeUpdateError) {
        return respond({
          error: `Execution mode was not saved: ${modeUpdateError.message}`,
          code: "execution_mode_update_failed",
        }, 500);
      }
      if (!persistedAccount) {
        return respond({
          error: "Execution mode update did not affect a trading account",
          code: "execution_mode_not_persisted",
        }, 409);
      }
      if (persistedAccount.execution_mode !== requestedMode) {
        return respond({
          error: `Execution mode verification failed: database returned ${persistedAccount.execution_mode}`,
          code: "execution_mode_verification_failed",
        }, 409);
      }
      return respond({
        success: true,
        executionMode: persistedAccount.execution_mode,
      });
    }

    return respond({ error: "Unknown action" });
  } catch (error: any) {
    // An expired/invalid JWT surfacing from a downstream PostgREST call must be
    // reported as 401 so the client refreshes the session instead of treating
    // it as a server fault (which left the dashboard on a blank screen).
    const msg = String(error?.message ?? "");
    if (/jwt|token is expired|invalid claim/i.test(msg)) {
      return new Response(JSON.stringify({ error: "Unauthorized", code: "invalid_jwt", details: msg }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function ensureAccount(supabase: any, userId: string) {
  const { data } = await supabase.from("paper_accounts").select("id").eq("user_id", userId).maybeSingle();
  if (!data) {
    await supabase.from("paper_accounts").insert({ user_id: userId, balance: "10000", peak_balance: "10000", daily_pnl_base: "10000" });
  }
}

async function persistPaperEngineHalt(
  supabase: any,
  userId: string,
  options: { paused: boolean; killSwitchActive?: boolean },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const updates: Record<string, boolean> = {
    is_running: false,
    is_paused: options.paused,
  };
  if (options.killSwitchActive !== undefined) {
    updates.kill_switch_active = options.killSwitchActive;
  }
  try {
    const { data, error } = await supabase.from("paper_accounts")
      .update(updates)
      .eq("user_id", userId)
      .select("is_running,is_paused,kill_switch_active")
      .maybeSingle();
    if (error) {
      return { ok: false, error: error.message || String(error) };
    }
    if (!data) {
      return { ok: false, error: "Trading account was not found" };
    }
    if (data.is_running !== false || data.is_paused !== options.paused) {
      return { ok: false, error: "Engine halt was not persisted" };
    }
    if (
      options.killSwitchActive !== undefined &&
      data.kill_switch_active !== options.killSwitchActive
    ) {
      return { ok: false, error: "Kill-switch state was not persisted" };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function respond(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
