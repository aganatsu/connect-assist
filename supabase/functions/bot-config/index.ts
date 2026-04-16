import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) throw new Error("Unauthorized");

    const { action, ...payload } = await req.json();

    if (action === "get") {
      const { data, error } = await supabase.from("bot_configs").select("config_json").eq("user_id", user.id).maybeSingle();
      if (error) throw error;
      return new Response(JSON.stringify(data?.config_json || getDefaultConfig()), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "update") {
      const { data: existing } = await supabase.from("bot_configs").select("id").eq("user_id", user.id).maybeSingle();
      if (existing) {
        const { error } = await supabase.from("bot_configs").update({ config_json: payload.config }).eq("user_id", user.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("bot_configs").insert({ user_id: user.id, config_json: payload.config });
        if (error) throw error;
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "reset") {
      const defaultConfig = getDefaultConfig();
      const { data: existing } = await supabase.from("bot_configs").select("id").eq("user_id", user.id).maybeSingle();
      if (existing) {
        await supabase.from("bot_configs").update({ config_json: defaultConfig }).eq("user_id", user.id);
      } else {
        await supabase.from("bot_configs").insert({ user_id: user.id, config_json: defaultConfig });
      }
      return new Response(JSON.stringify(defaultConfig), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function getDefaultConfig() {
  return {
    strategy: {
      enableBOS: true, enableCHoCH: true, enableOB: true, enableFVG: true, enableLiquiditySweep: true,
      minConfluenceScore: 6, htfBiasRequired: true, obLookbackCandles: 20, obMinBodyWickRatio: 0.5,
      obMustBeAtSwing: true, obInvalidationClose: true, obMitigationType: "touch",
      fvgMinSizePips: 5, fvgPremiumDiscountOnly: false, fvgFillPercentInvalidate: 75, fvgOnlyUnfilled: true,
      structureBreakConfirmation: "close", chochAsReversal: true, structureLookback: 50,
      liquiditySweepRequired: false, equalHighsLowsSensitivity: 3, liquidityPoolMinTouches: 2,
      premiumDiscountEnabled: true, onlyBuyInDiscount: true, onlySellInPremium: true, zoneMethod: "fibonacci",
      htfBiasTimeframe: "1D", entryTimeframe: "15m", requireAllTFAligned: false, minTFsAligned: 2,
    },
    risk: {
      riskPerTrade: 1, maxDailyLoss: 5, maxDrawdown: 15, positionSizingMethod: "percent_risk",
      fixedLotSize: 0.1, maxOpenPositions: 5, maxPositionsPerSymbol: 2, maxPortfolioHeat: 10, minRiskReward: 1.5,
    },
    entry: {
      defaultOrderType: "market", entryRefinement: false, refinementTimeframe: "5m",
      trailingEntry: false, trailingEntryPips: 5, maxSlippagePips: 2,
      pyramidingEnabled: false, maxPyramidAdds: 1, closeOnReverse: true, cooldownMinutes: 15,
    },
    exit: {
      takeProfitMethod: "rr_ratio", fixedTPPips: 50, tpRRRatio: 2.0, tpATRMultiple: 2.0,
      stopLossMethod: "structure", fixedSLPips: 25, slATRMultiple: 1.5, slATRPeriod: 14,
      trailingStopEnabled: false, trailingStopPips: 15, trailingStopActivation: "after_1r",
      partialTPEnabled: false, partialTPPercent: 50, partialTPLevel: 1.0,
      breakEvenEnabled: true, breakEvenTriggerPips: 20,
      timeBasedExitEnabled: false, maxHoldHours: 24, endOfSessionClose: false,
    },
    instruments: {
      allowedInstruments: {
        "EUR/USD": true, "GBP/USD": true, "USD/JPY": true, "GBP/JPY": true,
        "AUD/USD": true, "USD/CAD": true, "EUR/GBP": false, "NZD/USD": false,
        "XAU/USD": true, "XAG/USD": false, "BTC/USD": false, "ETH/USD": false,
      },
      spreadFilterEnabled: true, maxSpreadPips: 3, volatilityFilterEnabled: false,
      minATR: 0, maxATR: 999, correlationFilterEnabled: false, maxCorrelation: 0.8,
    },
    sessions: {
      londonEnabled: true, londonStart: "08:00", londonEnd: "16:00",
      newYorkEnabled: true, newYorkStart: "13:00", newYorkEnd: "21:00",
      asianEnabled: false, asianStart: "00:00", asianEnd: "08:00",
      sydneyEnabled: false, sydneyStart: "22:00", sydneyEnd: "06:00",
      activeDays: { mon: true, tue: true, wed: true, thu: true, fri: true },
      newsFilterEnabled: true, newsFilterPauseMinutes: 30,
    },
    notifications: {
      notifyOnTrade: true, notifyOnSignal: true, notifyOnError: true,
      notifyDailySummary: true, notifyChannel: "in_app",
    },
    protection: {
      dailyProfitTarget: 0, dailyLossLimit: 0, cumulativeProfitTarget: 0,
      cumulativeLossLimit: 0, haltOnDailyTarget: false, haltOnDailyLoss: true,
    },
    account: { startingBalance: 10000, leverage: 100, mode: "paper" },
    openingRange: {
      enabled: false,
      candleCount: 24,
      useBias: true,
      useJudasSwing: true,
      useKeyLevels: true,
      usePremiumDiscount: false,
      waitForCompletion: true,
    },
    tradingStyle: {
      mode: "day_trader",
      autoDetectEnabled: false,
    },
  };
}
