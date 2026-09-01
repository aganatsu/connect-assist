/**
 * prop-firm — CRUD + Status API for Prop Firm Risk Management
 * ──────────────────────────────────────────────────────────────────────────
 * Actions:
 *   status       → current config + daily state + recent events
 *   config.get   → get active config
 *   config.save  → create or update config
 *   config.delete → deactivate config
 *   events       → paginated event log
 *   daily_history → past N days of daily state
 */

import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  FTMO_2STEP_DEFAULTS,
  FTMO_1STEP_DEFAULTS,
  calculateDailyLossLimit,
  calculateDrawdownFloor,
  calculateProfitTarget,
  getResetHourUTC,
  getCESTTradingDay,
  type PropFirmConfig,
} from "../_shared/propFirmRisk.ts";

// ─── MetaAPI Region-Aware Fetch ─────────────────────────────────────────────
// Mirrors the pattern in bot-scanner and paper-trading for reliable connectivity.
const META_REGIONS = ["london", "new-york", "singapore"];
const regionCache = new Map<string, string>();

function metaBaseUrl(region: string, accountId: string) {
  return `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}`;
}

async function fetchBrokerEquity(
  accountId: string,
  authToken: string,
): Promise<number | undefined> {
  const cached = regionCache.get(accountId);
  const order = cached ? [cached, ...META_REGIONS.filter(r => r !== cached)] : META_REGIONS;
  for (const region of order) {
    try {
      const url = `${metaBaseUrl(region, accountId)}/account-information`;
      const res = await fetch(url, { headers: { "auth-token": authToken } });
      const body = await res.text();
      if (res.ok) {
        const data = JSON.parse(body);
        const equity = parseFloat(data.equity ?? data.balance ?? "0");
        if (Number.isFinite(equity) && equity > 0) {
          regionCache.set(accountId, region);
          console.log(`[prop-firm-status] Broker equity fetched from ${region}: $${equity.toFixed(2)}`);
          return equity;
        }
        // res.ok but equity invalid — likely data issue, not region mismatch
        console.warn(`[prop-firm-status] MetaAPI ${region} returned ok but equity invalid: ${body.slice(0, 200)}`);
        break;
      }
      // Non-ok: check if it's a region mismatch (retry next region) or a real error (stop)
      if (!/region|not connected to broker/i.test(body)) break;
      console.warn(`[prop-firm-status] MetaAPI ${region} returned ${res.status}, trying next...`);
    } catch (e: any) {
      console.warn(`[prop-firm-status] MetaAPI ${region} fetch error: ${e?.message}`);
    }
  }
  return undefined;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Auth
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Missing auth" }), { status: 401, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
  }

  const userId = user.id;
  const body = await req.json().catch(() => ({}));
  const action = body.action || "status";
  const botId = body.botId || "smc";

  try {
    switch (action) {
      case "status": {
        // Get config
        const { data: config } = await supabase
          .from("prop_firm_config")
          .select("*")
          .eq("user_id", userId)
          .eq("bot_id", botId)
          .eq("is_active", true)
          .maybeSingle();

        if (!config) {
          return json({ active: false, config: null, dailyState: null, events: [] });
        }

        // Get today's state
        const now = new Date();
        const resetHour = getResetHourUTC(now);
        const tradingDay = getCESTTradingDay(now, resetHour);

        const { data: dailyState } = await supabase
          .from("prop_firm_daily_state")
          .select("*")
          .eq("config_id", config.id)
          .eq("trading_day", tradingDay)
          .maybeSingle();

        // Get recent events (last 20)
        const { data: events } = await supabase
          .from("prop_firm_events")
          .select("*")
          .eq("config_id", config.id)
          .order("created_at", { ascending: false })
          .limit(20);

        // Get account balance (paper — used as fallback)
        const { data: acct } = await supabase
          .from("paper_accounts")
          .select("balance")
          .eq("user_id", userId)
          .eq("bot_id", botId)
          .maybeSingle();

        // ── Fetch real broker equity from MetaAPI (if connected) ──
        // This ensures the prop firm compliance page shows the real MT5 account
        // equity, not the (potentially corrupted) paper_accounts balance.
        let brokerEquity: number | undefined;
        let equitySource: "metaapi" | "paper" = "paper";
        const { data: brokerConn } = await supabase
          .from("broker_connections")
          .select("account_id, api_key")
          .eq("user_id", userId)
          .eq("broker_type", "metaapi")
          .eq("is_active", true)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (brokerConn?.account_id && brokerConn?.api_key) {
          try {
            brokerEquity = await fetchBrokerEquity(brokerConn.account_id, brokerConn.api_key);
            if (brokerEquity !== undefined) {
              equitySource = "metaapi";
            }
          } catch (e: any) {
            console.warn(`[prop-firm-status] Broker equity fetch failed, falling back to paper: ${e?.message}`);
          }
        }

        // Priority: broker equity (MetaAPI) > paper balance > initial balance
        const paperBalance = acct ? parseFloat(acct.balance) : config.initial_balance;
        const currentBalance = brokerEquity ?? paperBalance;
        const dailyLossLimit = calculateDailyLossLimit(config);
        const drawdownFloor = calculateDrawdownFloor(config, dailyState?.highest_eod_balance_ever ?? config.initial_balance);
        const profitTarget = calculateProfitTarget(config);

        return json({
          active: true,
          config,
          dailyState,
          events: events || [],
          derived: {
            currentBalance,
            dailyLossLimit,
            drawdownFloor,
            profitTarget,
            tradingDay,
            resetHour,
            equitySource,
          },
        });
      }

      case "config.get": {
        const { data: config } = await supabase
          .from("prop_firm_config")
          .select("*")
          .eq("user_id", userId)
          .eq("bot_id", botId)
          .maybeSingle();

        return json({ config, defaults: { ftmo_2step: FTMO_2STEP_DEFAULTS, ftmo_1step: FTMO_1STEP_DEFAULTS } });
      }

      case "config.save": {
        const configData = body.config;
        if (!configData) {
          return json({ error: "Missing config data" }, 400);
        }

        // Check if config already exists
        const { data: existing } = await supabase
          .from("prop_firm_config")
          .select("id")
          .eq("user_id", userId)
          .eq("bot_id", botId)
          .maybeSingle();

        if (existing) {
          // Update
          const { data, error } = await supabase
            .from("prop_firm_config")
            .update({
              ...configData,
              user_id: userId,
              bot_id: botId,
            })
            .eq("id", existing.id)
            .select()
            .single();

          if (error) return json({ error: error.message }, 500);
          return json({ config: data, updated: true });
        } else {
          // Insert
          const { data, error } = await supabase
            .from("prop_firm_config")
            .insert({
              ...configData,
              user_id: userId,
              bot_id: botId,
            })
            .select()
            .single();

          if (error) return json({ error: error.message }, 500);
          return json({ config: data, created: true });
        }
      }

      case "config.delete": {
        await supabase
          .from("prop_firm_config")
          .update({ is_active: false })
          .eq("user_id", userId)
          .eq("bot_id", botId);

        return json({ success: true });
      }

      case "events": {
        const limit = body.limit || 50;
        const offset = body.offset || 0;

        const { data: config } = await supabase
          .from("prop_firm_config")
          .select("id")
          .eq("user_id", userId)
          .eq("bot_id", botId)
          .maybeSingle();

        if (!config) return json({ events: [], total: 0 });

        const { data: events, count } = await supabase
          .from("prop_firm_events")
          .select("*", { count: "exact" })
          .eq("config_id", config.id)
          .order("created_at", { ascending: false })
          .range(offset, offset + limit - 1);

        return json({ events: events || [], total: count || 0 });
      }

      case "daily_history": {
        const days = body.days || 30;

        const { data: config } = await supabase
          .from("prop_firm_config")
          .select("id")
          .eq("user_id", userId)
          .eq("bot_id", botId)
          .maybeSingle();

        if (!config) return json({ history: [] });

        const { data: history } = await supabase
          .from("prop_firm_daily_state")
          .select("*")
          .eq("config_id", config.id)
          .order("trading_day", { ascending: false })
          .limit(days);

        return json({ history: history || [] });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e: any) {
    console.error(`[prop-firm] Error: ${e?.message}`);
    return json({ error: e?.message }, 500);
  }
});

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
