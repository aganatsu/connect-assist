import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import { normalizeSymKey } from "../_shared/smcAnalysis.ts";
import { resolveSymbol } from "../_shared/brokerSymbols.ts";
import { metaFetch } from "../_shared/metaApiClient.ts";
import {
  type BrokerExecutionConfirmationMode,
  classifyBrokerMutationHttpResponse,
  type OandaDependentOrderTransaction,
} from "../_shared/brokerExecutionLedger.ts";
import { convertLotsToOandaUnits } from "../_shared/unifiedPositionSizing.ts";
import { authorizeScopedCaller } from "../_shared/callerAuth.ts";

// Broker execution — routes orders to OANDA or MetaAPI

// normalizeKey is now an alias for normalizeSymKey from shared module
const normalizeKey = normalizeSymKey;
// resolveSymbol is now imported from ../_shared/brokerSymbols.ts (single source of truth)
// metaFetch is now imported from ../_shared/metaApiClient.ts (single source of truth)

// OANDA uses underscore format (EUR_USD). Honor overrides first.
function resolveOandaSymbol(symbol: string, conn: any): string {
  const rawOverrides = conn.symbol_overrides || {};
  const norm = normalizeKey(symbol);
  for (const [k, v] of Object.entries(rawOverrides)) {
    if (normalizeKey(k) === norm && v) return String(v);
  }
  // Default: convert "EUR/USD" or "EURUSD" to "EUR_USD"
  const cleaned = symbol.trim().replace(/\s+/g, "").toUpperCase();
  if (cleaned.includes("/")) return cleaned.replace("/", "_");
  if (cleaned.length === 6 && !cleaned.includes("_")) return `${cleaned.slice(0, 3)}_${cleaned.slice(3)}`;
  return cleaned;
}

// H10: OANDA price precision — round SL/TP/entry to correct decimal places
function getOandaPrecision(symbol: string): number {
  const s = (symbol || "").toUpperCase().replace(/[\s/_-]/g, "");
  // JPY pairs: 3 decimals
  if (s.includes("JPY")) return 3;
  // Gold: 2 decimals
  if (s.includes("XAU") || s.includes("GOLD")) return 2;
  // Silver: 4 decimals
  if (s.includes("XAG") || s.includes("SILVER")) return 4;
  // Indices: 1 decimal
  if (/^(US30|US500|NAS100|SPX500|UK100|DE30|JP225|AU200|HK50|USTEC)/i.test(s)) return 1;
  // BTC/crypto: 1 decimal
  if (s.includes("BTC") || s.includes("ETH")) return 1;
  // Default forex: 5 decimals
  return 5;
}

function roundOandaPrice(symbol: string, price: number): string {
  const precision = getOandaPrecision(symbol);
  return price.toFixed(precision);
}

function respondWithBrokerMutationOutcome(
  res: Response,
  body: string,
  confirmationMode: BrokerExecutionConfirmationMode,
  requiredOandaTransactions?: readonly OandaDependentOrderTransaction[],
) {
  const outcome = classifyBrokerMutationHttpResponse(
    res,
    body,
    confirmationMode,
    requiredOandaTransactions,
  );
  const parsedBody = outcome.parsedBody;
  const brokerCode = parsedBody?.stringCode || parsedBody?.errorCode;

  if (outcome.status === "succeeded") {
    return respond({
      ...(parsedBody && typeof parsedBody === "object" ? parsedBody : {}),
      ok: true,
      brokerExecutionStatus: "succeeded",
      brokerOrderId: outcome.brokerOrderId,
    });
  }

  const reason = brokerCode && outcome.error !== brokerCode
    ? `${brokerCode}: ${outcome.error}`
    : outcome.error || "Broker did not confirm the mutation";
  return respond({
    ok: false,
    brokerExecutionStatus: outcome.status,
    brokerCode: brokerCode || undefined,
    error: reason,
    details: body ? body.slice(0, 1000) : undefined,
    fallback: outcome.status === "uncertain",
  }, 409);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { action, connectionId, userId: requestedUserId, ...payload } = body;
    const caller = await authorizeScopedCaller(req, requestedUserId);
    if (!caller.authorized) {
      return respond({ error: caller.error, fallback: false }, caller.status);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ||
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
    const databaseKey = caller.serviceRole ? serviceRoleKey : anonKey;
    if (!supabaseUrl || !databaseKey) {
      return respond({ error: "Broker execution is not configured", fallback: false }, 500);
    }

    const authHeader = req.headers.get("Authorization");
    const supabase = createClient(
      supabaseUrl,
      databaseKey,
      caller.serviceRole
        ? { auth: { persistSession: false } }
        : {
          auth: { persistSession: false },
          global: { headers: { Authorization: authHeader! } },
        },
    );

    // Fetch the broker connection
    const { data: conn, error: connErr } = await supabase.from("broker_connections")
      .select("*").eq("id", connectionId).eq("user_id", caller.userId).single();
    if (connErr || !conn) throw new Error("Broker connection not found");

    // Auto-detect swapped fields for MetaAPI: JWT tokens start with "eyJ", account IDs are UUIDs
    if (conn.broker_type === "metaapi") {
      if (conn.account_id.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(conn.api_key)) {
        const tmp = conn.api_key;
        conn.api_key = conn.account_id;
        conn.account_id = tmp;
      }
    }

    if (action === "account_summary") {
      if (conn.broker_type === "oanda") {
        const baseUrl = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
        const res = await fetch(`${baseUrl}/v3/accounts/${conn.account_id}/summary`, {
          headers: { Authorization: `Bearer ${conn.api_key}`, "Content-Type": "application/json" },
        });
        if (!res.ok) { const errText = await res.text(); return respond({ error: `OANDA error: ${res.status}`, details: errText, fallback: res.status >= 500 }, res.status); }
        return respond((await res.json()).account);
      }
      if (conn.broker_type === "metaapi") {
        const { res, body } = await metaFetch(conn.account_id, conn.api_key, (b) => `${b}/account-information`);
        if (!res.ok) return respond({ error: `MetaAPI error: ${res.status}`, details: body, fallback: res.status >= 500 || /not connected to broker|region/i.test(body) }, 200);
        return respond(JSON.parse(body));
      }
    }

    if (action === "open_trades") {
      if (conn.broker_type === "oanda") {
        const baseUrl = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
        const res = await fetch(`${baseUrl}/v3/accounts/${conn.account_id}/openTrades`, {
          headers: { Authorization: `Bearer ${conn.api_key}` },
        });
        if (!res.ok) { const errText = await res.text(); return respond({ error: `OANDA error: ${res.status}`, details: errText, fallback: res.status >= 500 }, res.status); }
        return respond((await res.json()).trades);
      }
      if (conn.broker_type === "metaapi") {
        const { res, body } = await metaFetch(conn.account_id, conn.api_key, (b) => `${b}/positions`);
        if (!res.ok) return respond({ error: `MetaAPI error: ${res.status}`, details: body, fallback: res.status >= 500 || /not connected to broker|region/i.test(body) }, 200);
        return respond(JSON.parse(body));
      }
    }

    if (action === "place_order") {
      const { symbol, direction, size, stopLoss, takeProfit, positionId } = payload;

      if (conn.broker_type === "oanda") {
        const baseUrl = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
        const oandaInstrument = resolveOandaSymbol(symbol, conn);
        const instrumentRes = await fetch(
          `${baseUrl}/v3/accounts/${conn.account_id}/instruments?instruments=${encodeURIComponent(oandaInstrument)}`,
          { headers: { Authorization: `Bearer ${conn.api_key}` } },
        );
        if (!instrumentRes.ok) {
          const details = await instrumentRes.text();
          return respond({
            error: `OANDA instrument specification failed: ${instrumentRes.status}`, details,
            fallback: instrumentRes.status >= 500,
          }, instrumentRes.status);
        }
        const instrument = (await instrumentRes.json()).instruments?.[0];
        if (!instrument) {
          return respond({ error: `OANDA instrument not found: ${oandaInstrument}`, fallback: false }, 400);
        }
        const unitConversion = convertLotsToOandaUnits({
          symbol,
          lots: Number(size),
          direction,
          tradeUnitsPrecision: Number(instrument.tradeUnitsPrecision),
          minimumTradeSize: Number(instrument.minimumTradeSize),
          maximumOrderUnits: Number(instrument.maximumOrderUnits),
        });
        if (!unitConversion.ok) {
          return respond({ error: `OANDA size rejected: ${unitConversion.error}`, fallback: false }, 400);
        }
        // H10: Round prices to correct OANDA precision
        const slPrice = stopLoss ? roundOandaPrice(symbol, stopLoss) : null;
        const tpPrice = takeProfit ? roundOandaPrice(symbol, takeProfit) : null;
        const orderBody: any = {
          order: { type: "MARKET", instrument: oandaInstrument, units: unitConversion.units, timeInForce: "FOK", positionFill: "DEFAULT" },
        };
        if (positionId) {
          const clientId = String(positionId).slice(0, 128);
          const clientComment = `paper:${positionId}`.slice(0, 128);
          orderBody.order.clientExtensions = {
            id: clientId,
            tag: "smc",
            comment: clientComment,
          };
          orderBody.order.tradeClientExtensions = {
            id: clientId,
            tag: "smc",
            comment: clientComment,
          };
        }
        if (slPrice) orderBody.order.stopLossOnFill = { price: slPrice, timeInForce: "GTC" };
        if (tpPrice) orderBody.order.takeProfitOnFill = { price: tpPrice };

        // Market orders are never retried automatically. A timeout or lost 5xx
        // response may still mean OANDA accepted the order.
        const res = await fetch(`${baseUrl}/v3/accounts/${conn.account_id}/orders`, {
          method: "POST", headers: { Authorization: `Bearer ${conn.api_key}`, "Content-Type": "application/json" },
          body: JSON.stringify(orderBody),
        });
        const body = await res.text();
        return respondWithBrokerMutationOutcome(
          res,
          body,
          "oanda_trade_open",
        );
      }

      if (conn.broker_type === "metaapi") {
        const tradeBody: any = {
          actionType: direction === "long" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
          symbol: resolveSymbol(symbol, conn), volume: size,
        };
        if (positionId) tradeBody.comment = `paper:${positionId}`;
        if (stopLoss) tradeBody.stopLoss = stopLoss;
        if (takeProfit) tradeBody.takeProfit = takeProfit;

        // Do not region-failover a market order. If the first response is
        // uncertain, the caller's durable ledger must reconcile before retry.
        const { res, body } = await metaFetch(
          conn.account_id,
          conn.api_key,
          (b) => `${b}/trade`,
          {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(tradeBody),
          },
          { allowFailover: false },
        );
        return respondWithBrokerMutationOutcome(
          res,
          body,
          "metaapi_position_open",
        );
      }
    }

    if (action === "account_balance") {
      if (conn.broker_type === "oanda") {
        const baseUrl = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
        const res = await fetch(`${baseUrl}/v3/accounts/${conn.account_id}/summary`, {
          headers: { Authorization: `Bearer ${conn.api_key}`, "Content-Type": "application/json" },
        });
        if (!res.ok) { const errText = await res.text(); return respond({ error: `OANDA error: ${res.status}`, details: errText, fallback: res.status >= 500 }, res.status); }
        const acct = (await res.json()).account;
        return respond({
          balance: parseFloat(acct.balance ?? "0"),
          equity: parseFloat(acct.NAV ?? acct.balance ?? "0"),
          currency: acct.currency ?? "USD",
        });
      }
      if (conn.broker_type === "metaapi") {
        const { res, body } = await metaFetch(conn.account_id, conn.api_key, (b) => `${b}/account-information`);
        if (!res.ok) return respond({ error: `MetaAPI error: ${res.status}`, details: body, fallback: res.status >= 500 || /not connected to broker|region/i.test(body) }, 200);
        const info: any = JSON.parse(body);
        return respond({
          balance: parseFloat(info.balance ?? "0"),
          equity: parseFloat(info.equity ?? info.balance ?? "0"),
          currency: info.currency ?? "USD",
        });
      }
      throw new Error(`account_balance not supported for broker type: ${conn.broker_type}`);
    }

    if (action === "symbol_specs" || action === "validate_symbol") {
      const { symbol, brokerSymbol } = payload;
      if (!symbol) throw new Error("Missing symbol parameter");

      if (conn.broker_type === "metaapi") {
        let authToken = conn.api_key;
        let metaAccountId = conn.account_id;
        if (metaAccountId.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
          authToken = conn.account_id;
          metaAccountId = conn.api_key;
        }
        const brokerSym = (brokerSymbol || resolveSymbol(symbol, conn)).toString();
        const { res, body } = await metaFetch(metaAccountId, authToken, (b) => `${b}/symbols/${encodeURIComponent(brokerSym)}/specification`);
        if (!res.ok) {
          if (action === "validate_symbol") {
            return respond({ ok: false, brokerSymbol: brokerSym, status: res.status, error: body.slice(0, 300) });
          }
          return respond({ error: `MetaAPI symbol_specs error: ${res.status}`, details: body, fallback: res.status >= 500 || /not connected to broker|region/i.test(body) }, 200);
        }
        const spec: any = JSON.parse(body);
        if (action === "validate_symbol") {
          return respond({ ok: true, brokerSymbol: brokerSym, digits: spec.digits, minVolume: spec.minVolume, maxVolume: spec.maxVolume });
        }
        return respond({
          contractSize: spec.contractSize ?? 1,
          minVolume: spec.minVolume ?? 0.01,
          maxVolume: spec.maxVolume ?? 100,
          volumeStep: spec.volumeStep ?? 0.01,
          digits: spec.digits ?? 5,
          stopsLevel: spec.stopsLevel ?? 0,
        });
      }

      if (conn.broker_type === "oanda") {
        const baseUrl = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
        const oandaSym = resolveOandaSymbol(symbol, conn);
        const res = await fetch(`${baseUrl}/v3/accounts/${conn.account_id}/instruments?instruments=${encodeURIComponent(oandaSym)}`, {
          headers: { Authorization: `Bearer ${conn.api_key}` },
        });
        if (!res.ok) {
          const errText = await res.text();
          if (action === "validate_symbol") {
            return respond({ ok: false, brokerSymbol: oandaSym, status: res.status, error: errText.slice(0, 300) });
          }
          throw new Error(`OANDA symbol_specs error: ${res.status}`);
        }
        const data: any = await res.json();
        const inst = data.instruments?.[0];
        if (!inst) {
          if (action === "validate_symbol") {
            return respond({ ok: false, brokerSymbol: oandaSym, error: `Instrument not found: ${oandaSym}` });
          }
          throw new Error(`OANDA instrument not found: ${oandaSym}`);
        }
        if (action === "validate_symbol") {
          return respond({ ok: true, brokerSymbol: oandaSym, digits: inst.displayPrecision });
        }
        return respond({
          contractSize: 1,
          minVolume: parseFloat(inst.minimumTradeSize || "0.01"),
          maxVolume: parseFloat(inst.maximumOrderUnits || "100000000"),
          volumeStep: parseFloat(inst.minimumTradeSize || "0.01"),
          digits: inst.displayPrecision ?? 5,
          stopsLevel: 0,
        });
      }

      throw new Error(`${action} not supported for broker type: ${conn.broker_type}`);
    }

    if (action === "connection_status") {
      if (conn.broker_type === "metaapi") {
        // Provisioning API — returns account state regardless of broker connection
        const provUrl = `https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${conn.account_id}`;
        const res = await fetch(provUrl, { headers: { "auth-token": conn.api_key } });
        const body = await res.text();
        if (!res.ok) {
          return respond({ ok: false, state: "unknown", error: `MetaAPI provisioning ${res.status}`, details: body.slice(0, 300), fallback: true }, 503);
        }
        const info: any = JSON.parse(body);
        return respond({
          ok: true,
          state: info.state ?? "UNKNOWN",          // DEPLOYED / UNDEPLOYED / DEPLOYING
          connectionStatus: info.connectionStatus ?? "UNKNOWN", // CONNECTED / DISCONNECTED / DISCONNECTED_FROM_BROKER
          name: info.name,
          login: info.login,
          server: info.server,
          region: info.region,
          ready: info.state === "DEPLOYED" && info.connectionStatus === "CONNECTED",
        });
      }
      if (conn.broker_type === "oanda") {
        const baseUrl = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
        const res = await fetch(`${baseUrl}/v3/accounts/${conn.account_id}/summary`, {
          headers: { Authorization: `Bearer ${conn.api_key}` },
        });
        if (!res.ok) return respond({ ok: false, state: "unknown", error: `OANDA ${res.status}`, fallback: true }, 503);
        const acct = (await res.json()).account;
        return respond({ ok: true, state: "DEPLOYED", connectionStatus: "CONNECTED", ready: true, name: acct.alias, login: acct.id });
      }
      throw new Error(`connection_status not supported for: ${conn.broker_type}`);
    }

    if (action === "close_trade") {
      if (conn.broker_type === "oanda") {
        const baseUrl = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
        const res = await fetch(`${baseUrl}/v3/accounts/${conn.account_id}/trades/${payload.tradeId}/close`, {
          method: "PUT", headers: { Authorization: `Bearer ${conn.api_key}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload.units ? { units: payload.units.toString() } : {}),
        });
        const body = await res.text();
        return respondWithBrokerMutationOutcome(
          res,
          body,
          "oanda_order_fill",
        );
      }
      if (conn.broker_type === "metaapi") {
        const { res, body } = await metaFetch(
          conn.account_id,
          conn.api_key,
          (b) => `${b}/trade`,
          {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ actionType: "POSITION_CLOSE_ID", positionId: payload.tradeId }),
          },
          { allowFailover: false },
        );
        return respondWithBrokerMutationOutcome(res, body, "metaapi_trade");
      }
    }

    if (action === "trade_history") {
      const limit = payload.limit || 50;
      if (conn.broker_type === "oanda") {
        const baseUrl = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
        const res = await fetch(`${baseUrl}/v3/accounts/${conn.account_id}/trades?state=CLOSED&count=${limit}`, {
          headers: { Authorization: `Bearer ${conn.api_key}` },
        });
        if (!res.ok) { const errText = await res.text(); return respond({ error: `OANDA error: ${res.status}`, details: errText, fallback: res.status >= 500 }, res.status); }
        return respond((await res.json()).trades || []);
      }
      if (conn.broker_type === "metaapi") {
        // MetaAPI: fetch history deals for the last 30 days
        const startTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const endTime = new Date().toISOString();
        const { res, body } = await metaFetch(conn.account_id, conn.api_key, (b) => `${b}/history-deals/time/${startTime}/${endTime}`);
        if (!res.ok) return respond({ error: `MetaAPI error: ${res.status}`, details: body, fallback: res.status >= 500 || /not connected to broker|region/i.test(body) }, 200);
        const deals: any[] = JSON.parse(body);
        // Group deals by positionId to reconstruct trades
        const posMap = new Map<string, any[]>();
        for (const deal of deals) {
          if (!deal.positionId) continue;
          if (!posMap.has(deal.positionId)) posMap.set(deal.positionId, []);
          posMap.get(deal.positionId)!.push(deal);
        }
        // Build closed trade records from deal groups
        const closedTrades: any[] = [];
        for (const [posId, posDeals] of posMap) {
          const entry = posDeals.find((d: any) => d.entryType === "DEAL_ENTRY_IN" || d.type?.includes("BUY") || d.type?.includes("SELL"));
          const exit = posDeals.find((d: any) => d.entryType === "DEAL_ENTRY_OUT" || d.entryType === "DEAL_ENTRY_OUT_BY");
          if (!entry || !exit) continue;
          const pnl = posDeals.reduce((s: number, d: any) => s + (d.profit || 0), 0);
          const commission = posDeals.reduce((s: number, d: any) => s + (d.commission || 0), 0);
          const swap = posDeals.reduce((s: number, d: any) => s + (d.swap || 0), 0);
          closedTrades.push({
            positionId: posId,
            symbol: entry.symbol || exit.symbol,
            direction: entry.type?.includes("BUY") ? "long" : "short",
            volume: entry.volume || exit.volume,
            entryPrice: entry.price,
            exitPrice: exit.price,
            openTime: entry.time,
            closeTime: exit.time,
            pnl, commission, swap,
            netPnl: pnl + commission + swap,
            comment: entry.comment || exit.comment || "",
            botManaged: /paper:/i.test(entry.comment || exit.comment || ""),
          });
        }
        closedTrades.sort((a, b) => new Date(b.closeTime).getTime() - new Date(a.closeTime).getTime());
        return respond(closedTrades.slice(0, limit));
      }
    }

    if (action === "modify_trade") {
      const { tradeId, stopLoss, takeProfit } = payload;
      // Input validation (Fix #4)
      if (!tradeId || (typeof tradeId !== "string" && typeof tradeId !== "number")) {
        return respond({ error: "tradeId is required and must be a string or number" }, 400);
      }
      if (stopLoss === undefined && takeProfit === undefined) {
        return respond({ error: "At least one of stopLoss or takeProfit must be provided" }, 400);
      }
      if (stopLoss !== undefined && (typeof stopLoss !== "number" || isNaN(stopLoss) || stopLoss <= 0)) {
        return respond({ error: "stopLoss must be a positive number" }, 400);
      }
      if (takeProfit !== undefined && (typeof takeProfit !== "number" || isNaN(takeProfit) || takeProfit <= 0)) {
        return respond({ error: "takeProfit must be a positive number" }, 400);
      }
      if (conn.broker_type === "metaapi") {
        const modifyBody: any = { actionType: "POSITION_MODIFY", positionId: tradeId };
        if (stopLoss !== undefined) modifyBody.stopLoss = stopLoss;
        if (takeProfit !== undefined) modifyBody.takeProfit = takeProfit;
        const { res, body } = await metaFetch(
          conn.account_id,
          conn.api_key,
          (b) => `${b}/trade`,
          {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(modifyBody),
          },
          { allowFailover: false },
        );
        return respondWithBrokerMutationOutcome(res, body, "metaapi_trade");
      }
      if (conn.broker_type === "oanda") {
        const baseUrl = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
        const updates: any = {};
        if (stopLoss !== undefined) updates.stopLoss = { price: roundOandaPrice(payload.symbol || "", stopLoss), timeInForce: "GTC" };
        if (takeProfit !== undefined) updates.takeProfit = { price: roundOandaPrice(payload.symbol || "", takeProfit) };
        const res = await fetch(`${baseUrl}/v3/accounts/${conn.account_id}/trades/${tradeId}/orders`, {
          method: "PUT", headers: { Authorization: `Bearer ${conn.api_key}`, "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        });
        const body = await res.text();
        const requiredOandaTransactions: OandaDependentOrderTransaction[] = [];
        if (stopLoss !== undefined) {
          requiredOandaTransactions.push("stopLossOrderTransaction");
        }
        if (takeProfit !== undefined) {
          requiredOandaTransactions.push("takeProfitOrderTransaction");
        }
        return respondWithBrokerMutationOutcome(
          res,
          body,
          "oanda_trade_orders",
          requiredOandaTransactions,
        );
      }
    }

    return respond({ error: "Unknown action" });
  } catch (error: any) {
    console.error("broker-execute error:", error?.message || error);
    return new Response(JSON.stringify({ ok: false, state: "unknown", error: error.message, fallback: true }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function respond(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
