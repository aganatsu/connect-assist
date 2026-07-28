/**
 * Zone Confirmation Scanner (1-minute cron)
 *
 * Lightweight edge function that ONLY processes pending orders in "awaiting_confirmation"
 * status. Runs every 60 seconds to provide near-real-time CHoCH detection for zone setups
 * that are actively hunting for 5m confirmation.
 *
 * This function does NOT run the full scan — it only:
 * 1. Queries pending_orders with status = "awaiting_confirmation"
 * 2. Fetches fresh 5m candles for those specific pairs
 * 3. Checks if price left the zone (reset to pending)
 * 4. Checks for impulse invalidation (cancel)
 * 5. Runs CHoCH detection
 * 6. If confirmed → enters the trade (paper_positions + broker mirror)
 *
 * The main bot-scanner still handles the full lifecycle (zone touch detection,
 * expiry, thesis validation, etc.). This function is a fast-poll supplement
 * that reduces confirmation latency from ~5-10 min to ~60 seconds.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchCandlesWithFallback, type BrokerConn } from "../_shared/candleSource.ts";
import {
  SPECS,
  type Candle,
} from "../_shared/smcAnalysis.ts";
import {
  detectZoneConfirmation,
  isPriceInZone,
  isImpulseBroken,
  formatConfirmationSummary,
  DEFAULT_ZONE_CONFIRMATION_CONFIG,
} from "../_shared/zoneConfirmation.ts";
import { resolveSymbol } from "../_shared/brokerSymbols.ts";
import { metaFetch } from "../_shared/metaApiClient.ts";
import { verifyCronCaller } from "../_shared/cronAuth.ts";
import { mapNestedToFlat, type RuntimeConfig } from "../_shared/configMapper.ts";
import { checkIndicatorConfirmation } from "../_shared/indicatorConfirmation.ts";
import {
  evaluateFinalTradeAuthorization,
  type DirectionVerdictForAuthorization,
} from "../_shared/finalTradeAuthorization.ts";
import {
  validatePendingOrderThesis,
  type ThesisValidationResult,
} from "../_shared/thesisValidator.ts";
import { runPropFirmGate, type PropFirmGateResult } from "../_shared/propFirmGate.ts";
import type { SessionGamePlan } from "../_shared/gamePlan.ts";

// ─── Constants ──────────────────────────────────────────────────────────────────
const BOT_ID = "smc";
// metaFetch + resolveSymbol are now imported from ../_shared/ (single source of truth)

// ─── Candle Fetching ────────────────────────────────────────────────────────

async function fetchCandles(
  symbol: string,
  interval = "5m",
  brokerConn: BrokerConn | null = null,
  limit = 100,
): Promise<Candle[]> {
  const result = await fetchCandlesWithFallback({
    symbol,
    interval,
    limit,
    brokerConn,
  });
  return result.candles;
}

function parseSessionGamePlan(row: any): SessionGamePlan | null {
  const cached = row?.details_json;
  if (!cached || cached.type !== "game_plan") return null;
  return {
    session: cached.session,
    generatedAt: cached.generated_at,
    plans: cached.plans || [],
    focusPairs: cached.focus_pairs || [],
    newsEvents: cached.newsEvents || [],
    summary: cached.summary || "",
  } as SessionGamePlan;
}

function findCurrentDirectionVerdict(
  recentScanLogs: any[],
  symbol: string,
): DirectionVerdictForAuthorization | null {
  for (const log of recentScanLogs || []) {
    const details = log?.details_json;
    if (!Array.isArray(details)) continue;
    const pairDetail = details.find((detail: any) => detail?.pair === symbol || detail?.symbol === symbol);
    const verdict = pairDetail?.directionVerdict;
    if (verdict && typeof verdict === "object") {
      return {
        verdict: verdict.effectiveDirection ?? verdict.verdict ?? null,
        shouldBlock: verdict.shouldBlock ?? verdict.directionSource === "blocked",
        blockReason: verdict.blockReason ?? verdict.summary ?? null,
        confidence: verdict.confidence ?? null,
      };
    }
  }
  return null;
}

// ─── Spread Check (for broker mirroring) ────────────────────────────────────

async function fetchBrokerSpread(
  conn: any,
  pair: string,
  config: { spreadFilterEnabled: boolean; maxSpreadPips: number },
  metaAccountId?: string,
  authToken?: string,
): Promise<{ bid: number; ask: number; spreadPips: number; passed: boolean; effectiveMax: number } | null> {
  const pairSpec = SPECS[pair] || SPECS["EUR/USD"];
  const effectiveMax = config.maxSpreadPips > 0 ? config.maxSpreadPips : pairSpec.maxSpread;
  try {
    let bid = 0, ask = 0;
    if (conn.broker_type === "oanda") {
      const oandaBase = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
      const oandaSym = resolveSymbol(pair, conn).replace(/([A-Z]{3})([A-Z]{3})/, "$1_$2");
      const priceRes = await fetch(
        `${oandaBase}/v3/accounts/${conn.account_id}/pricing?instruments=${encodeURIComponent(oandaSym)}`,
        { headers: { Authorization: `Bearer ${conn.api_key}` } },
      );
      if (!priceRes.ok) return null;
      const priceData: any = await priceRes.json();
      const pricing = priceData.prices?.[0];
      if (!pricing) return null;
      bid = parseFloat(pricing.bids?.[0]?.price ?? "0");
      ask = parseFloat(pricing.asks?.[0]?.price ?? "0");
    } else if (conn.broker_type === "metaapi" && metaAccountId && authToken) {
      const brokerSymbol = resolveSymbol(pair, conn);
      const { res: priceRes, body: priceBody } = await metaFetch(
        metaAccountId, authToken,
        (base) => `${base}/symbols/${encodeURIComponent(brokerSymbol)}/current-price`,
      );
      if (!priceRes.ok) return null;
      const priceData: any = JSON.parse(priceBody);
      bid = priceData.bid ?? 0;
      ask = priceData.ask ?? 0;
    } else {
      return null;
    }
    if (bid <= 0 || ask <= 0) return null;
    const spreadPips = (ask - bid) / pairSpec.pipSize;
    const passed = !config.spreadFilterEnabled || spreadPips <= effectiveMax;
    return { bid, ask, spreadPips, passed, effectiveMax };
  } catch {
    return null;
  }
}

// ─── Main Handler ───────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // Gate 0: Only the cron scheduler may invoke this function.
  const authError = verifyCronCaller(req);
  if (authError) return authError;

  const startTime = Date.now();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // ── 1. Query all orders in "awaiting_confirmation" status ──
    const { data: huntingOrders, error: queryErr } = await supabase
      .from("pending_orders")
      .select("*")
      .eq("bot_id", BOT_ID)
      .eq("status", "awaiting_confirmation")
      .order("placed_at", { ascending: true });

    if (queryErr) {
      console.error("[zone-confirm] Query error:", queryErr.message);
      return new Response(JSON.stringify({ error: queryErr.message }), { status: 500 });
    }

    if (!huntingOrders || huntingOrders.length === 0) {
      // Nothing to do — no orders are hunting for confirmation
      return new Response(JSON.stringify({
        status: "idle",
        message: "No orders awaiting confirmation",
        elapsed_ms: Date.now() - startTime,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    console.log(`[zone-confirm] Processing ${huntingOrders.length} order(s) awaiting confirmation`);

    // ── 2. Get unique user IDs to load their configs and broker connections ──
    const userIds = [...new Set(huntingOrders.map(o => o.user_id))];

    // Load user settings (for telegram) and broker connections per user
    const userDataMap: Record<string, {
      telegramChatIds: string[];
      brokerConnections: any[];
      brokerConn: BrokerConn | null;
      openPositions: any[];
      account: any | null;
      config: RuntimeConfig;
      rawConfig: any;
      gamePlan: SessionGamePlan | null;
      recentScanLogs: any[];
    }> = {};

    for (const userId of userIds) {
      // Telegram chat IDs
      const { data: userSettings } = await supabase
        .from("user_settings").select("preferences_json")
        .eq("user_id", userId).maybeSingle();
      const prefs = (userSettings?.preferences_json as any) || {};
      const telegramChatIds: string[] = (() => {
        const list = Array.isArray(prefs.telegramChatIds) ? prefs.telegramChatIds : [];
        const ids = list.map((c: any) => typeof c === "string" ? c : String(c?.id ?? "")).filter(Boolean);
        if (ids.length > 0) return ids;
        return prefs.telegramChatId ? [String(prefs.telegramChatId)] : [];
      })();

      // Broker connections
      const { data: connections } = await supabase
        .from("broker_connections").select("*")
        .eq("user_id", userId).in("broker_type", ["metaapi", "oanda"]).eq("is_active", true);

      // Open positions (for max position checks)
      const { data: openPositions } = await supabase
        .from("paper_positions").select("*")
        .eq("user_id", userId).eq("position_status", "open");

      // Bot account
      const { data: account } = await supabase
        .from("paper_accounts").select("*")
        .eq("user_id", userId).eq("bot_id", BOT_ID).maybeSingle();

      // Bot config
      const { data: botConfig } = await supabase
        .from("bot_configs").select("config_json")
        .eq("user_id", userId).eq("bot_id", BOT_ID).maybeSingle();

      // Keep the candle connection scoped to this user. A module-global
      // connection can leak the last loaded user's feed into another account.
      const metaConn = (connections || []).find((c: any) => c.broker_type === "metaapi");
      let brokerConn: BrokerConn | null = null;
      if (metaConn) {
        let authToken = metaConn.api_key;
        let metaAccountId = metaConn.account_id;
        if (metaAccountId?.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
          authToken = metaConn.account_id;
          metaAccountId = metaConn.api_key;
        }
        brokerConn = { api_key: authToken, account_id: metaAccountId };
      }

      // Load the latest active Game Plan directly, then recent completed scan
      // evidence for the current Direction Verdict. Do not rely on the latest
      // 20 arbitrary rows to contain a Game Plan.
      const { data: gamePlanRows } = await supabase
        .from("scan_logs")
        .select("created_at, details_json")
        .eq("user_id", userId)
        .eq("bot_id", BOT_ID)
        .contains("details_json", { type: "game_plan" })
        .order("created_at", { ascending: false })
        .limit(1);
      const { data: recentScanLogs } = await supabase
        .from("scan_logs")
        .select("created_at, details_json")
        .eq("user_id", userId)
        .eq("bot_id", BOT_ID)
        .gt("pairs_scanned", 0)
        .order("created_at", { ascending: false })
        .limit(5);

      const rawConfig = botConfig?.config_json || {};
      userDataMap[userId] = {
        telegramChatIds,
        brokerConnections: connections || [],
        brokerConn,
        openPositions: openPositions || [],
        account: account || null,
        config: mapNestedToFlat(rawConfig),
        rawConfig,
        gamePlan: parseSessionGamePlan(gamePlanRows?.[0]),
        recentScanLogs: recentScanLogs || [],
      };
    }

    // ── 3. Process each hunting order ──
    let confirmed = 0;
    let resetToPending = 0;
    let cancelled = 0;
    let stillHunting = 0;

    for (const pending of huntingOrders) {
      try {
        const userId = pending.user_id;
        const userData = userDataMap[userId];
        if (!userData) { stillHunting++; continue; }

        const {
          telegramChatIds,
          brokerConnections,
          brokerConn,
          openPositions,
          account,
          config,
          rawConfig,
          gamePlan,
          recentScanLogs,
        } = userData;

        // Avoid market-data work when execution is administratively disabled.
        // The atomic RPC repeats these checks immediately before insertion.
        if (!account || account.kill_switch_active === true || account.is_running !== true || account.is_paused === true) {
          stillHunting++;
          console.log(
            `[zone-confirm] ${pending.symbol} ${pending.direction} — execution disabled`
            + ` (account=${!!account}, running=${account?.is_running}, paused=${account?.is_paused}, kill=${account?.kill_switch_active})`,
          );
          continue;
        }

        // Fetch fresh 5m candles for this pair
        const candles5m = await fetchCandles(pending.symbol, "5m", brokerConn);
        if (candles5m.length < 10) {
          console.log(`[zone-confirm] ${pending.symbol} — insufficient 5m candles (${candles5m.length})`);
          stillHunting++;
          continue;
        }

        // Get current price from latest candle
        const currentPrice = candles5m[candles5m.length - 1].close;

        // ── Check impulse invalidation ──
        let impulseData: { high: number; low: number } | null = null;
        try {
          const signalReasonParsed = typeof pending.signal_reason === "string"
            ? JSON.parse(pending.signal_reason) : pending.signal_reason;
          if (signalReasonParsed?.impulseZone?.impulse) {
            impulseData = signalReasonParsed.impulseZone.impulse;
          }
        } catch { /* ignore */ }

        if (impulseData && isImpulseBroken(currentPrice, impulseData.high, impulseData.low, pending.direction as "long" | "short")) {
          await supabase.from("pending_orders").update({
            status: "cancelled",
            cancel_reason: `[fast-confirm] Impulse broken — price ${currentPrice} exceeded origin`,
            resolved_at: new Date().toISOString(),
          }).eq("order_id", pending.order_id).eq("user_id", userId);
          cancelled++;
          console.log(`[zone-confirm] CANCELLED ${pending.symbol} ${pending.direction} — impulse broken at ${currentPrice}`);
          continue;
        }

        // ── Check if price left the zone ──
        // Use refined zone bounds (15m OB/FVG) when available; fall back to broad HTF zone
        const rawRefinedLow = parseFloat(pending.refined_zone_low || "0");
        const rawRefinedHigh = parseFloat(pending.refined_zone_high || "0");
        const hasRefinedZone = rawRefinedLow > 0 && rawRefinedHigh > 0;
        const zoneLow = hasRefinedZone ? rawRefinedLow : parseFloat(pending.entry_zone_low || "0");
        const zoneHigh = hasRefinedZone ? rawRefinedHigh : parseFloat(pending.entry_zone_high || "0");
        if (zoneLow > 0 && zoneHigh > 0 && !isPriceInZone(currentPrice, zoneLow, zoneHigh, pending.direction as "long" | "short")) {
          const attempts = (pending.confirmation_attempts || 0) + 1;
          const maxAttempts = config.maxConfirmationAttempts ?? 3;
          if (attempts >= maxAttempts) {
            // Cap reached — cancel the order instead of retrying indefinitely
            await supabase.from("pending_orders").update({
              status: "cancelled",
              cancel_reason: `Max confirmation attempts reached (${attempts}/${maxAttempts})`,
              resolved_at: new Date().toISOString(),
            }).eq("order_id", pending.order_id).eq("user_id", userId);
            cancelled++;
            console.log(`[zone-confirm] ${pending.symbol} ${pending.direction} — CANCELLED: max confirmation attempts reached (${attempts}/${maxAttempts})`);
            continue;
          }
          await supabase.from("pending_orders").update({
            status: "pending",
            zone_touch_time: null,
            confirmation_attempts: attempts,
          }).eq("order_id", pending.order_id).eq("user_id", userId);
          resetToPending++;
          console.log(`[zone-confirm] ${pending.symbol} ${pending.direction} — price left zone (${currentPrice}), reset to pending (attempt ${attempts}/${maxAttempts})`);
          continue;
        }

        // ── Refined zone invalidation ──
        // If price closes THROUGH the refined zone (not just wicks), the level has failed.
        // For longs: a 5m candle close below refined_zone_low = invalidation
        // For shorts: a 5m candle close above refined_zone_high = invalidation
        if (hasRefinedZone && candles5m.length > 0) {
          const lastCandle = candles5m[candles5m.length - 1];
          const dir = pending.direction as "long" | "short";
          const closedThrough = dir === "long"
            ? lastCandle.close < rawRefinedLow
            : lastCandle.close > rawRefinedHigh;
          if (closedThrough) {
            await supabase.from("pending_orders").update({
              status: "cancelled",
              cancel_reason: `[zone-confirm] Refined zone failed — 5m close ${lastCandle.close} broke through ${dir === "long" ? "low" : "high"} (${dir === "long" ? rawRefinedLow : rawRefinedHigh})`,
              resolved_at: new Date().toISOString(),
            }).eq("order_id", pending.order_id).eq("user_id", userId);
            cancelled++;
            console.log(`[zone-confirm] CANCELLED ${pending.symbol} ${pending.direction} — refined zone failed (close: ${lastCandle.close}, zone: ${rawRefinedLow}-${rawRefinedHigh})`);
            continue;
          }
        }

        // ── Run CHoCH detection ──
        let zoneTouchIdx: number | undefined;
        if (pending.zone_touch_time) {
          const touchTime = new Date(pending.zone_touch_time).getTime();
          for (let i = candles5m.length - 1; i >= 0; i--) {
            const candleTime = new Date(candles5m[i].datetime).getTime();
            if (candleTime <= touchTime) { zoneTouchIdx = i; break; }
          }
        }

        // Fetch 1m candles for LTF CHoCH detection (Level 2 in hierarchy)
        let candles1m: Candle[] = [];
        try {
          candles1m = await fetchCandles(pending.symbol, "1m", brokerConn);
        } catch { /* non-critical: LTF path just won't fire */ }

        // Extract sweep data from signal_reason (stored at order placement time)
        let sweepEventData: { level: number; type: string } | null = null;
        try {
          const sr = typeof pending.signal_reason === "string" ? JSON.parse(pending.signal_reason) : (pending.signal_reason || {});
          if (sr?.sweepReclaim?.bestReclaim?.sweptLevel) {
            sweepEventData = { level: sr.sweepReclaim.bestReclaim.sweptLevel, type: sr.sweepReclaim.bestReclaim.type || "buy-side" };
          } else if (sr?.sweepReclaim?.sweeps?.[0]?.sweptLevel) {
            sweepEventData = { level: sr.sweepReclaim.sweeps[0].sweptLevel, type: sr.sweepReclaim.sweeps[0].type || "buy-side" };
          }
        } catch { /* non-critical */ }

        // Respect the canonical confirmation method saved in Bot Config.
        // The previous fast scanner always used CHoCH and could therefore fill
        // an indicators-only or CHoCH+indicators setup without its required leg.
        const confirmationMethod = config.confirmationMethod || "choch";
        let confirmationSignal = confirmationMethod === "indicators"
          ? null
          : detectZoneConfirmation(
            candles5m,
            pending.direction as "long" | "short",
            DEFAULT_ZONE_CONFIRMATION_CONFIG,
            zoneTouchIdx,
            pending.symbol,
            (zoneLow > 0 && zoneHigh > 0) ? { zoneHigh, zoneLow } : undefined,
            candles1m.length >= 15 ? candles1m : undefined,
            sweepEventData,
          );
        const indicatorConfirmation = confirmationMethod === "choch"
          ? null
          : checkIndicatorConfirmation(
            candles5m,
            pending.direction as "long" | "short",
            { minIndicators: config.indicatorMinCount || 3 },
          );
        const confirmationPassed = confirmationMethod === "choch"
          ? !!confirmationSignal
          : confirmationMethod === "indicators"
          ? !!indicatorConfirmation?.confirmed
          : !!confirmationSignal && !!indicatorConfirmation?.confirmed;

        if (!confirmationPassed) {
          stillHunting++;
          console.log(
            `[zone-confirm] ${pending.symbol} ${pending.direction} — no ${confirmationMethod} confirmation yet`
            + ` (CHoCH=${confirmationSignal ? `T${confirmationSignal.tier}` : "none"}, indicators=${indicatorConfirmation?.passedCount ?? 0}/4)`,
          );
          continue;
        }

        if (!confirmationSignal && indicatorConfirmation?.confirmed) {
          confirmationSignal = {
            type: (pending.direction === "long" ? "bullish_choch" : "bearish_choch") as any,
            tier: 2,
            price: currentPrice,
            candleIndex: candles5m.length - 1,
            displacement: 0.5,
            significance: undefined,
            closeBased: false,
            supportingSignals: ["indicator_confirmation", indicatorConfirmation.summary],
          };
        }
        const confirmedSignal = confirmationSignal!;

        // ── Tier gate: require Tier 1 or 2 when no refined zone is available ──
        // Tier 1 (close-based CHoCH) and Tier 2 (wick CHoCH + supporting signal)
        // are both valid structural confirmations. Only block Tier 3 (reversal
        // pattern without any CHoCH) when there's no refined zone.
        if (confirmationMethod !== "indicators" && !hasRefinedZone && confirmedSignal.tier === 3) {
          stillHunting++;
          console.log(`[zone-confirm] ${pending.symbol} ${pending.direction} — T${confirmedSignal.tier} signal rejected (no refined zone, Tier 1/2 required)`);
          continue;
        }

        // ═══════════════════════════════════════════════════════════════════
        // CONFIRMED! Enter the trade (tiered confirmation passed).
        // ═══════════════════════════════════════════════════════════════
        console.log(`[zone-confirm] ${pending.symbol} ${pending.direction} — CONFIRMED! ${formatConfirmationSummary(confirmedSignal)}`);
        console.log(`[zone-confirm] Tier: ${confirmedSignal.tier}, Type: ${confirmedSignal.type}, Method: ${confirmationMethod}`);

        // Confirmation is a go/no-go signal — fill at current market price.
        // Since we already verified price is inside the refined zone (15m OB/FVG),
        // the current price IS the optimal entry. The confirmation just validates
        // that the level is holding (CHoCH/reversal/rejection observed).
        const actualFillPrice = currentPrice;
        const entryPrice = parseFloat(pending.entry_price);
        const positionId = pending.order_id;
        const orderId = crypto.randomUUID().slice(0, 8);
        const nowStr = new Date().toISOString();

        // ── Fresh thesis, account, direction, Game Plan, prop-firm and spread checks ──
        const requireThesisValidation = rawConfig?.strategy?.thesisValidationEnabled
          ?? rawConfig?.thesisValidationEnabled
          ?? true;
        let thesisResult: ThesisValidationResult | null = null;
        if (requireThesisValidation) {
          try {
            const [dailyCandles, h4Candles, h1Candles] = await Promise.all([
              fetchCandles(pending.symbol, "1d", brokerConn, 120),
              fetchCandles(pending.symbol, "4h", brokerConn, 120),
              fetchCandles(pending.symbol, "1h", brokerConn, 120),
            ]);
            thesisResult = validatePendingOrderThesis(
              {
                order_id: pending.order_id,
                symbol: pending.symbol,
                direction: pending.direction as "long" | "short",
                entry_price: pending.entry_price,
                signal_reason: pending.signal_reason,
              },
              {
                fotsiResult: null,
                lastGamePlan: gamePlan,
                dailyCandles: dailyCandles.length >= 20 ? dailyCandles : null,
                h4Candles: h4Candles.length >= 20 ? h4Candles : null,
                h1Candles: h1Candles.length >= 20 ? h1Candles : null,
              },
            );
          } catch (e: any) {
            console.warn(`[zone-confirm] Fresh thesis validation failed for ${pending.symbol}: ${e?.message}`);
          }
        }

        let brokerEquity: number | undefined;
        if (account.execution_mode === "live" && brokerConn) {
          try {
            const { res, body } = await metaFetch(
              brokerConn.account_id,
              brokerConn.api_key,
              (base) => `${base}/account-information`,
            );
            if (res.ok) {
              const equityData = JSON.parse(body);
              const parsedEquity = Number(equityData.equity ?? equityData.balance);
              if (Number.isFinite(parsedEquity) && parsedEquity > 0) brokerEquity = parsedEquity;
            }
          } catch (e: any) {
            console.warn(`[zone-confirm] Broker equity unavailable for ${pending.symbol}: ${e?.message}`);
          }
        }

        let propFirmResult: PropFirmGateResult | null = null;
        try {
          propFirmResult = await runPropFirmGate(
            supabase,
            userId,
            BOT_ID,
            Number(account.balance || 0),
            openPositions,
            `fast-confirm-${pending.id}`,
            {
              brokerEquity,
              isLiveAccount: account.execution_mode === "live",
              hasBrokerConnection: account.execution_mode === "live" && !!brokerConn,
            },
          );
        } catch (e: any) {
          propFirmResult = {
            enabled: true,
            allowed: false,
            reason: `Prop-firm verification error: ${e?.message}`,
            maxPositionSizeMultiplier: 0,
            shouldCloseAll: false,
            compliance: null,
            configId: null,
          };
        }

        const spreadConfig = {
          spreadFilterEnabled: config.spreadFilterEnabled,
          maxSpreadPips: config.maxSpreadPips,
        };
        const liveMode = account.execution_mode === "live";
        const spreadResults: Array<{ conn: any; result: Awaited<ReturnType<typeof fetchBrokerSpread>> }> = [];
        if (liveMode && config.spreadFilterEnabled) {
          for (const conn of brokerConnections) {
            let metaAccountId: string | undefined;
            let authToken: string | undefined;
            if (conn.broker_type === "metaapi") {
              metaAccountId = conn.account_id;
              authToken = conn.api_key;
              if (metaAccountId?.startsWith("eyJ") && authToken && /^[0-9a-f-]{36}$/.test(authToken)) {
                authToken = conn.account_id;
                metaAccountId = conn.api_key;
              }
            }
            spreadResults.push({
              conn,
              result: await fetchBrokerSpread(conn, pending.symbol, spreadConfig, metaAccountId, authToken),
            });
          }
        }
        const availableSpreads = spreadResults.filter((item) => !!item.result);
        const passingSpreads = spreadResults.filter((item) => item.result?.passed);
        const approvedBrokerConnections = liveMode && config.spreadFilterEnabled
          ? passingSpreads.map((item) => item.conn)
          : brokerConnections;
        const bestSpread = availableSpreads
          .map((item) => item.result!)
          .sort((a, b) => a.spreadPips - b.spreadPips)[0];

        const directionVerdict = findCurrentDirectionVerdict(recentScanLogs, pending.symbol);
        const authorization = evaluateFinalTradeAuthorization({
          account,
          candidate: {
            symbol: pending.symbol,
            direction: pending.direction as "long" | "short",
            entryPrice: actualFillPrice,
            stopLoss: Number(pending.stop_loss),
            takeProfit: Number(pending.take_profit),
          },
          openPositions,
          maxOpenPositions: config.maxOpenPositions,
          maxPerSymbol: config.maxPerSymbol,
          allowSameDirectionStacking: config.allowSameDirectionStacking,
          maxDailyLoss: config.maxDailyLoss,
          maxDrawdown: config.maxDrawdown,
          minimumRiskReward: config.minRiskReward,
          directionVerdict,
          requireDirectionVerdict: true,
          gamePlan,
          gamePlanEnabled: config.gamePlanEnabled,
          gamePlanMode: config.gpEnforcementMode,
          gamePlanMinimumConfidence: config.gpHardBlockThreshold,
          thesisResult,
          requireThesisValidation,
          propFirm: propFirmResult
            ? { enabled: propFirmResult.enabled, allowed: propFirmResult.allowed, reason: propFirmResult.reason }
            : null,
          requirePropFirmResult: true,
          spread: {
            required: liveMode && config.spreadFilterEnabled,
            available: !liveMode || !config.spreadFilterEnabled || availableSpreads.length > 0,
            passed: !liveMode || !config.spreadFilterEnabled || passingSpreads.length > 0,
            spreadPips: bestSpread?.spreadPips,
            maximumPips: bestSpread?.effectiveMax,
          },
        });

        if (!authorization.authorized) {
          const cancelPermanently = !authorization.retryable;
          await supabase.from("pending_orders").update({
            ...(cancelPermanently ? {
              status: "cancelled",
              cancel_reason: `[final-auth:${authorization.code}] ${authorization.reason}`,
              resolved_at: nowStr,
            } : {}),
            final_authorization: authorization,
          }).eq("id", pending.id).eq("user_id", userId);
          if (cancelPermanently) cancelled++;
          else stillHunting++;
          console.warn(`[zone-confirm] FINAL AUTH BLOCKED ${pending.symbol}: ${authorization.code} — ${authorization.reason}`);
          continue;
        }

        // Build signal_reason with confirmation and final authorization data.
        let parsedSignalReason: any = {};
        try { parsedSignalReason = typeof pending.signal_reason === "string" ? JSON.parse(pending.signal_reason) : (pending.signal_reason || {}); } catch {}
        const signalReason = {
          ...parsedSignalReason,
          filledFromLimitOrder: true,
          confirmationEntry: true,
          fastConfirmScanner: true, // Flag that this was filled by the fast-confirm scanner
          confirmation: {
            type: confirmedSignal.type,
            tier: confirmedSignal.tier,
            price: confirmedSignal.price,
            displacement: confirmedSignal.displacement,
            significance: confirmedSignal.significance,
            closeBased: confirmedSignal.closeBased,
            supportingSignals: confirmedSignal.supportingSignals,
            zoneTouchTime: pending.zone_touch_time,
            confirmationAttempts: pending.confirmation_attempts || 0,
            method: confirmationMethod,
          },
          limitOrderOrigin: {
            orderType: pending.order_type,
            entryPrice,
            placedAt: pending.placed_at,
            filledAt: nowStr,
            zoneType: pending.entry_zone_type,
            zoneLow: parseFloat(pending.entry_zone_low || "0"),
            zoneHigh: parseFloat(pending.entry_zone_high || "0"),
            fromWatchlist: pending.from_watchlist,
            stagedCycles: pending.staged_cycles,
          },
          finalAuthorization: authorization,
        };

        // One database transaction claims the pending order, rechecks account
        // state, inserts the position and resolves the order. Only the winning
        // scanner may continue to notifications or broker mirroring.
        const fillReason = `[fast-confirm] ${confirmedSignal.type} @ ${actualFillPrice.toFixed(5)}`
          + ` (method: ${confirmationMethod}, displacement: ${confirmedSignal.displacement.toFixed(2)},`
          + ` signals: ${confirmedSignal.supportingSignals.join(", ")})`;
        const { data: fillResult, error: fillError } = await supabase.rpc("finalize_pending_order_fill", {
          p_pending_id: pending.id,
          p_user_id: userId,
          p_bot_id: BOT_ID,
          p_fill_price: actualFillPrice,
          p_current_price: currentPrice,
          p_position_order_id: orderId,
          p_signal_reason: signalReason,
          p_fill_reason: fillReason,
          p_authorization: authorization,
          p_max_open_positions: config.maxOpenPositions,
          p_max_per_symbol: config.maxPerSymbol,
          p_allow_same_direction: config.allowSameDirectionStacking,
        });
        if (fillError || !fillResult?.filled) {
          console.warn(
            `[zone-confirm] Atomic fill declined ${pending.symbol}:`
            + ` ${fillError?.message || fillResult?.code || "unknown"}`,
          );
          continue;
        }

        // Insert trade reasoning
        await supabase.from("trade_reasonings").insert({
          user_id: userId,
          position_id: positionId,
          symbol: pending.symbol,
          direction: pending.direction,
          confluence_score: Math.round(parseFloat(pending.signal_score || "0")),
          summary: `[FAST-CONFIRM] ${pending.from_watchlist ? "[WATCHLIST] " : ""}${confirmedSignal.type} @ ${actualFillPrice.toFixed(5)} (zone: ${pending.entry_zone_type}, limit was ${entryPrice})`,
          bias: pending.direction === "long" ? "bullish" : "bearish",
          session: "confirmation_fill",
          timeframe: "5m",
        });

        confirmed++;

        // Update openPositions array for subsequent max-position checks in same batch
        openPositions.push({
          symbol: pending.symbol,
          direction: pending.direction,
          size: pending.size,
          entry_price: actualFillPrice,
          stop_loss: pending.stop_loss,
          position_id: positionId,
          position_status: "open",
        });

        // ── Telegram notification ──
        if (telegramChatIds.length > 0) {
          const emoji = pending.direction === "long" ? "🟢" : "🔴";
          const mode = account.execution_mode === "live" ? "LIVE" : "PAPER";
          const _spec = SPECS[pending.symbol] || SPECS["EUR/USD"];
          const _decimals = Math.max(2, Math.round(-Math.log10(_spec.pipSize)) + 1);
          const fmt = (v: any) => {
            const n = typeof v === "number" ? v : parseFloat(String(v));
            return isFinite(n) ? n.toFixed(_decimals) : String(v);
          };
          const msg = `${emoji} <b>${mode} CONFIRMED Entry</b> ⚡\n\n` +
            `<b>Symbol:</b> ${pending.symbol}\n` +
            `<b>Direction:</b> ${pending.direction.toUpperCase()}\n` +
            `<b>Size:</b> ${pending.size} lots\n` +
            `<b>Entry:</b> ${fmt(actualFillPrice)} (${confirmedSignal.type})\n` +
            `<b>Zone Level:</b> ${fmt(entryPrice)}\n` +
            `<b>SL:</b> ${fmt(pending.stop_loss)}\n` +
            `<b>TP:</b> ${fmt(pending.take_profit)}\n` +
            `<b>Score:</b> ${pending.signal_score}\n` +
            `<b>Confirmation:</b> ${confirmedSignal.type} (disp: ${confirmedSignal.displacement.toFixed(2)})\n` +
            `<b>Scanner:</b> Fast-confirm (60s poll)\n` +
            `<b>Zone:</b> ${pending.entry_zone_type} [${fmt(pending.entry_zone_low || "0")} - ${fmt(pending.entry_zone_high || "0")}]` +
            (pending.from_watchlist ? `\n\n📋 <b>From Watchlist</b> (${pending.staged_cycles} cycles)` : "");
          await Promise.all(telegramChatIds.map(async (chatId: string) => {
            try {
              await fetch(`${supabaseUrl}/functions/v1/telegram-notify`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${supabaseKey}` },
                body: JSON.stringify({ chat_id: chatId, message: msg }),
              });
            } catch (e: any) { console.warn(`Telegram notify failed: ${e?.message}`); }
          }));
        }

        // ── Broker mirroring ──
        if (account.execution_mode === "live" && approvedBrokerConnections.length > 0) {
          const mirroredConnIds: string[] = [];
          for (const conn of approvedBrokerConnections) {
            try {
              let metaAccountId: string | undefined;
              let authToken: string | undefined;
              if (conn.broker_type === "metaapi") {
                metaAccountId = conn.account_id;
                authToken = conn.api_key;
                if (metaAccountId?.startsWith("eyJ") && authToken && /^[0-9a-f-]{36}$/.test(authToken)) {
                  authToken = conn.account_id;
                  metaAccountId = conn.api_key;
                }
              }

              if (conn.broker_type !== "metaapi") {
                // OANDA or other — use broker-execute function
                const exRes = await fetch(`${supabaseUrl}/functions/v1/broker-execute`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${supabaseKey}` },
                  body: JSON.stringify({
                    action: "place_order",
                    connectionId: conn.id,
                    symbol: pending.symbol,
                    direction: pending.direction,
                    size: parseFloat(pending.size),
                    stopLoss: parseFloat(pending.stop_loss),
                    takeProfit: parseFloat(pending.take_profit),
                    userId,
                  }),
                });
                if (exRes.ok) mirroredConnIds.push(conn.id);
                continue;
              }

              // MetaAPI direct execution
              const brokerSymbol = resolveSymbol(pending.symbol, conn);
              const mt5Body: any = {
                actionType: pending.direction === "long" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
                symbol: brokerSymbol,
                volume: parseFloat(pending.size),
                comment: `paper:${positionId}`,
              };
              if (pending.stop_loss) mt5Body.stopLoss = parseFloat(pending.stop_loss);
              if (pending.take_profit) mt5Body.takeProfit = parseFloat(pending.take_profit);
              const { res: mt5Res } = await metaFetch(metaAccountId!, authToken!, (base) => `${base}/trade`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(mt5Body),
              });
              if (mt5Res.ok) mirroredConnIds.push(conn.id);
            } catch (e: any) {
              console.warn(`[zone-confirm] Broker mirror error [${conn.display_name}]: ${e?.message}`);
            }
          }

          if (mirroredConnIds.length > 0) {
            await supabase.from("paper_positions").update({ mirrored_connection_ids: mirroredConnIds })
              .eq("position_id", positionId).eq("user_id", userId);
          }
        }

      } catch (e: any) {
        console.warn(`[zone-confirm] Error processing ${pending.symbol}: ${e?.message}`);
        stillHunting++;
      }
    }

    const elapsed = Date.now() - startTime;
    const summary = {
      status: "complete",
      processed: huntingOrders.length,
      confirmed,
      reset_to_pending: resetToPending,
      cancelled,
      still_hunting: stillHunting,
      elapsed_ms: elapsed,
    };
    console.log(`[zone-confirm] Done in ${elapsed}ms: ${JSON.stringify(summary)}`);

    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (e: any) {
    console.error("[zone-confirm] Fatal error:", e?.message, e?.stack);
    return new Response(JSON.stringify({ error: e?.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
