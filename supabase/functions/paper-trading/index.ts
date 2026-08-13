import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import { MIN_SL_PIPS, ATR_SL_FLOOR_MULTIPLIER, calculateATR, type Candle } from "../_shared/smcAnalysis.ts";
import { parseTradeOverrides } from "../_shared/resolveTradeConfig.ts";
import { resolvePositionManagementPolicy } from "../_shared/managementPolicy.ts";
import { metaFetch } from "../_shared/metaApiClient.ts";
import { computeTrailRatchet } from "../_shared/exitEngine.ts";
import { evaluateExit, priceAsBar } from "../_shared/exitEvaluation.ts";
import { acquireApiCredit, setCreditCallerContext } from "../_shared/apiCreditBudget.ts";
import { fetchLivePrice, TWELVE_DATA_SYMBOLS } from "../_shared/candleSource.ts";


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

async function updatePositionPrices(supabase: any, positions: any[]): Promise<void> {
  if (!positions || positions.length === 0) return;
  const symbols = [...new Set(positions.map((p: any) => p.symbol))];
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

// ─── Instrument Specs ───────────────────────────────────────────────
const SPECS: Record<string, { pipSize: number; lotUnits: number; marginPerLot: number }> = {
  // Forex Majors
  "EUR/USD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1000 },
  "GBP/USD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1000 },
  "USD/JPY": { pipSize: 0.01, lotUnits: 100000, marginPerLot: 1000 },
  "AUD/USD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 800 },
  "NZD/USD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 700 },
  "USD/CAD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1000 },
  "USD/CHF": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1000 },
  // Forex Crosses
  "EUR/GBP": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1200 },
  "EUR/JPY": { pipSize: 0.01, lotUnits: 100000, marginPerLot: 1200 },
  "GBP/JPY": { pipSize: 0.01, lotUnits: 100000, marginPerLot: 1500 },
  "EUR/AUD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1200 },
  "EUR/CAD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1200 },
  "EUR/CHF": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1200 },
  "EUR/NZD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1200 },
  "GBP/AUD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1500 },
  "GBP/CAD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1500 },
  "GBP/CHF": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1500 },
  "GBP/NZD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1500 },
  "AUD/CAD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 800 },
  "AUD/JPY": { pipSize: 0.01, lotUnits: 100000, marginPerLot: 800 },
  "CAD/JPY": { pipSize: 0.01, lotUnits: 100000, marginPerLot: 1000 },
  "AUD/CHF": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 800 },
  "AUD/NZD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 800 },
  "CAD/CHF": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1000 },
  "CHF/JPY": { pipSize: 0.01, lotUnits: 100000, marginPerLot: 1000 },
  "NZD/CAD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 700 },
  "NZD/CHF": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 700 },
  "NZD/JPY": { pipSize: 0.01, lotUnits: 100000, marginPerLot: 700 },
  // Indices
  "US30": { pipSize: 1.0, lotUnits: 1, marginPerLot: 5000 },
  "NAS100": { pipSize: 0.25, lotUnits: 1, marginPerLot: 3000 },
  "SPX500": { pipSize: 0.25, lotUnits: 1, marginPerLot: 3000 },
  // Commodities
  "XAU/USD": { pipSize: 0.01, lotUnits: 100, marginPerLot: 2000 },
  "XAG/USD": { pipSize: 0.001, lotUnits: 5000, marginPerLot: 1500 },
  "US Oil": { pipSize: 0.01, lotUnits: 1000, marginPerLot: 2000 },
  // Crypto
  "BTC/USD": { pipSize: 1, lotUnits: 1, marginPerLot: 5000 },
  "ETH/USD": { pipSize: 0.01, lotUnits: 1, marginPerLot: 1000 },
};

// ─── Hardcoded fallback rates (approximate) — used when TwelveData is unavailable ──
// These prevent catastrophic PnL miscalculation (e.g., treating JPY as USD = 142x error)
const FALLBACK_RATES: Record<string, number> = {
  "USD/JPY": 142.0,
  "GBP/USD": 1.27,
  "AUD/USD": 0.66,
  "NZD/USD": 0.61,
  "USD/CAD": 1.36,
  "USD/CHF": 0.88,
};

// ─── Quote-to-USD conversion (matching shared/smcAnalysis.ts) ──
function getQuoteToUSDRate(symbol: string, rateMap?: Record<string, number>): number {
  const spec = SPECS[symbol] || SPECS["EUR/USD"];
  // Non-forex instruments are already USD-denominated
  if (!symbol.includes("/")) return 1.0;
  const parts = symbol.split("/");
  const quote = parts[1];
  if (quote === "USD") return 1.0;
  const QUOTE_CONVERSION: Record<string, { pair: string; invert: boolean }> = {
    "JPY": { pair: "USD/JPY", invert: true },
    "GBP": { pair: "GBP/USD", invert: false },
    "AUD": { pair: "AUD/USD", invert: false },
    "NZD": { pair: "NZD/USD", invert: false },
    "CAD": { pair: "USD/CAD", invert: true },
    "CHF": { pair: "USD/CHF", invert: true },
  };
  const conv = QUOTE_CONVERSION[quote];
  if (!conv) return 1.0;
  // Try live rate first, then fallback to approximate hardcoded rate
  const liveRate = rateMap?.[conv.pair];
  const rate = (liveRate && liveRate > 0) ? liveRate : FALLBACK_RATES[conv.pair];
  if (!rate || rate <= 0) return 1.0;
  return conv.invert ? (1 / rate) : rate;
}

// Module-level rateMap built once per invocation from live prices
let _rateMap: Record<string, number> = {};

async function buildRateMap(): Promise<Record<string, number>> {
  const RATE_PAIRS = ["USD/JPY", "GBP/USD", "AUD/USD", "NZD/USD", "USD/CAD", "USD/CHF"];
  // Start with fallback rates so we always have something reasonable
  const map: Record<string, number> = { ...FALLBACK_RATES };
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

function calcPnl(dir: string, entry: number, current: number, size: number, symbol: string, rateMap?: Record<string, number>) {
  // NaN guard: if entry or current is invalid, return zero P&L to prevent balance corruption
  if (!Number.isFinite(entry) || !Number.isFinite(current) || !Number.isFinite(size) || entry <= 0 || current <= 0 || size <= 0) {
    console.warn(`[calcPnl] Invalid inputs — entry=${entry}, current=${current}, size=${size}, symbol=${symbol}. Returning zero P&L.`);
    return { pnl: 0, pnlPips: 0 };
  }
  const spec = SPECS[symbol] || SPECS["EUR/USD"];
  const diff = dir === "long" ? current - entry : entry - current;
  const quoteToUSD = getQuoteToUSDRate(symbol, rateMap || _rateMap);
  const pnl = diff * spec.lotUnits * size * quoteToUSD;
  const pnlPips = diff / spec.pipSize;
  // Sanity check: warn if single trade PnL exceeds reasonable bounds
  // This catches conversion errors (e.g., quoteToUSD=1.0 for JPY pairs = 142x inflation)
  if (Math.abs(pnl) > 50000) {
    console.warn(`[PnL SANITY] Suspicious PnL $${pnl.toFixed(2)} on ${symbol} (${size} lots, diff=${diff.toFixed(5)}, quoteToUSD=${quoteToUSD.toFixed(6)}). Check rate conversion.`);
  }
  return { pnl, pnlPips };
}


// ─── MT5 Mirror Helper ──────────────────────────────────────────────────────
async function mirrorToMT5(supabase: any, userId: string, params: {
  action: "open" | "close";
  symbol: string;
  direction?: string;
  size?: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  positionId?: string;
}): Promise<{ success: boolean; mt5Result?: any; error?: string; connectionId?: string; connectionIds?: string[] }> {
  try {
    // Find ALL active metaapi broker connections (not just the first one)
    const { data: connections } = await supabase.from("broker_connections")
      .select("*").eq("user_id", userId).eq("broker_type", "metaapi").eq("is_active", true);
    if (!connections || connections.length === 0) return { success: false, error: "no_connection" };

    if (params.action === "open") {
      const successIds: string[] = [];
      let firstResult: any = null;
      let lastError: string | null = null;

      for (const conn of connections) {
        try {
          let authToken = conn.api_key;
          let metaAccountId = conn.account_id;
          if (metaAccountId.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
            authToken = conn.account_id;
            metaAccountId = conn.api_key;
          }

          const body: any = {
            actionType: params.direction === "long" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
            symbol: params.symbol.replace("/", ""),
            volume: params.size,
          };
          if (params.stopLoss) body.stopLoss = params.stopLoss;
          if (params.takeProfit) body.takeProfit = params.takeProfit;
          if (params.positionId) body.comment = `paper:${params.positionId}`;

          const { res, body: resBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/trade`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
          });
          if (res.ok) {
            const parsed = JSON.parse(resBody);
            if (!firstResult) firstResult = parsed;
            successIds.push(conn.id);
            console.log(`MT5 mirror open [${conn.display_name}]: SUCCESS`);
          } else {
            lastError = `MT5 order failed on ${conn.display_name}: ${res.status}`;
            console.warn(`MT5 mirror open [${conn.display_name}] failed [${res.status}]: ${resBody.slice(0, 300)}`);
          }
        } catch (connErr: any) {
          lastError = connErr?.message || String(connErr);
          console.warn(`MT5 mirror open [${conn.display_name}] error: ${lastError}`);
        }
      }

      if (successIds.length > 0) {
        return { success: true, mt5Result: firstResult, connectionId: successIds[0], connectionIds: successIds };
      }
      return { success: false, error: lastError || "all connections failed" };
    }

    if (params.action === "close") {
      // H5 fix: Fan out close to ALL active connections (was only connections[0])
      let anySuccess = false;
      let lastResult: any = null;
      let lastError: string | null = null;

      for (const conn of connections) {
        try {
          let authToken = conn.api_key;
          let metaAccountId = conn.account_id;
          if (metaAccountId.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
            authToken = conn.account_id;
            metaAccountId = conn.api_key;
          }

          const { res: posRes, body: posBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/positions`);
          if (!posRes.ok) {
            console.warn(`MT5 close [${conn.display_name}]: positions fetch failed ${posRes.status}`);
            lastError = `${conn.display_name}: positions fetch failed ${posRes.status}`;
            continue;
          }
          const mt5Positions = JSON.parse(posBody);
          const commentTag = `paper:${params.positionId}`;
          const shortTag = commentTag.slice(0, 28);
          let mt5Pos = mt5Positions.find((p: any) =>
            p.comment && (p.comment.includes(commentTag) || p.comment.startsWith(shortTag))
          );
          if (!mt5Pos) {
            // Fallback: match by symbol
            const base = params.symbol?.replace("/", "") || "";
            const overrides = conn.symbol_overrides || {};
            const brokerSymbol = overrides[base] || (base + (conn.symbol_suffix || ""));
            mt5Pos = mt5Positions.find((p: any) =>
              p.symbol === brokerSymbol || p.symbol === base ||
              p.symbol?.replace(/[._\-]/g, "").toUpperCase() === base.toUpperCase()
            );
          }
          if (!mt5Pos) {
            console.warn(`MT5 close [${conn.display_name}]: position not found`);
            lastError = `${conn.display_name}: position not found`;
            continue;
          }

          const closeBody = { actionType: "POSITION_CLOSE_ID", positionId: mt5Pos.id };
          const { res: closeRes, body: closeResBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/trade`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(closeBody),
          });
          if (closeRes.ok) {
            lastResult = JSON.parse(closeResBody);
            anySuccess = true;
            console.log(`MT5 close [${conn.display_name}]: SUCCESS`);
          } else {
            lastError = `${conn.display_name}: close failed ${closeRes.status}`;
            console.warn(`MT5 close [${conn.display_name}] failed [${closeRes.status}]: ${closeResBody.slice(0, 300)}`);
          }
        } catch (connErr: any) {
          lastError = `${conn.display_name}: ${connErr?.message || String(connErr)}`;
          console.warn(`MT5 close [${conn.display_name}] error: ${lastError}`);
        }
      }

      if (anySuccess) return { success: true, mt5Result: lastResult };
      return { success: false, error: lastError || "all connections failed" };
    }

    return { success: false, error: "unknown action" };
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (msg.includes("invalid peer certificate") || msg.includes("UnknownIssuer")) {
      console.warn("MT5 mirror SSL issue \u2014 credentials saved, trade may still execute:", msg);
      return { success: false, error: "SSL certificate issue \u2014 credentials are saved" };
    }
    console.error("MT5 mirror error:", msg);
    return { success: false, error: msg };
  }
}
// ─── Close ONLY the broker connections this paper position was actually mirrored to ──
// Critical fix: never iterate ALL active connections — only the ones recorded at open time.
// If `mirroredConnectionIds` is empty, we close nothing on broker side (paper-only or pre-tracking position).
async function closeBrokerPositions(
  supabase: any,
  userId: string,
  positionId: string,
  symbol: string,
  mirroredConnectionIds: string[] | null | undefined,
): Promise<string[]> {
  const results: string[] = [];
  try {
    const { data: account } = await supabase.from("paper_accounts").select("execution_mode").eq("user_id", userId).single();
    if (account?.execution_mode !== "live") return ["skipped_paper_mode"];

    const ids = (mirroredConnectionIds || []).filter(Boolean);
    if (ids.length === 0) {
      console.log(`[broker-close] no mirrored connections for paper:${positionId} — skipping broker fan-out`);
      return ["no_mirrored_connections"];
    }

    const { data: connections } = await supabase.from("broker_connections")
      .select("*").eq("user_id", userId).eq("broker_type", "metaapi").eq("is_active", true).in("id", ids);
    if (!connections || connections.length === 0) return ["no_connection"];

    for (const conn of connections) {
      try {
        let authToken = conn.api_key;
        let metaAccountId = conn.account_id;
        if (metaAccountId.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
          authToken = conn.account_id;
          metaAccountId = conn.api_key;
        }
        // Use region-failover metaFetch instead of hardcoded London URL

        // Find broker position by comment tag
        const { res: posRes, body: posBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/positions`);
        if (!posRes.ok) { results.push(`${conn.display_name}: positions fetch failed ${posRes.status}`); continue; }
        const brokerPositions: any[] = JSON.parse(posBody);
        // MT4 truncates comments to ~31 chars, so use startsWith on the short prefix
        const commentTag = `paper:${positionId}`;
        const shortTag = commentTag.slice(0, 28); // safe for MT4 truncation
        const brokerPos = brokerPositions.find((p: any) =>
          p.comment && (p.comment.includes(commentTag) || p.comment.startsWith(shortTag))
        );
        if (!brokerPos) {
          // Fallback: match by resolved broker symbol
          const base = symbol.replace("/", "");
          const overrides = conn.symbol_overrides || {};
          const brokerSymbol = overrides[base] || (base + (conn.symbol_suffix || ""));
          const symMatch = brokerPositions.find((p: any) =>
            p.symbol === brokerSymbol || p.symbol === base ||
            p.symbol?.replace(/[._\-]/g, "").toUpperCase() === base.toUpperCase()
          );
          if (!symMatch) { results.push(`${conn.display_name}: position not found`); continue; }
          const closeBody = { actionType: "POSITION_CLOSE_ID", positionId: symMatch.id };
          const { res } = await metaFetch(metaAccountId, authToken, (base) => `${base}/trade`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(closeBody) });
          results.push(`${conn.display_name}: ${res.ok ? "closed (symbol match)" : "close failed " + res.status}`);
          continue;
        }
        const closeBody = { actionType: "POSITION_CLOSE_ID", positionId: brokerPos.id };
        const { res } = await metaFetch(metaAccountId, authToken, (base) => `${base}/trade`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(closeBody) });
        results.push(`${conn.display_name}: ${res.ok ? "closed" : "close failed " + res.status}`);
        if (res.ok) console.log(`Broker close [${conn.display_name}]: closed position for paper:${positionId}`);
        else console.warn(`Broker close [${conn.display_name}]: failed ${res.status}`);
      } catch (e: any) {
        console.warn(`Broker close [${conn.display_name}] error: ${e?.message}`);
        results.push(`${conn.display_name}: error`);
      }
    }
  } catch (e: any) {
    console.warn(`closeBrokerPositions error: ${e?.message}`);
    results.push("error");
  }
  return results;
}

// ─── Modify Broker SL/TP (sync trailing stop & break even to broker) ────────
async function modifyBrokerSL(
  supabase: any,
  userId: string,
  positionId: string,
  symbol: string,
  direction: string,
  newSL: number,
  mirroredConnectionIds: string[] | null | undefined,
  existingTP?: number | null,
): Promise<string[]> {
  const results: string[] = [];
  try {
    const { data: account } = await supabase.from("paper_accounts").select("execution_mode").eq("user_id", userId).single();
    if (account?.execution_mode !== "live") return ["skipped_paper_mode"];

    const ids = (mirroredConnectionIds || []).filter(Boolean);
    if (ids.length === 0) return ["no_mirrored_connections"];

    const { data: connections } = await supabase.from("broker_connections")
      .select("*").eq("user_id", userId).eq("broker_type", "metaapi").eq("is_active", true).in("id", ids);
    if (!connections || connections.length === 0) return ["no_connection"];

    for (const conn of connections) {
      try {
        let authToken = conn.api_key;
        let metaAccountId = conn.account_id;
        if (metaAccountId.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
          authToken = conn.account_id;
          metaAccountId = conn.api_key;
        }

        // Find broker position by comment tag
        const { res: posRes, body: posBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/positions`);
        if (!posRes.ok) { results.push(`${conn.display_name}: positions fetch failed ${posRes.status}`); continue; }
        const brokerPositions: any[] = JSON.parse(posBody);
        const commentTag = `paper:${positionId}`;
        const shortTag = commentTag.slice(0, 28);
        let brokerPos = brokerPositions.find((p: any) =>
          p.comment && (p.comment.includes(commentTag) || p.comment.startsWith(shortTag))
        );
        if (!brokerPos) {
          // Fallback: match by symbol
          const base = symbol.replace("/", "");
          const overrides = conn.symbol_overrides || {};
          const brokerSymbol = overrides[base] || (base + (conn.symbol_suffix || ""));
          brokerPos = brokerPositions.find((p: any) =>
            p.symbol === brokerSymbol || p.symbol === base ||
            p.symbol?.replace(/[._\-]/g, "").toUpperCase() === base.toUpperCase()
          );
        }
        if (!brokerPos) { results.push(`${conn.display_name}: position not found for SL modify`); continue; }

        // Adjust SL for broker spread (same logic as bot-scanner open)
        const spec = SPECS[symbol] || SPECS["EUR/USD"];
        let adjustedSL = newSL;
        if (brokerPos.currentPrice && brokerPos.openPrice) {
          // Estimate spread from broker position data
          // Use a conservative 1-pip buffer for safety
          const safetyBuffer = spec.pipSize;
          adjustedSL = direction === "long" ? newSL - safetyBuffer : newSL + safetyBuffer;
        }

        // H4 fix: Include TP in modify payload to prevent broker from dropping it
        const modifyBody: any = {
          actionType: "POSITION_MODIFY",
          positionId: brokerPos.id,
          stopLoss: adjustedSL,
        };
        if (existingTP != null && existingTP > 0) {
          modifyBody.takeProfit = existingTP;
        }
        const { res, body: resBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/trade`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(modifyBody),
        });
        if (res.ok) {
          console.log(`Broker SL modify [${conn.display_name}]: SL updated to ${adjustedSL} for paper:${positionId}`);
          results.push(`${conn.display_name}: SL modified to ${adjustedSL}`);
        } else {
          console.warn(`Broker SL modify [${conn.display_name}] failed [${res.status}]: ${resBody.slice(0, 300)}`);
          results.push(`${conn.display_name}: modify failed ${res.status}`);
        }
      } catch (e: any) {
        console.warn(`Broker SL modify [${conn.display_name}] error: ${e?.message}`);
        results.push(`${conn.display_name}: error`);
      }
    }
  } catch (e: any) {
    console.warn(`modifyBrokerSL error: ${e?.message}`);
    results.push("error");
  }
  return results;
}

// ─── Partial Close on Broker (mirror partial TP) ────────────────────
async function partialCloseBroker(
  supabase: any,
  userId: string,
  positionId: string,
  symbol: string,
  closeVolumeFraction: number,
  mirroredConnectionIds: string[] | null | undefined,
): Promise<string[]> {
  const results: string[] = [];
  try {
    const { data: account } = await supabase.from("paper_accounts").select("execution_mode").eq("user_id", userId).single();
    if (account?.execution_mode !== "live") return ["skipped_paper_mode"];

    const ids = (mirroredConnectionIds || []).filter(Boolean);
    if (ids.length === 0) return ["no_mirrored_connections"];

    const { data: connections } = await supabase.from("broker_connections")
      .select("*").eq("user_id", userId).eq("broker_type", "metaapi").eq("is_active", true).in("id", ids);
    if (!connections || connections.length === 0) return ["no_connection"];

    for (const conn of connections) {
      try {
        let authToken = conn.api_key;
        let metaAccountId = conn.account_id;
        if (metaAccountId.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
          authToken = conn.account_id;
          metaAccountId = conn.api_key;
        }

        // Find broker position by comment tag
        const { res: posRes, body: posBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/positions`);
        if (!posRes.ok) { results.push(`${conn.display_name}: positions fetch failed ${posRes.status}`); continue; }
        const brokerPositions: any[] = JSON.parse(posBody);
        const commentTag = `paper:${positionId}`;
        const shortTag = commentTag.slice(0, 28);
        let brokerPos = brokerPositions.find((p: any) =>
          p.comment && (p.comment.includes(commentTag) || p.comment.startsWith(shortTag))
        );
        if (!brokerPos) {
          const base = symbol.replace("/", "");
          const overrides = conn.symbol_overrides || {};
          const brokerSymbol = overrides[base] || (base + (conn.symbol_suffix || ""));
          brokerPos = brokerPositions.find((p: any) =>
            p.symbol === brokerSymbol || p.symbol === base ||
            p.symbol?.replace(/[._\-]/g, "").toUpperCase() === base.toUpperCase()
          );
        }
        if (!brokerPos) { results.push(`${conn.display_name}: position not found for partial close`); continue; }

        // Calculate partial close volume: fraction of broker position volume
        const brokerVolume = brokerPos.volume || brokerPos.currentVolume || 0;
        const closeVolume = Math.max(0.01, Math.round(brokerVolume * closeVolumeFraction * 100) / 100);

        const partialBody = {
          actionType: "POSITION_CLOSE_ID",
          positionId: brokerPos.id,
          volume: closeVolume,  // MetaAPI supports partial close via volume parameter
        };
        const { res, body: resBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/trade`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(partialBody),
        });
        if (res.ok) {
          console.log(`Broker partial close [${conn.display_name}]: closed ${closeVolume} lots (${(closeVolumeFraction * 100).toFixed(0)}%) of paper:${positionId}`);
          results.push(`${conn.display_name}: partial closed ${closeVolume} lots`);
        } else {
          console.warn(`Broker partial close [${conn.display_name}] failed [${res.status}]: ${resBody.slice(0, 300)}`);
          results.push(`${conn.display_name}: partial close failed ${res.status}`);
        }
      } catch (e: any) {
        console.warn(`Broker partial close [${conn.display_name}] error: ${e?.message}`);
        results.push(`${conn.display_name}: error`);
      }
    }
  } catch (e: any) {
    console.warn(`partialCloseBroker error: ${e?.message}`);
    results.push("error");
  }
  return results;
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

    const { action, ...payload } = await req.json().catch(() => ({ action: "status" }));

    // Build live conversion rates only for write/engine actions. The dashboard
    // status endpoint is polled frequently and must stay fast/read-only; doing
    // multiple external API requests on every cold status worker was causing
    // runtime churn and intermittent hosted 503s.
    if (action !== "status" && Object.keys(_rateMap).length === 0) {
      try {
        _rateMap = await buildRateMap();
      } catch (e: any) {
        console.warn(`rateMap build failed: ${e?.message} — using fallback rates`);
        _rateMap = { ...FALLBACK_RATES };
      }
    } else if (Object.keys(_rateMap).length === 0) {
      _rateMap = { ...FALLBACK_RATES };
    }

    // ── Get account state ──
    if (action === "status") {
      const { data: account } = await supabase.from("paper_accounts").select("*").eq("user_id", user.id).maybeSingle();

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

      let { data: positions } = await supabase.from("paper_positions").select("*").eq("user_id", user.id).eq("position_status", "open").order("open_time", { ascending: true });
      // ── Always refresh live prices on status poll ──
      // Without this, positions show stale entry-time prices ($0 PnL) between scanner cycles.
      // Uses the lightweight TwelveData /price endpoint (single quote per symbol).
      if (positions && positions.length > 0) {
        const symbols = [...new Set(positions.map((p: any) => p.symbol))] as string[];
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
        await updatePositionPrices(supabase, positions);
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
        for (const pos of (positions || [])) {
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
            const { pnl, pnlPips } = calcPnl(pos.direction, entryPrice, exitPrice, size, pos.symbol);
            const closeBotId = pos.bot_id || "smc";
            await supabase.from("paper_trade_history").insert({
              user_id: user.id, position_id: pos.position_id, symbol: pos.symbol,
              direction: pos.direction, size: size.toString(), entry_price: pos.entry_price,
              exit_price: exitPrice.toString(), pnl: pnl.toFixed(2), pnl_pips: pnlPips.toFixed(1),
              open_time: pos.open_time, closed_at: new Date().toISOString(),
              close_reason: closeReason, signal_reason: pos.signal_reason || "",
              signal_score: pos.signal_score, order_id: pos.order_id,
              source_pending_order_id: pos.source_pending_order_id || null,
              bot_id: closeBotId,
              stop_loss: pos.stop_loss || null, take_profit: pos.take_profit || null,
            });
            // Update balance — route to the correct bot's account
            const closeAcctQ = supabase.from("paper_accounts").select("balance, peak_balance").eq("user_id", user.id);
            if (account?.bot_id) closeAcctQ.eq("bot_id", closeBotId);
            const { data: closeAcct } = await closeAcctQ.maybeSingle();
            const curBal = parseFloat(closeAcct?.balance || account?.balance || "10000");
            const newBal = curBal + pnl;
            const newPeak = Math.max(parseFloat(closeAcct?.peak_balance || account?.peak_balance || "10000"), newBal);
            const closeBalUpd = supabase.from("paper_accounts").update({
              balance: newBal.toFixed(2), peak_balance: newPeak.toFixed(2),
            }).eq("user_id", user.id);
            if (account?.bot_id) closeBalUpd.eq("bot_id", closeBotId);
            await closeBalUpd;

            // Generate post-mortem
            const postMortem = generatePostMortem(pos, exitPrice, pnl, pnlPips, closeReason);
            await supabase.from("trade_post_mortems").insert({
              user_id: user.id, position_id: pos.position_id, symbol: pos.symbol,
              exit_reason: closeReason, exit_price: exitPrice.toString(), pnl: pnl.toFixed(2),
              what_worked: postMortem.whatWorked, what_failed: postMortem.whatFailed,
              lesson_learned: postMortem.lessonLearned, detail_json: postMortem,
            });

            await supabase.from("paper_positions").delete().eq("id", pos.id);
            closedIds.push(pos.id);

            await logClose(supabase, user.id, pos, {
              closeReason, closeSource: "auto_engine", pnl, exitPrice,
            });
            // Mirror close to ONLY the brokers this position was mirrored to at open time
            const brokerCloseResults = await closeBrokerPositions(supabase, user.id, pos.position_id, pos.symbol, pos.mirrored_connection_ids);
            console.log(`Auto-close broker mirror [${pos.position_id}] ${closeReason}: ${brokerCloseResults.join("; ")}`);
          }
        }

        // Re-fetch positions after auto-closes
        if (closedIds.length > 0) {
          const { data: remaining } = await supabase.from("paper_positions").select("*").eq("user_id", user.id).eq("position_status", "open").order("open_time", { ascending: true });
          positions = remaining || [];
          // Re-fetch account for updated balance
          const { data: updatedAccount } = await supabase.from("paper_accounts").select("*").eq("user_id", user.id).maybeSingle();
          if (updatedAccount) Object.assign(account, updatedAccount);
        }
      }
      const { data: pending } = await supabase.from("paper_positions").select("*").eq("user_id", user.id).eq("position_status", "pending");
      const { data: history } = await supabase.from("paper_trade_history").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(500);
      // Fetch post-mortems for closed trades (keyed by position_id)
      const { data: postMortems } = await supabase.from("trade_post_mortems").select("position_id, what_worked, what_failed, lesson_learned, detail_json").eq("user_id", user.id).order("created_at", { ascending: false }).limit(500);
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
          pnl: calcPnl(p.direction, parseFloat(p.entry_price), parseFloat(p.current_price), parseFloat(p.size), p.symbol).pnl,
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
      const { data: account } = await supabase.from("paper_accounts").select("*").eq("user_id", user.id).maybeSingle();
      if (!account) {
        await supabase.from("paper_accounts").insert({ user_id: user.id, balance: "10000", peak_balance: "10000", daily_pnl_base: "10000" });
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

      await supabase.from("paper_positions").insert({
        user_id: user.id, position_id: positionId, symbol, direction, size: size.toString(),
        entry_price: entryPrice.toString(), current_price: entryPrice.toString(),
        stop_loss: adjustedSL?.toString() || null, take_profit: adjustedTP?.toString() || null,
        open_time: now, signal_reason: signalReason || "", signal_score: (signalScore || 0).toString(),
        order_id: orderId, position_status: "open",
      });

      // Mirror to MT5 if connected
      let mt5Mirror: any = null;
      const { data: acctForMode } = await supabase.from("paper_accounts").select("execution_mode").eq("user_id", user.id).maybeSingle();
      if (acctForMode?.execution_mode === "live") {
        mt5Mirror = await mirrorToMT5(supabase, user.id, {
          action: "open", symbol, direction, size, stopLoss: adjustedSL, takeProfit: adjustedTP, positionId,
        });
        if (mt5Mirror.success) {
          const mirroredIds = mt5Mirror.connectionIds || (mt5Mirror.connectionId ? [mt5Mirror.connectionId] : []);
          console.log(`MT5 mirror: opened ${symbol} ${direction} ${size} lots on ${mirroredIds.length} connection(s)`);
          // Record ALL broker connections this position was mirrored to so close
          // fan-out targets only these connections.
          if (mirroredIds.length > 0) {
            await supabase.from("paper_positions")
              .update({ mirrored_connection_ids: mirroredIds })
              .eq("position_id", positionId).eq("user_id", user.id);
          }
        } else if (mt5Mirror.error !== "no_connection") {
          console.warn(`MT5 mirror failed: ${mt5Mirror.error}`);
        }
      }

      return respond({ success: true, positionId, orderId, mt5Mirror });
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

      const ep = exitPrice || parseFloat(pos.current_price);
      const { pnl, pnlPips } = calcPnl(pos.direction, parseFloat(pos.entry_price), ep, parseFloat(pos.size), pos.symbol);
      const closeReason = payload.reason || "manual";

      // Record in history
      await supabase.from("paper_trade_history").insert({
        user_id: user.id, position_id: pos.position_id, symbol: pos.symbol,
        direction: pos.direction, size: pos.size, entry_price: pos.entry_price,
        exit_price: ep.toString(), pnl: pnl.toString(), pnl_pips: pnlPips.toString(),
        open_time: pos.open_time, closed_at: new Date().toISOString(),
        close_reason: closeReason, signal_reason: pos.signal_reason || "",
        signal_score: pos.signal_score, order_id: pos.order_id,
        source_pending_order_id: pos.source_pending_order_id || null,
        stop_loss: pos.stop_loss || null, take_profit: pos.take_profit || null,
      });

      // Update balance
      const { data: account } = await supabase.from("paper_accounts").select("*").eq("user_id", user.id).single();
      const newBalance = parseFloat(account.balance) + pnl;
      const newPeak = Math.max(parseFloat(account.peak_balance), newBalance);
      await supabase.from("paper_accounts").update({
        balance: newBalance.toString(),
        peak_balance: newPeak.toString(),
      }).eq("user_id", user.id);

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

      // Remove position
      await supabase.from("paper_positions").delete().eq("id", pos.id);

      await logClose(supabase, user.id, pos, {
        closeReason, closeSource: "user", pnl, exitPrice: ep,
      });
      // Mirror close ONLY to brokers this position was mirrored to at open time
      const brokerCloseResults = await closeBrokerPositions(supabase, user.id, pos.position_id, pos.symbol, pos.mirrored_connection_ids);
      console.log(`Manual close broker mirror [${pos.position_id}]: ${brokerCloseResults.join("; ")}`);

      return respond({ success: true, pnl, pnlPips, postMortem, brokerClose: brokerCloseResults });
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
        // Close all open positions
        const { data: positions } = await supabase.from("paper_positions").select("*")
          .eq("user_id", user.id).eq("position_status", "open");
        const { data: account } = await supabase.from("paper_accounts").select("*").eq("user_id", user.id).single();

        if (positions && positions.length > 0) {
          let totalPnl = 0;
          for (const pos of positions) {
            const ep = parseFloat(pos.current_price);
            const { pnl, pnlPips } = calcPnl(pos.direction, parseFloat(pos.entry_price), ep, parseFloat(pos.size), pos.symbol);
            totalPnl += pnl;

            await supabase.from("paper_trade_history").insert({
              user_id: user.id, position_id: pos.position_id, symbol: pos.symbol,
              direction: pos.direction, size: pos.size, entry_price: pos.entry_price,
              exit_price: ep.toString(), pnl: pnl.toString(), pnl_pips: pnlPips.toString(),
              open_time: pos.open_time, closed_at: new Date().toISOString(),
              close_reason: "kill_switch", signal_reason: pos.signal_reason || "",
              signal_score: pos.signal_score, order_id: pos.order_id,
              source_pending_order_id: pos.source_pending_order_id || null,
              stop_loss: pos.stop_loss || null, take_profit: pos.take_profit || null,
            });

            const postMortem = generatePostMortem(pos, ep, pnl, pnlPips, "kill_switch");
            await supabase.from("trade_post_mortems").insert({
              user_id: user.id, position_id: pos.position_id, symbol: pos.symbol,
              exit_reason: "kill_switch", exit_price: ep.toString(), pnl: pnl.toString(),
              what_worked: postMortem.whatWorked, what_failed: postMortem.whatFailed,
              lesson_learned: postMortem.lessonLearned, detail_json: postMortem,
            });
            await logClose(supabase, user.id, pos, {
              closeReason: "kill_switch", closeSource: "kill_switch", pnl, exitPrice: ep,
            });
            // Mirror close ONLY to brokers this position was mirrored to at open time
            const brokerCloseResults = await closeBrokerPositions(supabase, user.id, pos.position_id, pos.symbol, pos.mirrored_connection_ids);
            console.log(`Kill switch broker close [${pos.position_id}]: ${brokerCloseResults.join("; ")}`);
          }

          await supabase.from("paper_positions").delete().eq("user_id", user.id);

          if (account) {
            const newBal = parseFloat(account.balance) + totalPnl;
            await supabase.from("paper_accounts").update({
              balance: newBal.toString(),
              peak_balance: Math.max(parseFloat(account.peak_balance), newBal).toString(),
            }).eq("user_id", user.id);
          }
        }

        await supabase.from("paper_accounts").update({
          kill_switch_active: true, is_running: false, is_paused: false,
        }).eq("user_id", user.id);
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
      return respond({ success: true, startingBalance: startBal, paused: true });
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

function respond(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
