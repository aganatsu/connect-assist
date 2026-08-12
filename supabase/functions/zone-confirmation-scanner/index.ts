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
import {
  beginScanSourceTally,
  endScanSourceTally,
  fetchCandlesWithFallback,
  type BrokerConn,
} from "../_shared/candleSource.ts";
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
import { buildRoutedConfirmationObservation } from "../_shared/confirmationAuthority.ts";
import {
  advanceStoredTradeLifecycle,
} from "../_shared/impulseEntryLifecycleStore.ts";
import {
  loadImpulseLifecycleCertificate,
  resolveImpulseLifecycleEnforcement,
  type ImpulseLifecycleEnforcementResolution,
} from "../_shared/impulseLifecycleEnforcement.ts";
import {
  derivePostChochEntryPlan,
  evaluatePostChochRetracement,
  normalizeAfterChochMode,
  type PostChochEntryPlan,
} from "../_shared/postChochRetracement.ts";
import { resolveSymbol } from "../_shared/brokerSymbols.ts";
import {
  confirmationEvidenceLines,
  confirmationMethodLabel,
  diagnosticScoreLine,
  directionVerdictLines,
  durationLabel,
  parseSignalReason,
  styleLadderLines,
  tgLine,
  tradeAuthorityLines,
  zoneEvidenceLines,
} from "../_shared/telegramDetail.ts";
import { metaFetch } from "../_shared/metaApiClient.ts";
import { verifyCronCaller } from "../_shared/cronAuth.ts";
import {
  buildConfirmationEvidenceRow,
  findParentEvidenceId,
  nextConfirmationAttempt,
  persistZoneTimeframeEvidence,
} from "../_shared/zoneTimeframeEvidence.ts";
import type { RuntimeConfig } from "../_shared/configMapper.ts";
import {
  loadEffectiveRuntimeConfig,
} from "../_shared/runtimeConfigStore.ts";
import {
  buildResolvedStylePolicy,
  type ResolvedStylePolicy,
} from "../_shared/stylePolicy.ts";
import {
  bindTimeframeCandles,
  buildTimeframeCandleMap,
  resolveTimeframeAuthority,
} from "../_shared/timeframeAuthority.ts";
import {
  buildStyleDecisionEvidence,
} from "../_shared/styleDecisionEvidence.ts";
import { checkIndicatorConfirmation } from "../_shared/indicatorConfirmation.ts";
import {
  evaluateFinalTradeAuthorization,
} from "../_shared/finalTradeAuthorization.ts";
import { evaluateSingleOwnershipFillAuthorization } from "../_shared/singleOwnershipFillAuthorization.ts";
import { projectCanonicalScannerState } from "../_shared/canonicalScannerState.ts";
import { evaluateCanonicalScannerEnforcement } from "../_shared/canonicalScannerEnforcement.ts";
import { buildTradeDecisionPresentation } from "../_shared/tradeDecisionPresentation.ts";
import { evaluateBreakerFillLifecycle } from "../_shared/breakerSemantics.ts";
import {
  evaluateCanonicalDealingRange,
  normalizeDealingRangeMode,
  readFrozenCanonicalDealingRange,
} from "../_shared/canonicalDealingRange.ts";
import {
  attachDecisionContext,
  buildTradeDecisionContext,
  evaluateDecisionHierarchy,
  type DirectionVerdictDecision,
  type EntryConfirmationDecision,
} from "../_shared/decisionContract.ts";
import {
  buildFinalRuntimeGateStates,
} from "../_shared/finalRuntimeGates.ts";
import {
  validatePendingOrderThesis,
  type ThesisValidationResult,
} from "../_shared/thesisValidator.ts";
import { runPropFirmGate, type PropFirmGateResult } from "../_shared/propFirmGate.ts";
import type { SessionGamePlan } from "../_shared/gamePlan.ts";
import { loadActiveGamePlan } from "../_shared/gamePlanStore.ts";
import {
  directionVerdictMatchesGamePlan,
  loadActiveDirectionVerdicts,
} from "../_shared/directionVerdictStore.ts";
import {
  executeBrokerOrderWithLedger,
} from "../_shared/brokerExecutionLedger.ts";
import { calculateFinalPendingSize } from "../_shared/finalPendingSize.ts";
import {
  resolvePendingConfirmationMethod,
  resolvePendingDealingRangeMode,
  resolvePendingIndicatorMinimum,
  resolvePendingMaxConfirmationAttempts,
  resolvePendingStylePolicy,
  readFrozenCrossTimeframeAuthority,
  readFrozenSetupStrategyContext,
  validateFrozenSetupIdentity,
} from "../_shared/setupLifecycle.ts";
import {
  loadCrossTimeframeActivation,
} from "../_shared/crossTimeframeActivationStore.ts";
import {
  resolveCrossTimeframeAuthority,
  type CrossTimeframeAuthorityResolution,
} from "../_shared/crossTimeframeAuthority.ts";
import {
  evaluateCrossTimeframeEntryAuthority,
} from "../_shared/crossTimeframeEntryAuthority.ts";
import {
  beginScannerOperation,
  completeScannerOperation,
  failScannerOperation,
  markScannerOperation,
  publishCandleSourceAlerts,
  recordScannerAuthorizationFailure,
  type ScannerTriggerSource,
} from "../_shared/scannerRuntime.ts";

import { setCreditCallerContext } from "../_shared/apiCreditBudget.ts";

setCreditCallerContext("zone-confirmation-scanner");

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
  if (authError) {
    const authHeader = req.headers.get("authorization") || "";
    const likelySchedulerRequest = req.headers.has("x-cron-secret") ||
      authHeader === `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""}`;
    if (likelySchedulerRequest) {
      try {
        const failureClient = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );
        const failureBody = await authError.clone().json().catch(() => ({}));
        await recordScannerAuthorizationFailure(
          failureClient,
          "zone-confirmation-scanner",
          failureBody?.reason || "Rejected scheduler request",
          {
            has_cron_header: req.headers.has("x-cron-secret"),
            has_authorization: authHeader.startsWith("Bearer "),
          },
        );
      } catch (recordError: any) {
        console.warn(
          `[zone-confirm] Could not record auth failure: ${recordError?.message}`,
        );
      }
    }
    return authError;
  }

  const startTime = Date.now();
  const operationRuns = new Map<string, string>();
  // Observation-only Phase 1: one immutable evidence row per confirmation attempt.
  const confirmScanCycleId = crypto.randomUUID();
  let supabase: any = null;

  try {
    beginScanSourceTally();
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    supabase = createClient(supabaseUrl, supabaseKey);
    const requestBody = await req.clone().json().catch(() => ({}));
    const triggerSource: ScannerTriggerSource =
      requestBody?.trigger_source === "manual" ? "manual" : "cron";

    // Persist one observable run per active bot before doing background work.
    // This makes an idle confirmation cycle visible instead of looking missing.
    const { data: activeAccounts } = await supabase
      .from("paper_accounts")
      .select("user_id")
      .eq("is_running", true)
      .eq("kill_switch_active", false)
      .or(`bot_id.eq.${BOT_ID},bot_id.is.null`);
    for (const account of activeAccounts || []) {
      const operation = await beginScannerOperation(supabase, {
        userId: account.user_id,
        botId: BOT_ID,
        functionName: "zone-confirmation-scanner",
        operation: "zone_confirmation",
        triggerSource,
      });
      if (operation.persisted) operationRuns.set(account.user_id, operation.runId);
    }

    // ── 1. Query all orders in "awaiting_confirmation" status ──
    const { data: huntingOrders, error: queryErr } = await supabase
      .from("pending_orders")
      .select("*")
      .eq("bot_id", BOT_ID)
      .eq("status", "awaiting_confirmation")
      .order("placed_at", { ascending: true });

    if (queryErr) {
      endScanSourceTally();
      console.error("[zone-confirm] Query error:", queryErr.message);
      return new Response(JSON.stringify({ error: queryErr.message }), { status: 500 });
    }

    if (!huntingOrders || huntingOrders.length === 0) {
      endScanSourceTally();
      // Nothing to do — no orders are hunting for confirmation
      await Promise.all([...operationRuns.values()].map((runId) =>
        completeScannerOperation(supabase, runId, "zone_confirmation", {
          processed: 0,
          outcome: "idle",
        })
      ));
      return new Response(JSON.stringify({
        status: "idle",
        message: "No orders awaiting confirmation",
        elapsed_ms: Date.now() - startTime,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    console.log(`[zone-confirm] Processing ${huntingOrders.length} order(s) awaiting confirmation`);

    // ── 2. Get unique user IDs to load their configs and broker connections ──
    const userIds: string[] = [
      ...new Set<string>(
        huntingOrders.map((order: any) => String(order.user_id)),
      ),
    ];
    await Promise.all(userIds.map((userId) =>
      markScannerOperation(
        supabase,
        operationRuns.get(userId),
        "confirmation_processing_started",
        {
          status: "running",
          scan_started_at: new Date().toISOString(),
          expected_pairs: huntingOrders.filter((order: any) =>
            order.user_id === userId
          ).length,
        },
      )
    ));

    // Load user settings (for telegram) and broker connections per user
    const userDataMap: Record<string, {
      telegramChatIds: string[];
      brokerConnections: any[];
      brokerConn: BrokerConn | null;
      openPositions: any[];
      account: any | null;
      config: RuntimeConfig;
      stylePolicy: ResolvedStylePolicy;
      gamePlan: SessionGamePlan | null;
      directionVerdicts: Map<string, DirectionVerdictDecision>;
      crossTimeframeAuthority: CrossTimeframeAuthorityResolution;
      impulseLifecycleEnforcement: ImpulseLifecycleEnforcementResolution;
    }> = {};
    const configFailureUsers = new Map<string, Error>();

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

      let styleResolution;
      try {
        styleResolution = await loadEffectiveRuntimeConfig(supabase, {
          userId,
        });
      } catch (error: any) {
        const configError = error instanceof Error
          ? error
          : new Error(String(error));
        configFailureUsers.set(userId, configError);
        console.error(
          `[zone-confirm] Runtime configuration unavailable for ${userId}; pending fills remain untouched: ${configError.message}`,
        );
        continue;
      }

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

      // Load both dedicated, versioned strategy authorities. General scan logs
      // are observability only and are never used to authorize a fill.
      let gamePlan: SessionGamePlan | null = null;
      let directionVerdicts = new Map<
        string,
        DirectionVerdictDecision
      >();
      try {
        gamePlan = await loadActiveGamePlan(supabase, userId, BOT_ID);
      } catch (error: any) {
        console.warn(
          `[zone-confirm] Active Gameplan unavailable for ${userId}: ${error?.message}`,
        );
      }
      try {
        directionVerdicts = await loadActiveDirectionVerdicts(
          supabase,
          userId,
          BOT_ID,
        );
      } catch (error: any) {
        console.warn(
          `[zone-confirm] Active Direction Verdicts unavailable for ${userId}: ${error?.message}`,
        );
      }

      const stylePolicy = await buildResolvedStylePolicy({
        resolution: styleResolution,
        config: styleResolution.config,
      });
      const crossTimeframeActivation = await loadCrossTimeframeActivation(
        supabase,
        { userId, botId: BOT_ID },
      );
      const crossTimeframeAuthority = resolveCrossTimeframeAuthority({
        rawConfig: styleResolution.config as unknown as Record<
          string,
          unknown
        >,
        runtimeTarget: account?.execution_mode === "live" ? "live" : "paper",
        activation: crossTimeframeActivation,
      });
      let lifecycleCertificate = null;
      try {
        lifecycleCertificate = await loadImpulseLifecycleCertificate(supabase, userId, BOT_ID);
      } catch (error) {
        console.warn(`[zone-confirm] Lifecycle certificate unavailable; enforcement fails closed: ${String(error)}`);
      }
      const impulseLifecycleEnforcement = resolveImpulseLifecycleEnforcement(
        (styleResolution.config as any).impulseEntryLifecycleMode,
        lifecycleCertificate,
      );
      userDataMap[userId] = {
        telegramChatIds,
        brokerConnections: connections || [],
        brokerConn,
        openPositions: openPositions || [],
        account: account || null,
        config: styleResolution.config,
        stylePolicy,
        gamePlan,
        directionVerdicts,
        crossTimeframeAuthority,
        impulseLifecycleEnforcement,
      };
    }

    // ── 3. Process each hunting order ──
    let confirmed = 0;
    let resetToPending = 0;
    let cancelled = 0;
    let stillHunting = 0;

    for (let pendingIndex = 0; pendingIndex < huntingOrders.length; pendingIndex++) {
      const pending = huntingOrders[pendingIndex];
      try {
        const userId = pending.user_id;
        const parsedPendingEvidence = parseSignalReason(pending.signal_reason);
        await markScannerOperation(
          supabase,
          operationRuns.get(userId),
          "confirmation_processing",
          {
            status: "running",
            processed_pairs: huntingOrders
              .slice(0, pendingIndex)
              .filter((order: any) => order.user_id === userId)
              .length,
            metadata: { current_order_id: pending.order_id, current_pair: pending.symbol },
          },
        );
        const userData = userDataMap[userId];
        if (!userData) { stillHunting++; continue; }
        await supabase.from("pending_orders").update({
          last_confirmation_checked_at: new Date().toISOString(),
        }).eq("id", pending.id).eq("status", "awaiting_confirmation");

        const {
          telegramChatIds,
          brokerConnections,
          brokerConn,
          openPositions,
          account,
          config,
          stylePolicy: runtimeStylePolicy,
          gamePlan,
          directionVerdicts,
          crossTimeframeAuthority,
          impulseLifecycleEnforcement,
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

        const pendingPolicyResolution = resolvePendingStylePolicy(
          pending,
          runtimeStylePolicy,
        );
        const pendingTimeframeAuthority = resolveTimeframeAuthority(
          pendingPolicyResolution.policy,
        );
        const pendingDealingRangeMode = resolvePendingDealingRangeMode(
          pending,
          (config as any).dealingRangeMode,
        );
        const frozenIdentity = validateFrozenSetupIdentity(
          pending,
          pendingPolicyResolution.frozenContext,
        );
        if (!frozenIdentity.valid) {
          await supabase.from("pending_orders").update({
            status: "invalidated",
            cancel_reason: frozenIdentity.reason,
            resolved_at: new Date().toISOString(),
          }).eq("id", pending.id).eq("user_id", userId);
          cancelled++;
          console.warn(
            `[zone-confirm] ${pending.symbol} invalidated: ${frozenIdentity.reason}`,
          );
          continue;
        }

        const confirmationTimeframe =
          pendingTimeframeAuthority.roles.confirmation;
        const refinementTimeframe =
          pendingTimeframeAuthority.roles.refinement;
        const candles5m = await fetchCandles(
          pending.symbol,
          confirmationTimeframe,
          brokerConn,
        );
        if (candles5m.length < 10) {
          console.log(`[zone-confirm] ${pending.symbol} — insufficient ${confirmationTimeframe} frozen-confirmation candles (${candles5m.length})`);
          stillHunting++;
          continue;
        }

        // Get current price from latest candle
        const currentPrice = candles5m[candles5m.length - 1].close;

        let impulseLifecycleObservation = null;
        let lifecycleAfterLock = null;
        try {
          impulseLifecycleObservation = await advanceStoredTradeLifecycle(
            supabase,
            pending.impulse_entry_lifecycle_id,
            candles5m[candles5m.length - 1],
            candles5m,
          );
          for (const transition of impulseLifecycleObservation?.transitions || []) {
            console.log(
              `[zone-confirm] ${pending.symbol} lifecycle ${transition.event?.type}: ${transition.after.lastTransitionReason}`,
            );
          }
          lifecycleAfterLock = impulseLifecycleObservation?.after || null;
        } catch (lifecycleError: any) {
          console.warn(
            `[zone-confirm] ${pending.symbol} shared lifecycle observation failed (non-blocking): ${lifecycleError?.message}`,
          );
        }
        const lifecycleFailure = impulseLifecycleObservation?.transitions.find(
          (transition) => transition.event?.type === "candidate_failed",
        ) || null;

        if (
          impulseLifecycleEnforcement.effectiveMode === "enforce" &&
          lifecycleFailure &&
          lifecycleFailure.after.status === "active"
        ) {
          const { data: retarget, error: retargetError } = await supabase.rpc(
            "retarget_pending_to_impulse_candidate",
            { p_pending_id: pending.id, p_user_id: userId, p_bot_id: BOT_ID },
          );
          if (retargetError) throw retargetError;
          if (retarget?.retargeted) {
            resetToPending++;
            console.log(`[zone-confirm] ${pending.symbol} retargeted to frozen impulse candidate ${retarget.candidate_id}`);
            continue;
          }
        }

        let retracementReadyPlan: PostChochEntryPlan | null = null;
        const storedRetracementPlan = pending.post_confirmation_entry as
          | PostChochEntryPlan
          | null;
        if (storedRetracementPlan?.state === "awaiting_retracement") {
          const evaluatedPlan = evaluatePostChochRetracement(
            storedRetracementPlan,
            candles5m[candles5m.length - 1],
          );
          if (evaluatedPlan !== storedRetracementPlan) {
            const { error: planUpdateError } = await supabase
              .from("pending_orders")
              .update({ post_confirmation_entry: evaluatedPlan })
              .eq("id", pending.id).eq("user_id", userId);
            if (planUpdateError) throw planUpdateError;
          }
          if (evaluatedPlan.state === "invalidated" || evaluatedPlan.state === "expired") {
            await supabase.from("pending_orders").update({
              status: evaluatedPlan.state === "expired" ? "cancelled" : "invalidated",
              cancel_reason: evaluatedPlan.reason,
              resolved_at: evaluatedPlan.resolvedAt,
            }).eq("id", pending.id).eq("user_id", userId);
            cancelled++;
            continue;
          }
          if (evaluatedPlan.state !== "ready") {
            stillHunting++;
            console.log(`[zone-confirm] ${pending.symbol} waiting for post-CHoCH ${evaluatedPlan.zone.type} retracement ${evaluatedPlan.zone.low}-${evaluatedPlan.zone.high}`);
            continue;
          }
          retracementReadyPlan = evaluatedPlan;
        } else if (storedRetracementPlan?.state === "ready") {
          retracementReadyPlan = storedRetracementPlan;
        }

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
            status: "invalidated",
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
        if (!retracementReadyPlan && zoneLow > 0 && zoneHigh > 0 && !isPriceInZone(currentPrice, zoneLow, zoneHigh, pending.direction as "long" | "short")) {
          const attempts = (pending.confirmation_attempts || 0) + 1;
          const maxAttempts = resolvePendingMaxConfirmationAttempts(
            pending,
            config,
          );
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
        if (!retracementReadyPlan && hasRefinedZone && candles5m.length > 0) {
          const lastCandle = candles5m[candles5m.length - 1];
          const dir = pending.direction as "long" | "short";
          const closedThrough = dir === "long"
            ? lastCandle.close < rawRefinedLow
            : lastCandle.close > rawRefinedHigh;
          if (closedThrough) {
            await supabase.from("pending_orders").update({
              status: "invalidated",
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

        // Fetch the exact lower timeframe frozen with this setup.
        let candles1m: Candle[] = [];
        try {
          candles1m = await fetchCandles(
            pending.symbol,
            refinementTimeframe,
            brokerConn,
          );
        } catch { /* non-critical: LTF path just won't fire */ }

        // Extract sweep data from signal_reason (stored at order placement time)
        let sweepEventData: { level: number; type: string } | null = null;
        let candlestickProfile: "unified" | "standalone" | "cascade" = "standalone";
        try {
          const sr = typeof pending.signal_reason === "string" ? JSON.parse(pending.signal_reason) : (pending.signal_reason || {});
          candlestickProfile = sr?.signalSource === "cascade" ? "cascade"
            : sr?.signalSource === "unified" ? "unified" : "standalone";
          if (sr?.sweepReclaim?.bestReclaim?.sweptLevel) {
            sweepEventData = { level: sr.sweepReclaim.bestReclaim.sweptLevel, type: sr.sweepReclaim.bestReclaim.type || "buy-side" };
          } else if (sr?.sweepReclaim?.sweeps?.[0]?.sweptLevel) {
            sweepEventData = { level: sr.sweepReclaim.sweeps[0].sweptLevel, type: sr.sweepReclaim.sweeps[0].type || "buy-side" };
          }
        } catch { /* non-critical */ }

        // Respect the confirmation contract frozen when this setup was created.
        // Runtime config is only a legacy fallback for pre-Phase 4 rows.
        const confirmationMethod = resolvePendingConfirmationMethod(
          pending,
          config,
        );
        const confirmationIndicatorMinimum =
          resolvePendingIndicatorMinimum(pending, config);
        let confirmationSignal = retracementReadyPlan
          ? {
            ...retracementReadyPlan.confirmation,
            significance: retracementReadyPlan.confirmation.significance || undefined,
          } as any
          : confirmationMethod === "indicators"
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
            candlestickProfile,
          );
        const indicatorConfirmation = retracementReadyPlan || confirmationMethod === "choch"
          ? null
          : checkIndicatorConfirmation(
            candles5m,
            pending.direction as "long" | "short",
            { minIndicators: confirmationIndicatorMinimum },
          );
        const confirmationPassed = retracementReadyPlan
          ? true
          : confirmationMethod === "choch"
          ? !!confirmationSignal
          : confirmationMethod === "indicators"
          ? !!indicatorConfirmation?.confirmed
          : !!confirmationSignal && !!indicatorConfirmation?.confirmed;
        const lifecycleConfirmationPassed =
          impulseLifecycleEnforcement.effectiveMode !== "enforce" ||
          lifecycleAfterLock?.status === "entered";
        const confirmationAuthority = buildRoutedConfirmationObservation({
          method: confirmationMethod,
          direction: pending.direction as "long" | "short",
          structural: confirmationSignal?.authority || null,
          indicatorsPassed: indicatorConfirmation?.passedCount ?? null,
          indicatorsRequired: confirmationIndicatorMinimum,
          indicatorConfirmed: indicatorConfirmation?.confirmed === true,
          evaluatedAt: candles5m[candles5m.length - 1]?.datetime || null,
          candleIndex: candles5m.length - 1,
          candleTime: candles5m[candles5m.length - 1]?.datetime || null,
          price: currentPrice,
        });

        // ── Phase 1: confirmation-attempt evidence (observation only) ──
        // Never feeds the confirmation decision below; failures are swallowed.
        try {
          const evidencePolicy = pendingPolicyResolution.policy;
          const attempt = await nextConfirmationAttempt(supabase, {
            userId,
            botId: BOT_ID,
            symbol: pending.symbol,
            direction: pending.direction === "long" ? "bullish" : "bearish",
            pendingOrderId: pending.id,
          });
          let parsedSignalReason: Record<string, any> = {};
          try {
            parsedSignalReason = typeof pending.signal_reason === "string"
              ? JSON.parse(pending.signal_reason)
              : (pending.signal_reason || {});
          } catch {
            parsedSignalReason = {};
          }
          const frozenContext = readFrozenSetupStrategyContext(pending);
          // New orders carry the exact originating evidence UUID. The
          // time-based lookup remains only as compatibility for orders created
          // before this corrective release.
          const parentEvidenceId =
            parsedSignalReason.timeframeEvidenceId ||
            frozenContext?.timeframeEvidenceId ||
            await findParentEvidenceId(supabase, {
              userId,
              botId: BOT_ID,
              symbol: pending.symbol,
              direction: pending.direction === "long" ? "bullish" : "bearish",
              before: pending.placed_at ?? undefined,
            });
          const row = buildConfirmationEvidenceRow(
            {
              userId,
              botId: BOT_ID,
              scanCycleId: confirmScanCycleId,
              symbol: pending.symbol,
              direction: pending.direction === "long" ? "bullish" : "bearish",
              observedAt: candles5m[candles5m.length - 1]?.datetime ||
                new Date().toISOString(),
              evaluatedAt: new Date().toISOString(),
              tradingStyle: evidencePolicy.style,
              stylePolicyVersion: evidencePolicy.contractVersion,
              styleBasePolicyHash: evidencePolicy.basePolicyHash,
              stylePolicyHash: evidencePolicy.policyHash,
              stylePolicySnapshot: {
                style: evidencePolicy.style,
                timeframes: evidencePolicy.timeframes,
              },
              parentEvidenceId,
              pendingOrderId: pending.id,
              confirmationAttempt: attempt,
            },
            {
              timeframe: evidencePolicy.timeframes.runtimeEntry,
              candleCount: candles5m.length,
              confirmationMethod,
              confirmationPassed,
              reason: confirmationPassed
                ? "confirmation_passed"
                : `no_${confirmationMethod}_confirmation`,
              chochTier: confirmationSignal?.tier ?? null,
              chochType: confirmationSignal?.type ?? null,
              indicatorsPassed: indicatorConfirmation?.passedCount ?? null,
              indicatorsRequired: confirmationIndicatorMinimum ?? null,
              hasRefinedZone,
              zoneHigh: zoneHigh > 0 ? zoneHigh : null,
              zoneLow: zoneLow > 0 ? zoneLow : null,
              currentPrice: currentPrice ?? null,
              authority: confirmationAuthority,
            },
          );
          await persistZoneTimeframeEvidence(supabase, [row], {
            onError: (err: any) =>
              console.warn(
                `[zone-confirm] ${pending.symbol} confirmation evidence write`
                + ` failed (non-fatal): ${err?.message}`,
              ),
          });
        } catch (confirmEvidenceErr: any) {
          console.warn(
            `[zone-confirm] ${pending.symbol} confirmation evidence unavailable`
            + ` (non-fatal): ${confirmEvidenceErr?.message}`,
          );
        }

        if (!confirmationPassed || !lifecycleConfirmationPassed) {
          stillHunting++;
          console.log(
            `[zone-confirm] ${pending.symbol} ${pending.direction} — ${!confirmationPassed ? `no ${confirmationMethod} confirmation yet` : "frozen confirmation contract not satisfied"}`
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
            authority: confirmationAuthority,
          };
        }
        confirmationSignal!.authority = confirmationAuthority;
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

        const pendingConfirmationConfig =
          pending.confirmation_config &&
            typeof pending.confirmation_config === "object"
            ? pending.confirmation_config
            : {};
        const afterChochMode = normalizeAfterChochMode(
          pendingConfirmationConfig.afterChochMode ?? config.afterChochMode,
        );
        const afterChochExpiryMinutes = Math.max(
          5,
          Number(
            pendingConfirmationConfig.afterChochExpiryMinutes ??
              config.afterChochExpiryMinutes ??
              30,
          ),
        );
        const isChochSignal = confirmedSignal.type.includes("choch");
        let observedPostChochPlan =
          (pending.post_confirmation_observation as PostChochEntryPlan | null) ||
          null;
        if (
          !retracementReadyPlan &&
          isChochSignal &&
          afterChochMode !== "confirmation_close"
        ) {
          const postChochPlan = derivePostChochEntryPlan({
            candles: candles5m,
            direction: pending.direction as "long" | "short",
            signal: confirmedSignal,
            protectedLevel: Number(
              lifecycleAfterLock?.confirmation?.protectedLevel ??
                pending.stop_loss,
            ),
            candidateId:
              lifecycleAfterLock?.confirmation?.candidateId ??
              pending.candidate_id ??
              null,
            confirmationGeneration:
              lifecycleAfterLock?.confirmation?.generation ?? null,
            mode: afterChochMode,
            createdAt:
              candles5m[candles5m.length - 1]?.datetime ||
              new Date().toISOString(),
            expiryMinutes: afterChochExpiryMinutes,
          });
          if (postChochPlan) {
            observedPostChochPlan = postChochPlan;
            const column = afterChochMode === "wait_retracement"
              ? "post_confirmation_entry"
              : "post_confirmation_observation";
            const { error: planPersistError } = await supabase
              .from("pending_orders").update({ [column]: postChochPlan })
              .eq("id", pending.id).eq("user_id", userId);
            if (planPersistError) throw planPersistError;
            if (afterChochMode === "wait_retracement") {
              stillHunting++;
              console.log(`[zone-confirm] ${pending.symbol} CHoCH confirmed; waiting for ${postChochPlan.zone.type} retracement ${postChochPlan.zone.low}-${postChochPlan.zone.high}`);
              continue;
            }
          } else if (afterChochMode === "wait_retracement") {
            stillHunting++;
            console.warn(
              `[zone-confirm] ${pending.symbol} CHoCH passed but no deterministic retracement zone could be frozen; fill withheld`,
            );
            continue;
          }
        }

        // ═══════════════════════════════════════════════════════════════════
        // CONFIRMED! Enter the trade (tiered confirmation passed).
        // ═══════════════════════════════════════════════════════════════
        console.log(`[zone-confirm] ${pending.symbol} ${pending.direction} — CONFIRMED! ${formatConfirmationSummary(confirmedSignal)}`);
        console.log(`[zone-confirm] Tier: ${confirmedSignal.tier}, Type: ${confirmedSignal.type}, Method: ${confirmationMethod}`);

        // Fill at the current market price. In retracement mode this is the
        // first touch of the frozen post-CHoCH FVG/OB; otherwise it remains the
        // confirmation close for backward compatibility.
        const actualFillPrice = currentPrice;
        const entryPrice = parseFloat(pending.entry_price);
        const positionId = pending.order_id;
        const orderId = crypto.randomUUID().slice(0, 8);
        const nowStr = new Date().toISOString();

        // ── Fresh thesis, account, direction, Game Plan, prop-firm and spread checks ──
        // Thesis validity is a fill-time safety decision. It is deliberately
        // separate from the observational Thesis Conviction score and cannot
        // be disabled by the latter.
        const requireThesisValidation = true;
        let thesisResult: ThesisValidationResult | null = null;
        if (requireThesisValidation) {
          try {
            const [biasCandles, structureCandles, setupCandles] =
              await Promise.all([
              fetchCandles(
                pending.symbol,
                pendingTimeframeAuthority.roles.bias,
                brokerConn,
                120,
              ),
              fetchCandles(
                pending.symbol,
                pendingTimeframeAuthority.roles.structure,
                brokerConn,
                120,
              ),
              fetchCandles(
                pending.symbol,
                pendingTimeframeAuthority.roles.setup,
                brokerConn,
                120,
              ),
            ]);
            const decisionEvidence = buildStyleDecisionEvidence(
              pendingTimeframeAuthority,
              bindTimeframeCandles(
                pendingTimeframeAuthority,
                buildTimeframeCandleMap([
                  {
                    timeframe: pendingTimeframeAuthority.roles.bias,
                    candles: biasCandles,
                  },
                  {
                    timeframe:
                      pendingTimeframeAuthority.roles.structure,
                    candles: structureCandles,
                  },
                  {
                    timeframe: pendingTimeframeAuthority.roles.setup,
                    candles: setupCandles,
                  },
                ]),
              ),
              {
                h4ChochLookback: config.simpleDirectionH4ChochLookback,
                h1BosLookback: config.simpleDirectionH1BosLookback,
                confirmedTrendFibFactor: config.confirmedTrendFibFactor,
                confirmedTrendSwingLookback:
                  config.confirmedTrendSwingLookback,
                useConfirmedTrend: config.useConfirmedTrend,
              },
            );
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
                dailyCandles: null,
                h4Candles: null,
                h1Candles: null,
                decisionEvidence,
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

        let directionVerdict = directionVerdicts.get(pending.symbol) || null;
        if (
          directionVerdict &&
          config.gamePlanEnabled &&
          !directionVerdictMatchesGamePlan(
            directionVerdict,
            gamePlan,
            pending.symbol,
          )
        ) {
          console.warn(
            `[zone-confirm] ${pending.symbol}: Direction Verdict and Gameplan versions do not match`,
          );
          directionVerdict = null;
        }
        const runtimeGates = await buildFinalRuntimeGateStates({
          supabase,
          userId,
          accountExecutionMode: account.execution_mode,
          symbol: pending.symbol,
          direction: pending.direction as "long" | "short",
          currentPrice: actualFillPrice,
          candles: candles5m,
          interval: pendingTimeframeAuthority.runtimeEntry,
          openPositions,
          accountBalance: account.balance,
          config: {
            portfolioHeat: config.portfolioHeat,
            riskPerTrade: config.riskPerTrade,
            correlationFilterEnabled: config.correlationFilterEnabled,
            maxCorrelation: config.maxCorrelation,
            maxCorrelatedPositions: config.maxCorrelatedPositions,
            cooldownMinutes: config.cooldownMinutes,
            newsFilterEnabled: config.newsFilterEnabled,
            newsFilterPauseMinutes: config.newsFilterPauseMinutes,
            enabledSessions: config.enabledSessions,
            enabledDays: config.enabledDays,
            killZoneOnly: config.killZoneOnly,
          },
        });
        const entryConfirmation: EntryConfirmationDecision = {
          required: true,
          passed: true,
          method: confirmationMethod,
          reason:
            `Entry timing confirmed by ${confirmedSignal.type} (${confirmationMethod})`,
          evidence: {
            type: confirmedSignal.type,
            tier: confirmedSignal.tier,
            price: confirmedSignal.price,
            displacement: confirmedSignal.displacement,
            supportingSignals: confirmedSignal.supportingSignals,
            authority: confirmedSignal.authority || null,
          },
          evaluatedAt: nowStr,
        };
        const pendingCanonicalDealingRange = evaluateCanonicalDealingRange({
          range: readFrozenCanonicalDealingRange(
            readFrozenSetupStrategyContext(pending)?.crossTimeframeContext,
          ),
          direction: pending.direction as "long" | "short",
          price: actualFillPrice,
          mode: normalizeDealingRangeMode(pendingDealingRangeMode, {
            onlyBuyInDiscount: config.onlyBuyInDiscount,
            onlySellInPremium: config.onlySellInPremium,
          }),
        });
        let rawAuthorization = evaluateFinalTradeAuthorization({
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
          gamePlanEnabled: config.gamePlanEnabled !== false,
          gamePlanMode: config.gpEnforcementMode,
          gamePlanMinimumConfidence: config.gpHardBlockThreshold,
          thesisResult,
          requireThesisValidation,
          entryConfirmation,
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
          runtimeGates,
          crossTimeframeAuthority:
            readFrozenCrossTimeframeAuthority(pending) ||
            evaluateCrossTimeframeEntryAuthority({
              authorityResolution: crossTimeframeAuthority,
              evaluation: null,
            }),
          requireCrossTimeframeAuthority: true,
        });
        if (pending.entry_zone_type === "breaker_block") {
          const breakerFill = evaluateBreakerFillLifecycle({
            direction: pending.direction as "long" | "short",
            bounds: {
              low: Number(pending.entry_zone_low),
              high: Number(pending.entry_zone_high),
            },
            currentClose: actualFillPrice,
            structureBreakIndex:
              parsedPendingEvidence.breakerData?.structureBreakIndex,
          });
          if (!breakerFill.allowed) {
            rawAuthorization = {
              ...rawAuthorization,
              authorized: false,
              code: "additional_gate" as const,
              retryable: false,
              reason: `Breaker fill rejected: ${breakerFill.reason}`,
            };
          }
        }
        const hierarchy = rawAuthorization.decisionHierarchy ||
          evaluateDecisionHierarchy({
            symbol: pending.symbol,
            direction: pending.direction as "long" | "short",
            gamePlan,
            gamePlanEnabled: config.gamePlanEnabled !== false,
            gamePlanMode: config.gpEnforcementMode,
            gamePlanMinimumConfidence: config.gpHardBlockThreshold,
            directionVerdict,
            requireDirectionVerdict: true,
            thesisResult,
            requireThesisValidation,
            entryConfirmation,
          });
        const ownershipFill = evaluateSingleOwnershipFillAuthorization({
          frozenDecision: parsedPendingEvidence.singleOwnershipDecision || null,
          evaluatedAt: nowStr,
          candidateId: parsedPendingEvidence.candidateId || pending.id,
          symbol: pending.symbol,
          direction: pending.direction as "long" | "short",
          directionVerdict,
          canonicalLocation: {
            required: normalizeDealingRangeMode(pendingDealingRangeMode) !== "off",
            available: pendingCanonicalDealingRange.available,
            allowed: pendingCanonicalDealingRange.available ? pendingCanonicalDealingRange.allowed : null,
            rangeId: pendingCanonicalDealingRange.range?.impulseId || null,
            reasonCode: pendingCanonicalDealingRange.code,
          },
          confirmation: { passed: true, authorityVersion: "confirmation-authority.v1", reasonCodes: ["zone_confirmation_ready"] },
          thesis: { valid: thesisResult.valid, reasonCodes: [thesisResult.checkType || "thesis_valid"] },
          finalChecks: rawAuthorization.checks,
          rawFinalAuthorized: rawAuthorization.authorized,
          requestedMode: (config as any).singleOwnershipMode,
          runtimeTarget: liveMode ? "live" : "paper",
        });
        const pendingLiquidityState = parsedPendingEvidence?.unifiedZone?.liquidity?.entryTriggerState ||
          parsedPendingEvidence?.impulseZone?.liquidity?.entryTriggerState || "none";
        const frozenLiquidityPolicy =
          readFrozenSetupStrategyContext(pending)?.liquidityActivation || null;
        const pendingScannerState = projectCanonicalScannerState({
          evaluatedAt: nowStr,
          identity: ownershipFill.decision.identity,
          direction: {
            available: !!ownershipFill.decision.authorities.direction.verdict,
            allowed: ownershipFill.decision.authorities.direction.shouldBlock === null
              ? null : !ownershipFill.decision.authorities.direction.shouldBlock &&
                ownershipFill.decision.authorities.direction.verdict === pending.direction,
            evidenceId: ownershipFill.decision.authorities.direction.evidenceId || null,
          },
          zone: {
            available: ownershipFill.decision.authorities.zoneStory.available,
            valid: ownershipFill.decision.authorities.zoneStory.valid,
            atPoi: true,
            evidenceId: ownershipFill.decision.authorities.zoneStory.candidateId || null,
          },
          location: ownershipFill.decision.authorities.canonicalLocation,
          liquidity: {
            policy: frozenLiquidityPolicy?.role ||
              (config.requireLiquiditySweep === true ? "required" :
                pendingLiquidityState === "none" ? "not_required" : "supporting"),
            state: ["unswept", "swept_rejected", "swept_absorbed"].includes(pendingLiquidityState)
              ? pendingLiquidityState : "none",
          },
          confirmation: { required: true, passed: true, evidenceId: null },
          thesis: ownershipFill.decision.authorities.thesis,
          safety: {
            complete: ownershipFill.decision.authorities.safety.complete,
            passed: ownershipFill.decision.authorities.safety.checks.every((check) => check.passed),
            reasonCode: ownershipFill.decision.authorities.safety.checks.find((check) => !check.passed)?.code || null,
          },
          execution: { authorized: ownershipFill.authorized, source: "final_trade_authorization" },
        });
        const pendingCanonicalEnforcement = evaluateCanonicalScannerEnforcement({
          requestedMode: (config as any).canonicalScannerMode,
          singleOwnershipEffectiveMode: ownershipFill.enforcement.effectiveMode,
          state: pendingScannerState,
        });
        const pendingDecisionPresentation = buildTradeDecisionPresentation({
          state: pendingScannerState,
          legacyDiagnostics: parsedPendingEvidence.legacyGateDiagnostics || [],
        });
        const canonicalFillAuthorized = ownershipFill.authorized &&
          pendingCanonicalEnforcement.authorized;
        const authorityRawAuthorization = canonicalFillAuthorized
          ? { ...rawAuthorization, singleOwnershipDecision: ownershipFill.decision, singleOwnershipEnforcement: ownershipFill.enforcement, canonicalDealingRange: pendingCanonicalDealingRange, canonicalScannerState: pendingScannerState, tradeDecisionPresentation: pendingDecisionPresentation, canonicalScannerEnforcement: pendingCanonicalEnforcement }
          : { ...rawAuthorization, authorized: false, code: "additional_gate" as const, retryable: ownershipFill.retryable, reason: "Trade Decision did not authorize entry: " + ownershipFill.reason, singleOwnershipDecision: ownershipFill.decision, singleOwnershipEnforcement: ownershipFill.enforcement, canonicalDealingRange: pendingCanonicalDealingRange, canonicalScannerState: pendingScannerState, tradeDecisionPresentation: pendingDecisionPresentation, canonicalScannerEnforcement: pendingCanonicalEnforcement };
        const authorization = attachDecisionContext(
          authorityRawAuthorization,
          buildTradeDecisionContext({
            stage: "fill",
            symbol: pending.symbol,
            direction: pending.direction as "long" | "short",
            gamePlan,
            directionVerdict,
            thesisResult,
            requireThesisValidation,
            thesisConviction:
              parsedPendingEvidence?.decisionContext?.thesisConviction
                ?.evidence ||
              parsedPendingEvidence?.thesisConviction ||
              null,
            entryConfirmation,
            hierarchy,
            stylePolicy: pendingPolicyResolution.policy,
            evaluatedAt: nowStr,
          }),
        );

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
        const parsedSignalReason = parsedPendingEvidence;
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
            authority: confirmedSignal.authority || null,
            zoneTouchTime: pending.zone_touch_time,
            confirmationAttempts: pending.confirmation_attempts || 0,
            method: confirmationMethod,
          },
          postChochEntry:
            retracementReadyPlan || observedPostChochPlan || null,
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
          decisionContext: authorization.decisionContext,
          singleOwnershipDecision: authorization.singleOwnershipDecision,
          singleOwnershipEnforcement: authorization.singleOwnershipEnforcement,
          canonicalScannerState: authorization.canonicalScannerState,
          tradeDecisionPresentation: authorization.tradeDecisionPresentation,
          canonicalScannerEnforcement: authorization.canonicalScannerEnforcement,
          streamlinedDecisionOrigin: pending.streamlined_decision_origin || parsedPendingEvidence.streamlinedDecisionOrigin || null,
          streamlinedDecisionLatest: {
            ...(parsedPendingEvidence.streamlinedDecisionLatest || {}),
            contractVersion: "streamlined-decision-lifecycle.v1",
            evaluatedAt: nowStr, stage: "fill", currentPrice,
          },
        };

        // One database transaction claims the pending order, rechecks account
        // state, inserts the position and resolves the order. Only the winning
        // scanner may continue to notifications or broker mirroring.
        const fillReason = `[fast-confirm] ${confirmedSignal.type} @ ${actualFillPrice.toFixed(5)}`
          + ` (method: ${confirmationMethod}, displacement: ${confirmedSignal.displacement.toFixed(2)},`
          + ` signals: ${confirmedSignal.supportingSignals.join(", ")})`;
        const finalPendingSize = calculateFinalPendingSize({
          balance: Number(account.balance),
          riskPercent: Number(config.riskPerTrade),
          fillPrice: actualFillPrice,
          stopLoss: Number(pending.stop_loss),
          symbol: pending.symbol,
          method: (config as any).positionSizingMethod,
          fixedLotSize: (config as any).fixedLotSize,
        });
        await supabase.from("pending_orders").update({ size: finalPendingSize })
          .eq("id", pending.id).eq("user_id", userId)
          .eq("status", "awaiting_confirmation");
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
          position_status: liveMode ? "pending" : "open",
        });

        // ── Telegram notification ──
        if (telegramChatIds.length > 0) {
          const emoji = pending.direction === "long" ? "🟢" : "🔴";
          const mode = account.execution_mode === "live" ? "LIVE ORDER SUBMITTED" : "PAPER";
          const _spec = SPECS[pending.symbol] || SPECS["EUR/USD"];
          const _decimals = Math.max(2, Math.round(-Math.log10(_spec.pipSize)) + 1);
          const fmt = (v: any) => {
            const n = typeof v === "number" ? v : parseFloat(String(v));
            return isFinite(n) ? n.toFixed(_decimals) : String(v);
          };
          const fastSR = signalReason;
          const fastRR = (() => {
            const e = Number(actualFillPrice), s = Number(pending.stop_loss), t = Number(pending.take_profit);
            if (![e, s, t].every(Number.isFinite) || Math.abs(e - s) <= 0) return null;
            return (Math.abs(t - e) / Math.abs(e - s)).toFixed(2);
          })();
          const fastMethodLabel = confirmationMethodLabel(confirmationMethod, confirmationIndicatorMinimum);
          const msg = emoji + " <b>" + mode + " CONFIRMED Entry</b> ⚡\n\n" +
            tgLine("Symbol", pending.symbol) +
            tgLine("Direction", String(pending.direction).toUpperCase()) +
            tgLine("Size", `${pending.size} lots`) +
            tgLine("Entry", fmt(actualFillPrice)) +
            tgLine("Zone Level", fmt(entryPrice)) +
            tgLine("SL", fmt(pending.stop_loss)) +
            tgLine("TP", fmt(pending.take_profit)) +
            (fastRR ? tgLine("Planned R:R", `${fastRR}:1`) : "") +
            tgLine("Time in Zone", durationLabel(pending.zone_touch_time)) +
            "\n" +
            tradeAuthorityLines(fastSR) +
            zoneEvidenceLines(fastSR) +
            directionVerdictLines(fastSR.directionVerdict) +
            styleLadderLines(fastSR) +
            "\n" +
            `🎯 <b>Confirmation</b>\n` +
            tgLine("Method", fastMethodLabel) +
            confirmationEvidenceLines(confirmedSignal) +
            tgLine("Attempts", (pending.confirmation_attempts || 0) > 0 ? pending.confirmation_attempts : null) +
            tgLine("Scanner", "Fast-confirm (60s poll)") +
            tgLine("Zone", pending.entry_zone_type + " [" + fmt(pending.entry_zone_low || "0") + " – " + fmt(pending.entry_zone_high || "0") + "]") +
            diagnosticScoreLine(pending.signal_score) +
            (pending.from_watchlist ? `\n📋 <b>From Watchlist</b> (${pending.staged_cycles} cycles)` : "");
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
                const ledgerExecution = await executeBrokerOrderWithLedger(
                  supabase,
                  {
                    userId,
                    botId: BOT_ID,
                    positionId,
                    brokerConnectionId: conn.id,
                    route: "fast_confirmation",
                    requestPayload: {
                      symbol: pending.symbol,
                      direction: pending.direction,
                      size: parseFloat(pending.size),
                      stopLoss: parseFloat(pending.stop_loss),
                      takeProfit: parseFloat(pending.take_profit),
                    },
                  },
                  async () => {
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
                        positionId,
                        userId,
                      }),
                    });
                    const rawBody = await exRes.text();
                    let parsedBody: any = null;
                    try { parsedBody = rawBody ? JSON.parse(rawBody) : null; } catch {}
                    return {
                      ok: exRes.ok,
                      httpStatus: exRes.status,
                      parsedBody,
                      rawBody,
                    };
                  },
                );
                if (ledgerExecution.status === "succeeded") {
                  mirroredConnIds.push(conn.id);
                } else {
                  console.warn(
                    `[zone-confirm] Broker execution ${ledgerExecution.status}`
                    + ` [${conn.display_name}]: ${ledgerExecution.error || "reconciliation required"}`,
                  );
                }
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
              const ledgerExecution = await executeBrokerOrderWithLedger(
                supabase,
                {
                  userId,
                  botId: BOT_ID,
                  positionId,
                  brokerConnectionId: conn.id,
                  route: "fast_confirmation",
                  requestPayload: {
                    symbol: pending.symbol,
                    brokerSymbol,
                    direction: pending.direction,
                    volume: parseFloat(pending.size),
                    stopLoss: pending.stop_loss ? parseFloat(pending.stop_loss) : null,
                    takeProfit: pending.take_profit ? parseFloat(pending.take_profit) : null,
                  },
                },
                async () => {
                  const { res: mt5Res, body: rawBody } = await metaFetch(
                    metaAccountId!,
                    authToken!,
                    (base) => `${base}/trade`,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(mt5Body),
                    },
                    { allowFailover: false },
                  );
                  let parsedBody: any = null;
                  try { parsedBody = rawBody ? JSON.parse(rawBody) : null; } catch {}
                  return {
                    ok: mt5Res.ok,
                    httpStatus: mt5Res.status,
                    parsedBody,
                    rawBody,
                  };
                },
              );
              if (ledgerExecution.status === "succeeded") {
                mirroredConnIds.push(conn.id);
              } else {
                console.warn(
                  `[zone-confirm] Broker execution ${ledgerExecution.status}`
                  + ` [${conn.display_name}]: ${ledgerExecution.error || "reconciliation required"}`,
                );
              }
            } catch (e: any) {
              console.warn(`[zone-confirm] Broker mirror error [${conn.display_name}]: ${e?.message}`);
            }
          }

          if (mirroredConnIds.length > 0) {
            await supabase.from("paper_positions").update({ mirrored_connection_ids: mirroredConnIds })
              .eq("position_id", positionId).eq("user_id", userId);
          }
        }
        if (account.execution_mode === "live") {
          const { data: brokerLifecycle } = await supabase.rpc("finalize_live_broker_position", {
            p_user_id: userId, p_bot_id: BOT_ID, p_position_id: positionId,
          });
          console.log("[zone-confirm] Broker lifecycle " + pending.symbol + ": " + (brokerLifecycle?.state || "unknown"));
        }

      } catch (e: any) {
        console.warn(`[zone-confirm] Error processing ${pending.symbol}: ${e?.message}`);
        stillHunting++;
      }
    }

    const sourceTally = endScanSourceTally();
    const normalizeIssueSymbol = (value: string) =>
      String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    await Promise.all(userIds.map((userId) => {
      const userSymbols = new Set<string>(
        huntingOrders
          .filter((order: any) => order.user_id === userId)
          .map((order: any) => normalizeIssueSymbol(order.symbol)),
      );
      const userIssues = sourceTally.issues.filter((issue) => {
        const issueSymbol = normalizeIssueSymbol(issue.symbol);
        return [...userSymbols].some((symbol) =>
          issueSymbol === symbol || issueSymbol.startsWith(symbol)
        );
      });
      return publishCandleSourceAlerts(supabase, {
        userId,
        botId: BOT_ID,
        runId: operationRuns.get(userId),
        issues: userIssues,
        metaapiAttempted: Boolean(userDataMap[userId]?.brokerConn) &&
          sourceTally.metaapiAttempted,
      });
    }));

    const elapsed = Date.now() - startTime;
    const summary = {
      status: "complete",
      processed: huntingOrders.length,
      confirmed,
      reset_to_pending: resetToPending,
      cancelled,
      still_hunting: stillHunting,
      config_failures: configFailureUsers.size,
      elapsed_ms: elapsed,
    };
    console.log(`[zone-confirm] Done in ${elapsed}ms: ${JSON.stringify(summary)}`);
    await Promise.all([...operationRuns.entries()].map(([userId, runId]) => {
      const configError = configFailureUsers.get(userId);
      if (configError) {
        return failScannerOperation(supabase, runId, configError);
      }
      return completeScannerOperation(supabase, runId, "zone_confirmation", {
        ...summary,
        user_processed: huntingOrders.filter((order: any) =>
          order.user_id === userId
        ).length,
      });
    }));

    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (e: any) {
    endScanSourceTally();
    console.error("[zone-confirm] Fatal error:", e?.message, e?.stack);
    if (supabase) {
      await Promise.all([...operationRuns.values()].map((runId) =>
        failScannerOperation(supabase, runId, e)
      ));
    }
    return new Response(JSON.stringify({ error: e?.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
