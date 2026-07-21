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
  analyzeMarketStructure,
  normalizeSymKey,
  type Candle,
} from "../_shared/smcAnalysis.ts";
import {
  detectZoneConfirmation,
  isPriceInZone,
  isImpulseBroken,
  formatConfirmationSummary,
  DEFAULT_ZONE_CONFIRMATION_CONFIG,
} from "../_shared/zoneConfirmation.ts";

// ─── Constants ──────────────────────────────────────────────────────────────
const BOT_ID = "smc";

// MetaAPI regions for broker execution
const META_REGIONS = ["london", "new-york", "singapore"];
const regionCache = new Map<string, string>();
function metaBaseUrl(region: string, accountId: string) {
  return `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}`;
}

async function metaFetch(
  accountId: string,
  authToken: string,
  pathBuilder: (base: string) => string,
  init?: RequestInit,
): Promise<{ res: Response; body: string }> {
  const cached = regionCache.get(accountId);
  const order = cached ? [cached, ...META_REGIONS.filter(r => r !== cached)] : META_REGIONS;
  let lastBody = ""; let lastStatus = 504;
  for (const region of order) {
    const url = pathBuilder(metaBaseUrl(region, accountId));
    const headers = { ...(init?.headers || {}), "auth-token": authToken } as Record<string, string>;
    const res = await fetch(url, { ...init, headers });
    const body = await res.text();
    if (res.ok) { regionCache.set(accountId, region); return { res, body }; }
    lastBody = body; lastStatus = res.status;
    if (!/region|not connected to broker/i.test(body)) {
      return { res: new Response(body, { status: res.status }), body };
    }
  }
  return { res: new Response(lastBody, { status: lastStatus }), body: lastBody };
}

// normalizeSymKey is now imported from ../_shared/smcAnalysis.ts
function resolveSymbol(pair: string, conn: any): string {
  const overrides = conn.symbol_overrides || {};
  const norm = normalizeSymKey(pair);
  for (const [k, v] of Object.entries(overrides)) {
    if (normalizeSymKey(k) === norm) return v as string;
  }
  return pair.replace("/", "");
}

// ─── Candle Fetching ────────────────────────────────────────────────────────

// Minimal broker connection for candle fetching
let _brokerConn: BrokerConn | null = null;

async function fetchCandles(symbol: string, interval = "5m"): Promise<Candle[]> {
  const result = await fetchCandlesWithFallback({
    symbol,
    interval,
    limit: 100, // Only need recent candles for CHoCH detection
    brokerConn: _brokerConn,
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
      openPositions: any[];
      account: any;
      config: any;
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

      // Set up broker connection for candle fetching (MetaApi preferred)
      const metaConn = (connections || []).find((c: any) => c.broker_type === "metaapi");
      if (metaConn) {
        let authToken = metaConn.api_key;
        let metaAccountId = metaConn.account_id;
        if (metaAccountId?.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
          authToken = metaConn.account_id;
          metaAccountId = metaConn.api_key;
        }
        _brokerConn = { api_key: authToken, account_id: metaAccountId };
      }

      userDataMap[userId] = {
        telegramChatIds,
        brokerConnections: connections || [],
        openPositions: openPositions || [],
        account: account || { execution_mode: "paper" },
        config: botConfig?.config_json || {},
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

        const { telegramChatIds, brokerConnections, openPositions, account, config } = userData;
        const strategyConfig = config.strategy || {};

        // Fetch fresh 5m candles for this pair
        const candles5m = await fetchCandles(pending.symbol, "5m");
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
          await supabase.from("pending_orders").update({
            status: "pending",
            zone_touch_time: null,
            confirmation_attempts: attempts,
          }).eq("order_id", pending.order_id).eq("user_id", userId);
          resetToPending++;
          console.log(`[zone-confirm] ${pending.symbol} ${pending.direction} — price left zone (${currentPrice}), reset to pending (attempt ${attempts})`);
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
          candles1m = await fetchCandles(pending.symbol, "1m");
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

        const confirmationSignal = detectZoneConfirmation(
          candles5m,
          pending.direction as "long" | "short",
          DEFAULT_ZONE_CONFIRMATION_CONFIG,
          zoneTouchIdx,
          pending.symbol,
          (zoneLow > 0 && zoneHigh > 0) ? { zoneHigh, zoneLow } : undefined,
          candles1m.length >= 15 ? candles1m : undefined,
          sweepEventData,
        );

        if (!confirmationSignal) {
          stillHunting++;
          console.log(`[zone-confirm] ${pending.symbol} ${pending.direction} — no confirmation yet (all tiers checked)`);
          continue;
        }

        // ── Tier gate: require Tier 1 or 2 when no refined zone is available ──
        // Tier 1 (close-based CHoCH) and Tier 2 (wick CHoCH + supporting signal)
        // are both valid structural confirmations. Only block Tier 3 (reversal
        // pattern without any CHoCH) when there's no refined zone.
        if (!hasRefinedZone && confirmationSignal.tier === 3) {
          stillHunting++;
          console.log(`[zone-confirm] ${pending.symbol} ${pending.direction} — T${confirmationSignal.tier} signal rejected (no refined zone, Tier 1/2 required)`);
          continue;
        }

        // ═══════════════════════════════════════════════════════════════════
        // CONFIRMED! Enter the trade (tiered confirmation passed).
        // ═══════════════════════════════════════════════════════════════
        console.log(`[zone-confirm] ${pending.symbol} ${pending.direction} — CONFIRMED! ${formatConfirmationSummary(confirmationSignal)}`);
        console.log(`[zone-confirm] Tier: ${confirmationSignal.tier}, Type: ${confirmationSignal.type}`);

        // Check max positions gate — canonical: risk.maxConcurrentTrades (UI field).
        // Runtime config.maxOpenPositions is populated from that same source by configMapper.
        const maxOpenPositions = parseInt(String(
          config.risk?.maxConcurrentTrades ?? config.maxOpenPositions ?? 3
        ), 10);
        const maxPerSymbol = config.risk?.maxPerSymbol || config.maxPerSymbol || 2;
        const currentOpenCount = openPositions.length;
        const currentSymbolCount = openPositions.filter((p: any) => p.symbol === pending.symbol).length;

        if (currentOpenCount >= maxOpenPositions) {
          await supabase.from("pending_orders").update({
            status: "cancelled",
            cancel_reason: `[fast-confirm] Max open positions reached (${currentOpenCount}/${maxOpenPositions})`,
            resolved_at: new Date().toISOString(),
          }).eq("order_id", pending.order_id).eq("user_id", userId);
          cancelled++;
          console.log(`[zone-confirm] SKIPPED ${pending.symbol} — max positions (${currentOpenCount}/${maxOpenPositions})`);
          continue;
        }
        if (currentSymbolCount >= maxPerSymbol) {
          await supabase.from("pending_orders").update({
            status: "cancelled",
            cancel_reason: `[fast-confirm] Max per symbol reached (${currentSymbolCount}/${maxPerSymbol})`,
            resolved_at: new Date().toISOString(),
          }).eq("order_id", pending.order_id).eq("user_id", userId);
          cancelled++;
          console.log(`[zone-confirm] SKIPPED ${pending.symbol} — max per symbol (${currentSymbolCount}/${maxPerSymbol})`);
          continue;
        }

        // Confirmation is a go/no-go signal — fill at current market price.
        // Since we already verified price is inside the refined zone (15m OB/FVG),
        // the current price IS the optimal entry. The confirmation just validates
        // that the level is holding (CHoCH/reversal/rejection observed).
        const actualFillPrice = currentPrice;
        const entryPrice = parseFloat(pending.entry_price);
        const positionId = pending.order_id;
        const orderId = crypto.randomUUID().slice(0, 8);
        const nowStr = new Date().toISOString();

        // Build signal_reason with confirmation data
        let parsedSignalReason: any = {};
        try { parsedSignalReason = typeof pending.signal_reason === "string" ? JSON.parse(pending.signal_reason) : (pending.signal_reason || {}); } catch {}
        const signalReason = {
          ...parsedSignalReason,
          filledFromLimitOrder: true,
          confirmationEntry: true,
          fastConfirmScanner: true, // Flag that this was filled by the fast-confirm scanner
          confirmation: {
            type: confirmationSignal.type,
            tier: confirmationSignal.tier,
            price: confirmationSignal.price,
            displacement: confirmationSignal.displacement,
            significance: confirmationSignal.significance,
            closeBased: confirmationSignal.closeBased,
            supportingSignals: confirmationSignal.supportingSignals,
            zoneTouchTime: pending.zone_touch_time,
            confirmationAttempts: pending.confirmation_attempts || 0,
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
        };

        // Insert paper position
        await supabase.from("paper_positions").insert({
          user_id: userId,
          position_id: positionId,
          symbol: pending.symbol,
          direction: pending.direction,
          size: pending.size.toString(),
          entry_price: actualFillPrice.toString(),
          current_price: currentPrice.toString(),
          stop_loss: pending.stop_loss.toString(),
          take_profit: pending.take_profit.toString(),
          open_time: nowStr,
          signal_reason: JSON.stringify(signalReason),
          signal_score: pending.signal_score?.toString() || "0",
          order_id: orderId,
          position_status: "open",
          bot_id: BOT_ID,
          order_type: "limit",
          trigger_price: entryPrice.toString(),
        });

        // Insert trade reasoning
        await supabase.from("trade_reasonings").insert({
          user_id: userId,
          position_id: positionId,
          symbol: pending.symbol,
          direction: pending.direction,
          confluence_score: Math.round(parseFloat(pending.signal_score || "0")),
          summary: `[FAST-CONFIRM] ${pending.from_watchlist ? "[WATCHLIST] " : ""}${confirmationSignal.type} @ ${actualFillPrice.toFixed(5)} (zone: ${pending.entry_zone_type}, limit was ${entryPrice})`,
          bias: pending.direction === "long" ? "bullish" : "bearish",
          session: "confirmation_fill",
          timeframe: "5m",
        });

        // Update pending order to filled
        await supabase.from("pending_orders").update({
          status: "filled",
          fill_reason: `[fast-confirm] ${confirmationSignal.type} @ ${actualFillPrice.toFixed(5)} (displacement: ${confirmationSignal.displacement.toFixed(2)}, signals: ${confirmationSignal.supportingSignals.join(", ")})`,
          filled_at: nowStr,
          resolved_at: nowStr,
        }).eq("order_id", pending.order_id).eq("user_id", userId);

        confirmed++;

        // Update openPositions array for subsequent max-position checks in same batch
        openPositions.push({ symbol: pending.symbol, position_id: positionId, position_status: "open" });

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
            `<b>Entry:</b> ${fmt(actualFillPrice)} (${confirmationSignal.type})\n` +
            `<b>Zone Level:</b> ${fmt(entryPrice)}\n` +
            `<b>SL:</b> ${fmt(pending.stop_loss)}\n` +
            `<b>TP:</b> ${fmt(pending.take_profit)}\n` +
            `<b>Score:</b> ${pending.signal_score}\n` +
            `<b>Confirmation:</b> ${confirmationSignal.type} (disp: ${confirmationSignal.displacement.toFixed(2)})\n` +
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
        if (account.execution_mode === "live" && brokerConnections.length > 0) {
          const spreadConfig = {
            spreadFilterEnabled: strategyConfig.spreadFilterEnabled ?? config.spreadFilterEnabled ?? true,
            maxSpreadPips: strategyConfig.maxSpreadPips ?? config.maxSpreadPips ?? 0,
          };

          const mirroredConnIds: string[] = [];
          for (const conn of brokerConnections) {
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

              // Spread check
              const spreadResult = await fetchBrokerSpread(conn, pending.symbol, spreadConfig, metaAccountId, authToken);
              if (spreadResult && !spreadResult.passed) {
                console.warn(`[zone-confirm] Spread too wide for ${pending.symbol} on ${conn.display_name} — skipping`);
                continue;
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
