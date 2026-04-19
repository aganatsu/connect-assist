import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

// ─── Yahoo Finance Symbol Mapping ───────────────────────────────────
const YAHOO_SYMBOLS: Record<string, string> = {
  // Forex Majors
  "EUR/USD": "EURUSD=X", "GBP/USD": "GBPUSD=X", "USD/JPY": "USDJPY=X",
  "AUD/USD": "AUDUSD=X", "NZD/USD": "NZDUSD=X", "USD/CAD": "USDCAD=X",
  "USD/CHF": "USDCHF=X",
  // Forex Crosses
  "EUR/GBP": "EURGBP=X", "EUR/JPY": "EURJPY=X", "GBP/JPY": "GBPJPY=X",
  "EUR/AUD": "EURAUD=X", "EUR/CAD": "EURCAD=X", "EUR/CHF": "EURCHF=X",
  "EUR/NZD": "EURNZD=X", "GBP/AUD": "GBPAUD=X", "GBP/CAD": "GBPCAD=X",
  "GBP/CHF": "GBPCHF=X", "GBP/NZD": "GBPNZD=X", "AUD/CAD": "AUDCAD=X",
  "AUD/JPY": "AUDJPY=X", "CAD/JPY": "CADJPY=X",
  // Indices
  "US30": "YM=F", "NAS100": "NQ=F", "SPX500": "ES=F",
  // Commodities
  "XAU/USD": "GC=F", "XAG/USD": "SI=F", "US Oil": "CL=F",
  // Crypto
  "BTC/USD": "BTC-USD", "ETH/USD": "ETH-USD",
};

async function fetchLivePrice(symbol: string): Promise<number | null> {
  const yahooSymbol = YAHOO_SYMBOLS[symbol];
  if (!yahooSymbol) return null;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "SMC-Trading-Dashboard/1.0" } });
    const data = await res.json();
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return price ? Number(price) : null;
  } catch {
    return null;
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

function calcPnl(dir: string, entry: number, current: number, size: number, symbol: string) {
  const spec = SPECS[symbol] || SPECS["EUR/USD"];
  const diff = dir === "long" ? current - entry : entry - current;
  return { pnl: diff * spec.lotUnits * size, pnlPips: diff / spec.pipSize };
}

// ─── MetaAPI Region Failover ──────────────────────────────────────────────────
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
    console.warn(`MetaAPI ${region} returned ${res.status} (region/connection mismatch), trying next...`);
  }
  return { res: new Response(lastBody, { status: lastStatus }), body: lastBody };
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

  // Parse factors from signal reason (all 17 ICT factors)
  const factorNames = [
    "Market Structure", "Order Block", "Fair Value Gap", "Premium/Discount",
    "Session/Kill Zone", "Judas Swing", "PD/PW Levels", "Reversal Candle", "Liquidity Sweep",
    "Displacement", "Breaker Block", "Unicorn Model", "Silver Bullet",
    "Macro Window", "SMT Divergence", "VWAP", "AMD Phase",
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
    lessonLearned = signalScore >= 7
      ? "High-confluence setup played out as expected. Continue targeting similar setups."
      : "Trade won despite moderate confluence. Consider if the setup was fortunate or skill-based.";
  } else if (outcome === "Loss") {
    whatWorked = presentFactors.length > 0
      ? `These factors were correctly identified: ${presentFactors.join(", ")}`
      : "Signal was generated but lacked strong confluence";
    whatFailed = closeReason === "sl_hit"
      ? "Stop loss was hit — market structure changed after entry or SL was too tight"
      : `Trade closed with loss: ${closeReason}`;
    lessonLearned = signalScore < 7
      ? `Confluence score was ${signalScore}/10. Consider raising minimum threshold to reduce weak signals.`
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
    // Use getClaims() for local JWT verification — no network call, prevents 150s hang on expired tokens
    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: authError } = await supabase.auth.getClaims(token);
    if (authError || !claimsData?.claims?.sub) {
      return new Response(JSON.stringify({ error: "Unauthorized", code: "invalid_jwt", details: authError?.message }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const user = { id: claimsData.claims.sub as string };

    const { action, ...payload } = await req.json();

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
      // Update current prices from live market data
      if (positions && positions.length > 0) {
        await updatePositionPrices(supabase, positions);
        // Re-fetch with updated prices
        const { data: refreshed } = await supabase.from("paper_positions").select("*").eq("user_id", user.id).eq("position_status", "open").order("open_time", { ascending: true });
        positions = refreshed || positions;

        // ── SL/TP Hit Detection + Exit Flag Logic (Fix #9, #13) ──
        const closedIds: string[] = [];
        for (const pos of (positions || [])) {
          const currentPrice = parseFloat(pos.current_price);
          const entryPrice = parseFloat(pos.entry_price);
          let sl = pos.stop_loss ? parseFloat(pos.stop_loss) : null;
          const tp = pos.take_profit ? parseFloat(pos.take_profit) : null;
          const size = parseFloat(pos.size);
          let closeReason: string | null = null;
          let exitPrice = currentPrice;

          // Parse exit flags from signal_reason
          let exitFlags: any = {};
          try {
            const parsed = JSON.parse(pos.signal_reason || "{}");
            exitFlags = parsed.exitFlags || {};
          } catch {}

          // Check SL hit
          // FIX 3 + FIX 4: Gap-through pricing + slippage simulation
          // If price gaps through SL, use the gap price. Then add simulated slippage.
          // close_reason on paper_positions is reused as a "sl state" tag:
          //   null/"" = original SL, "be" = moved to break-even, "trail" = trailing stop active
          const slState: string = (pos.close_reason || "").toString();
          const slHitReason = slState === "trail" ? "trail_hit" : slState === "be" ? "be_hit" : "sl_hit";
          const slippagePips = exitFlags.slippagePips ?? 0.5; // default 0.5 pips slippage on SL
          if (sl !== null) {
            if (pos.direction === "long" && currentPrice <= sl) {
              closeReason = slHitReason;
              const gapPrice = Math.min(sl, currentPrice); // Use worse price (lower for longs)
              const spec = SPECS[pos.symbol] || SPECS["EUR/USD"];
              exitPrice = gapPrice - (slippagePips * spec.pipSize); // Slippage worsens the fill
            } else if (pos.direction === "short" && currentPrice >= sl) {
              closeReason = slHitReason;
              const gapPrice = Math.max(sl, currentPrice); // Use worse price (higher for shorts)
              const spec = SPECS[pos.symbol] || SPECS["EUR/USD"];
              exitPrice = gapPrice + (slippagePips * spec.pipSize); // Slippage worsens the fill
            }
          }

          // Check TP hit
          if (!closeReason && tp !== null) {
            if (pos.direction === "long" && currentPrice >= tp) {
              closeReason = "tp_hit"; exitPrice = tp;
            } else if (pos.direction === "short" && currentPrice <= tp) {
              closeReason = "tp_hit"; exitPrice = tp;
            }
          }

          // Check max hold hours
          if (!closeReason && exitFlags.maxHoldHours && exitFlags.maxHoldHours > 0) {
            const openMs = new Date(pos.open_time).getTime();
            const elapsedHours = (Date.now() - openMs) / 3600000;
            if (elapsedHours >= exitFlags.maxHoldHours) {
              closeReason = "time_exit";
            }
          }

          // Break even: move SL to entry if price moved enough in profit
          if (!closeReason && exitFlags.breakEven && exitFlags.breakEvenPips > 0 && sl !== null) {
            const spec = SPECS[pos.symbol] || SPECS["EUR/USD"];
            const profitPips = pos.direction === "long"
              ? (currentPrice - entryPrice) / spec.pipSize
              : (entryPrice - currentPrice) / spec.pipSize;
            if (profitPips >= exitFlags.breakEvenPips) {
              // Move SL to entry (break even)
              const newSL = entryPrice;
              if ((pos.direction === "long" && newSL > sl) || (pos.direction === "short" && newSL < sl)) {
                await supabase.from("paper_positions").update({ stop_loss: newSL.toString(), close_reason: "be" }).eq("id", pos.id);
                sl = newSL; // Update local reference
                pos.close_reason = "be"; // keep local in sync for trail check below
                // FIX 1: Sync break-even SL to broker
                const beModifyResults = await modifyBrokerSL(supabase, user.id, pos.position_id, pos.symbol, pos.direction, newSL, pos.mirrored_connection_ids, tp);
                console.log(`Break-even broker SL sync [${pos.position_id}]: ${beModifyResults.join("; ")}`);
              }
            }
          }

          // Trailing stop: move SL to lock in profit as price moves favorably
          if (!closeReason && exitFlags.trailingStop && exitFlags.trailingStopPips > 0 && sl !== null) {
            const spec = SPECS[pos.symbol] || SPECS["EUR/USD"];
            const profitPips = pos.direction === "long"
              ? (currentPrice - entryPrice) / spec.pipSize
              : (entryPrice - currentPrice) / spec.pipSize;
            // Determine activation threshold
            const activationPips = exitFlags.trailingStopActivation === "after_1r" && exitFlags.tpRatio
              ? Math.abs(entryPrice - sl) / spec.pipSize  // 1R in pips
              : exitFlags.trailingStopPips * 2;           // default: activate after 2x trailing distance
            if (profitPips >= activationPips) {
              // Trail SL behind current price by trailingStopPips
              const trailDistance = exitFlags.trailingStopPips * spec.pipSize;
              const newSL = pos.direction === "long"
                ? currentPrice - trailDistance
                : currentPrice + trailDistance;
              // Only move SL in favorable direction (never widen it)
              if ((pos.direction === "long" && newSL > sl) || (pos.direction === "short" && newSL < sl)) {
                await supabase.from("paper_positions").update({ stop_loss: newSL.toString(), close_reason: "trail" }).eq("id", pos.id);
                sl = newSL; // Update local reference for SL check above
                pos.close_reason = "trail";
                // FIX 1: Sync trailing SL to broker
                const trailModifyResults = await modifyBrokerSL(supabase, user.id, pos.position_id, pos.symbol, pos.direction, newSL, pos.mirrored_connection_ids, tp);
                console.log(`Trailing stop broker SL sync [${pos.position_id}]: ${trailModifyResults.join("; ")}`);
              }
            }
          }

          // Partial take profit: close a portion of the position at first TP level
          // Guard: only fire once per position using partial_tp_fired flag (fixes runaway loop)
          if (!closeReason && exitFlags.partialTP && exitFlags.partialTPPercent > 0 && exitFlags.partialTPLevel > 0 && tp !== null && sl !== null && !pos.partial_tp_fired) {
            const spec = SPECS[pos.symbol] || SPECS["EUR/USD"];
            const profitPips = pos.direction === "long"
              ? (currentPrice - entryPrice) / spec.pipSize
              : (entryPrice - currentPrice) / spec.pipSize;
            const slDistancePips = Math.abs(entryPrice - sl) / spec.pipSize;
            const partialTriggerPips = slDistancePips * exitFlags.partialTPLevel; // e.g., 1.0R
            if (profitPips >= partialTriggerPips) {
              // Close partialTPPercent of the position
              const closeSize = size * (exitFlags.partialTPPercent / 100);
              const remainSize = size - closeSize;
              const { pnl: partialPnl, pnlPips: partialPnlPips } = calcPnl(pos.direction, entryPrice, currentPrice, closeSize, pos.symbol);
              // Record partial close in history
              await supabase.from("paper_trade_history").insert({
                user_id: user.id, position_id: `${pos.position_id}_partial`, symbol: pos.symbol,
                direction: pos.direction, size: closeSize.toString(), entry_price: pos.entry_price,
                exit_price: currentPrice.toString(), pnl: partialPnl.toFixed(2), pnl_pips: partialPnlPips.toFixed(1),
                open_time: pos.open_time, closed_at: new Date().toISOString(),
                close_reason: "partial_tp", signal_reason: pos.signal_reason || "",
                signal_score: pos.signal_score, order_id: pos.order_id,
                stop_loss: pos.stop_loss || null, take_profit: pos.take_profit || null,
              });
              // Update position size and set fired flag, then update balance
              await supabase.from("paper_positions").update({
                size: remainSize.toString(),
                partial_tp_fired: true,
              }).eq("id", pos.id);
              // Determine which bot's account to update based on position's bot_id
              const posBotId = pos.bot_id || "smc";
              const acctQuery = supabase.from("paper_accounts").select("balance, peak_balance").eq("user_id", user.id);
              if (account?.bot_id) acctQuery.eq("bot_id", posBotId);
              const { data: posAcct } = await acctQuery.maybeSingle();
              const curBal = parseFloat(posAcct?.balance || account?.balance || "10000");
              const newBal = curBal + partialPnl;
              const newPeak = Math.max(parseFloat(posAcct?.peak_balance || account?.peak_balance || "10000"), newBal);
              const balUpd = supabase.from("paper_accounts").update({
                balance: newBal.toFixed(2), peak_balance: newPeak.toFixed(2),
              }).eq("user_id", user.id);
              if (account?.bot_id) balUpd.eq("bot_id", posBotId);
              await balUpd;
              console.log(`Partial TP: closed ${closeSize.toFixed(4)} of ${pos.symbol} at ${currentPrice}, PnL: $${partialPnl.toFixed(2)} (flag set, won't re-fire)`);
              // FIX 2: Mirror partial close to broker
              const partialBrokerResults = await partialCloseBroker(supabase, user.id, pos.position_id, pos.symbol, exitFlags.partialTPPercent / 100, pos.mirrored_connection_ids);
              console.log(`Partial TP broker mirror [${pos.position_id}]: ${partialBrokerResults.join("; ")}`);
            }
          }

          // Close position if SL/TP/time triggered
          if (closeReason) {
            const { pnl, pnlPips } = calcPnl(pos.direction, entryPrice, exitPrice, size, pos.symbol);
            const closeBotId = pos.bot_id || "smc";
            await supabase.from("paper_trade_history").insert({
              user_id: user.id, position_id: pos.position_id, symbol: pos.symbol,
              direction: pos.direction, size: pos.size, entry_price: pos.entry_price,
              exit_price: exitPrice.toString(), pnl: pnl.toFixed(2), pnl_pips: pnlPips.toFixed(1),
              open_time: pos.open_time, closed_at: new Date().toISOString(),
              close_reason: closeReason, signal_reason: pos.signal_reason || "",
              signal_score: pos.signal_score, order_id: pos.order_id,
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
      const { data: history } = await supabase.from("paper_trade_history").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(50);

      const balance = parseFloat(account?.balance || "10000");
      const peakBalance = parseFloat(account?.peak_balance || "10000");
      const posArr = (positions || []).map((p: any) => ({
        id: p.position_id, symbol: p.symbol, direction: p.direction,
        size: parseFloat(p.size), entryPrice: parseFloat(p.entry_price),
        currentPrice: parseFloat(p.current_price),
        pnl: calcPnl(p.direction, parseFloat(p.entry_price), parseFloat(p.current_price), parseFloat(p.size), p.symbol).pnl,
        stopLoss: p.stop_loss ? parseFloat(p.stop_loss) : null,
        takeProfit: p.take_profit ? parseFloat(p.take_profit) : null,
        openTime: p.open_time, signalReason: p.signal_reason || "",
        signalScore: parseFloat(p.signal_score || "0"), orderId: p.order_id,
        botId: p.bot_id || "smc",
      }));
      const unrealizedPnl = posArr.reduce((s: number, p: any) => s + p.pnl, 0);
      const histArr = (history || []).map((t: any) => ({
        id: t.position_id, symbol: t.symbol, direction: t.direction,
        size: parseFloat(t.size), entryPrice: parseFloat(t.entry_price),
        exitPrice: parseFloat(t.exit_price), pnl: parseFloat(t.pnl),
        pnlPips: parseFloat(t.pnl_pips), openTime: t.open_time,
        closedAt: t.closed_at, closeReason: t.close_reason,
        signalReason: t.signal_reason || "", signalScore: parseFloat(t.signal_score || "0"),
        orderId: t.order_id,
        botId: t.bot_id || "smc",
      }));
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

      await supabase.from("paper_positions").insert({
        user_id: user.id, position_id: positionId, symbol, direction, size: size.toString(),
        entry_price: entryPrice.toString(), current_price: entryPrice.toString(),
        stop_loss: stopLoss?.toString() || null, take_profit: takeProfit?.toString() || null,
        open_time: now, signal_reason: signalReason || "", signal_score: (signalScore || 0).toString(),
        order_id: orderId, position_status: "open",
      });

      // Mirror to MT5 if connected
      let mt5Mirror: any = null;
      const { data: acctForMode } = await supabase.from("paper_accounts").select("execution_mode").eq("user_id", user.id).maybeSingle();
      if (acctForMode?.execution_mode === "live") {
        mt5Mirror = await mirrorToMT5(supabase, user.id, {
          action: "open", symbol, direction, size, stopLoss, takeProfit, positionId,
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

      if (Object.keys(updates).length === 0) return respond({ success: true, unchanged: true });

      const { data: updated, error: updErr } = await supabase
        .from("paper_positions")
        .update(updates)
        .eq("id", pos.id)
        .select()
        .single();
      if (updErr) throw updErr;
      return respond({ success: true, position: updated });
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

    if (action === "reset_account") {
      await supabase.from("paper_positions").delete().eq("user_id", user.id);
      await supabase.from("paper_trade_history").delete().eq("user_id", user.id);
      await supabase.from("trade_reasonings").delete().eq("user_id", user.id);
      await supabase.from("trade_post_mortems").delete().eq("user_id", user.id);
      await supabase.from("scan_logs").delete().eq("user_id", user.id);
      await supabase.from("paper_accounts").update({
        balance: "10000", peak_balance: "10000", is_running: false, is_paused: false,
        scan_count: 0, signal_count: 0, rejected_count: 0, daily_pnl_base: "10000",
        daily_pnl_date: "", kill_switch_active: false, execution_mode: "paper",
      }).eq("user_id", user.id);
      return respond({ success: true });
    }

    if (action === "set_execution_mode") {
      await supabase.from("paper_accounts").update({ execution_mode: payload.mode }).eq("user_id", user.id);
      return respond({ success: true });
    }

    return respond({ error: "Unknown action" });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
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

function respond(data: any) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
