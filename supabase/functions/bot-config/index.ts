import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized", code: "invalid_jwt" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: authError } = await supabase.auth.getClaims(token);
    if (authError || !claimsData?.claims?.sub) {
      return new Response(JSON.stringify({ error: "Unauthorized", code: "invalid_jwt" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const authedUser = { id: claimsData.claims.sub as string };
    const user = authedUser;

    const { action, ...payload } = await req.json();
    const connectionId = payload.connectionId || null;

    // Helper to build the query filter for connection-specific or global config
    function configQuery(q: any) {
      q = q.eq("user_id", authedUser.id);
      if (connectionId) {
        q = q.eq("connection_id", connectionId);
      } else {
        q = q.is("connection_id", null);
      }
      return q;
    }

    // ─── Config CRUD (existing) ───────────────────────────────────────

    if (action === "get") {
      let { data, error } = await configQuery(supabase.from("bot_configs").select("config_json")).maybeSingle();
      if (error) throw error;
      // If no connection-specific config, fall back to global
      if (!data && connectionId) {
        const { data: globalData } = await supabase.from("bot_configs").select("config_json").eq("user_id", user.id).is("connection_id", null).maybeSingle();
        return new Response(JSON.stringify(globalData?.config_json || getDefaultConfig()), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data?.config_json || getDefaultConfig()), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "update") {
      // Guard: payload.config must be present
      if (!payload.config || typeof payload.config !== "object") {
        return new Response(JSON.stringify({ error: "Missing 'config' in request body" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // H12: Validate config before saving
      const validationErrors = validateConfig(payload.config);
      if (validationErrors.length > 0) {
        return new Response(JSON.stringify({ error: "Config validation failed", details: validationErrors }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: existing } = await configQuery(supabase.from("bot_configs").select("id")).maybeSingle();
      if (existing) {
        const { error } = await supabase.from("bot_configs").update({ config_json: payload.config }).eq("id", existing.id);
        if (error) throw error;
      } else {
        const insertData: any = { user_id: user.id, config_json: payload.config };
        if (connectionId) insertData.connection_id = connectionId;
        const { error } = await supabase.from("bot_configs").insert(insertData);
        if (error) throw error;
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "reset") {
      const defaultConfig = getDefaultConfig();
      const { data: existing } = await configQuery(supabase.from("bot_configs").select("id")).maybeSingle();
      if (existing) {
        await supabase.from("bot_configs").update({ config_json: defaultConfig }).eq("id", existing.id);
      } else {
        const insertData: any = { user_id: user.id, config_json: defaultConfig };
        if (connectionId) insertData.connection_id = connectionId;
        await supabase.from("bot_configs").insert(insertData);
      }
      return new Response(JSON.stringify(defaultConfig), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Defaults (C4: canonical defaults endpoint for backtest page) ─────
    if (action === "defaults") {
      return new Response(JSON.stringify(getDefaultConfig()), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Preset CRUD ──────────────────────────────────────────────────

    if (action === "presets.list") {
      const { data, error } = await supabase
        .from("config_presets")
        .select("id, name, description, config_json, created_at, updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return new Response(JSON.stringify(data || []), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "presets.save") {
      const { name, description, config } = payload;
      if (!name || typeof name !== "string" || name.trim().length === 0) {
        return new Response(JSON.stringify({ error: "Preset name is required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!config || typeof config !== "object") {
        return new Response(JSON.stringify({ error: "Config object is required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // H12: Validate preset config before saving
      const presetValidation = validateConfig(config);
      if (presetValidation.length > 0) {
        return new Response(JSON.stringify({ error: "Preset config validation failed", details: presetValidation }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const trimmedName = name.trim();
      const trimmedDesc = (description || "").trim();

      // Upsert: if preset with same name exists, update it
      const { data: existing } = await supabase
        .from("config_presets")
        .select("id")
        .eq("user_id", user.id)
        .eq("name", trimmedName)
        .maybeSingle();

      if (existing) {
        const { error } = await supabase
          .from("config_presets")
          .update({ config_json: config, description: trimmedDesc })
          .eq("id", existing.id);
        if (error) throw error;
        return new Response(JSON.stringify({ success: true, id: existing.id, updated: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } else {
        // M16: Enforce max 20 presets per user
        const { count, error: countErr } = await supabase
          .from("config_presets")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id);
        if (countErr) throw countErr;
        if (typeof count === "number" && count >= 20) {
          return new Response(JSON.stringify({ error: "Maximum 20 presets allowed. Delete an existing preset first." }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const { data: inserted, error } = await supabase
          .from("config_presets")
          .insert({ user_id: user.id, name: trimmedName, description: trimmedDesc, config_json: config })
          .select("id")
          .single();
        if (error) throw error;
        return new Response(JSON.stringify({ success: true, id: inserted.id, updated: false }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    if (action === "presets.delete") {
      const { presetId } = payload;
      if (!presetId) {
        return new Response(JSON.stringify({ error: "presetId is required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { error } = await supabase
        .from("config_presets")
        .delete()
        .eq("id", presetId)
        .eq("user_id", user.id);
      if (error) throw error;
      return new Response(JSON.stringify({ success: true }), {
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

// H12: Config schema validation
function validateConfig(config: any): string[] {
  const errors: string[] = [];
  if (!config || typeof config !== "object") {
    errors.push("Config must be a non-null object");
    return errors;
  }

  // Required top-level sections
  const requiredSections = ["strategy", "risk", "entry", "instruments", "sessions"];
  for (const section of requiredSections) {
    if (!config[section] || typeof config[section] !== "object") {
      errors.push(`Missing or invalid section: ${section}`);
    }
  }
  if (errors.length > 0) return errors; // Can't validate fields if sections are missing

  // Strategy validations
  const s = config.strategy;
  if (s) {
    if (typeof s.confluenceThreshold === "number" && (s.confluenceThreshold < 0 || s.confluenceThreshold > 100)) {
      errors.push("strategy.confluenceThreshold must be between 0 and 100");
    }
    // Legacy validation (backward compat)
    if (typeof s.minConfluenceScore === "number" && (s.minConfluenceScore < 0 || s.minConfluenceScore > 100)) {
      errors.push("strategy.minConfluenceScore must be between 0 and 100");
    }
    if (typeof s.structureLookback === "number" && (s.structureLookback < 5 || s.structureLookback > 200)) {
      errors.push("strategy.structureLookback must be between 5 and 200");
    }
    if (typeof s.obLookbackCandles === "number" && (s.obLookbackCandles < 5 || s.obLookbackCandles > 200)) {
      errors.push("strategy.obLookbackCandles must be between 5 and 200");
    }
    if (typeof s.fvgMinSizePips === "number" && (s.fvgMinSizePips < 0 || s.fvgMinSizePips > 100)) {
      errors.push("strategy.fvgMinSizePips must be between 0 and 100");
    }
    if (typeof s.fvgFillPercentInvalidate === "number" && (s.fvgFillPercentInvalidate < 0 || s.fvgFillPercentInvalidate > 100)) {
      errors.push("strategy.fvgFillPercentInvalidate must be between 0 and 100");
    }
  }

  // Risk validations
  const r = config.risk;
  if (r) {
    if (typeof r.riskPerTrade === "number" && (r.riskPerTrade < 0.01 || r.riskPerTrade > 10)) {
      errors.push("risk.riskPerTrade must be between 0.01 and 10");
    }
    if (typeof r.maxDailyLoss === "number" && (r.maxDailyLoss < 0 || r.maxDailyLoss > 100)) {
      errors.push("risk.maxDailyLoss must be between 0 and 100");
    }
    if (typeof r.maxDrawdown === "number" && (r.maxDrawdown < 0 || r.maxDrawdown > 100)) {
      errors.push("risk.maxDrawdown must be between 0 and 100");
    }
    if (typeof r.maxOpenPositions === "number" && (r.maxOpenPositions < 1 || r.maxOpenPositions > 50)) {
      errors.push("risk.maxOpenPositions must be between 1 and 50");
    }
    if (typeof r.minRiskReward === "number" && (r.minRiskReward < 0.1 || r.minRiskReward > 20)) {
      errors.push("risk.minRiskReward must be between 0.1 and 20");
    }
  }

  // Instruments validations
  const i = config.instruments;
  if (i) {
    if (i.allowedInstruments && typeof i.allowedInstruments !== "object") {
      errors.push("instruments.allowedInstruments must be an object");
    }
    if (typeof i.maxSpreadPips === "number" && (i.maxSpreadPips < 0 || i.maxSpreadPips > 100)) {
      errors.push("instruments.maxSpreadPips must be between 0 and 100");
    }
  }

  // Sessions validations
  const sess = config.sessions;
  if (sess) {
    if (sess.activeDays && typeof sess.activeDays !== "object") {
      errors.push("sessions.activeDays must be an object");
    }
    if (typeof sess.newsFilterPauseMinutes === "number" && (sess.newsFilterPauseMinutes < 0 || sess.newsFilterPauseMinutes > 240)) {
      errors.push("sessions.newsFilterPauseMinutes must be between 0 and 240");
    }
    // Validate sessions.filter array — only canonical keys allowed
    if (Array.isArray(sess.filter)) {
      const VALID_SESSION_KEYS = ["asian", "london", "newyork", "offhours"];
      // Auto-migrate known legacy values before validation
      const migrationMap: Record<string, string> = {
        "sydney": "offhours",
        "off-hours": "offhours",
        "off_hours": "offhours",
        "new_york": "newyork",
        "new york": "newyork",
      };
      const migrated: string[] = [];
      for (const item of sess.filter) {
        if (typeof item !== "string") {
          errors.push(`sessions.filter contains non-string value: ${JSON.stringify(item)}`);
          continue;
        }
        const normalized = item.toLowerCase().trim().replace(/\s+/g, "");
        const mapped = migrationMap[normalized] ?? normalized;
        if (!VALID_SESSION_KEYS.includes(mapped)) {
          errors.push(`sessions.filter contains unknown session key: "${item}". Valid keys: ${VALID_SESSION_KEYS.join(", ")}`);
        } else {
          migrated.push(mapped);
        }
      }
      // Auto-fix: deduplicate and replace with migrated values
      if (errors.length === 0) {
        sess.filter = [...new Set(migrated)];
      }
    }
  }

  return errors;
}

function getDefaultConfig() {
  return {
    strategy: {
      // Confluence threshold is percentage-based (0-100%). 55% = balanced, 65% = conservative.
      enableBOS: true, enableCHoCH: true, enableOB: true, enableFVG: true, enableLiquiditySweep: true,
      confluenceThreshold: 55, htfBiasRequired: true, obLookbackCandles: 20, obMinBodyWickRatio: 0.5,
      obMustBeAtSwing: true, obInvalidationClose: true, obMitigationType: "touch",
      fvgMinSizePips: 5, fvgPremiumDiscountOnly: false, fvgFillPercentInvalidate: 75, fvgOnlyUnfilled: true,
      structureBreakConfirmation: "close", chochAsReversal: true, structureLookback: 50,
      liquiditySweepRequired: false, equalHighsLowsSensitivity: 3, liquidityPoolMinTouches: 2,
      premiumDiscountEnabled: true, onlyBuyInDiscount: true, onlySellInPremium: true, zoneMethod: "fibonacci",
      htfBiasTimeframe: "1D", entryTimeframe: "15m", requireAllTFAligned: false, minTFsAligned: 2,
      regimeScoringEnabled: true, regimeScoringStrength: 1.0,
      // Normalized scoring: percentage-based (auto-adjusts when factors are toggled)
      normalizedScoring: true,
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
      stopLossMethod: "structure", fixedSLPips: 25, slATRMultiple: 1.5, slATRPeriod: 14,
      takeProfitMethod: "rr_ratio", fixedTPPips: 50, tpRRRatio: 2.0, tpATRMultiple: 2.0,
      trailingStopEnabled: false, trailingStopPips: 15, trailingStopActivation: "after_1r",
      partialTPEnabled: false, partialTPPercent: 50, partialTPLevel: 1.0,
      breakEvenEnabled: true, breakEvenTriggerPips: 20,
      timeBasedExitEnabled: false, maxHoldEnabled: false, maxHoldHours: 24, endOfSessionClose: false,
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
      filter: ["london", "newyork"],
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
    },
    // Factor Weights — config-driven, AI-tunable.
    // Empty object = use hardcoded defaults. Override individual keys to tune.
    // Keys: marketStructure, orderBlock, fairValueGap, premiumDiscountFib,
    //       sessionKillZone, judasSwing, pdPwLevels, reversalCandle,
    //       liquiditySweep, displacement, breakerBlock, unicornModel,
    //       silverBullet, macroWindow, smtDivergence, volumeProfile,
    //       amdPhase, currencyStrength, trendDirection, dailyBias
    factorWeights: {},
  };
}
