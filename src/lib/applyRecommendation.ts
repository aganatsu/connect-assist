// Applies an AI recommendation's `suggested_value` patch onto a bot config_json.
// AI keys are human-readable (e.g. "Risk/Trade", "SL", "Silver Bullet_weight");
// we map them to the actual nested config paths used by the bot.

type Json = Record<string, any>;

/** Parse "0.5%", "1%", "25 pips", numeric strings, booleans, plain numbers. */
function coerceValue(raw: unknown): any {
  if (raw === null || raw === undefined) return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return raw;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return raw;

  const s = raw.trim();
  if (s === "") return s;
  if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);

  // "0.5%" → 0.5  (percentage as plain number)
  const pct = s.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
  if (pct) return parseFloat(pct[1]);

  // "25 pips" / "25pips" → 25
  const pips = s.match(/^(-?\d+(?:\.\d+)?)\s*pips?$/i);
  if (pips) return parseFloat(pips[1]);

  // Plain number
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return parseFloat(s);

  return s;
}

/** Set a deep path "a.b.c" on an object (mutates and returns root). */
function setPath(root: Json, path: string, value: any): Json {
  const keys = path.split(".");
  let cur: Json = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return root;
}

/** Factor display name → strategy.use<Name> toggle key. */
const FACTOR_TOGGLE_MAP: Record<string, string> = {
  "Breaker Block": "useBreakerBlocks",
  "Unicorn Model": "useUnicornModel",
  "Silver Bullet": "useSilverBullet",
  "Session/Kill Zone": "useKillZones",
  "Judas Swing": "useJudasSwing",
  "AMD Phase": "useAMDPhase",
  "Reversal Candle": "useReversalCandle",
  "Premium/Discount": "strategy.premiumDiscountEnabled",
  "Displacement": "useDisplacement",
  "Liquidity Sweep": "enableLiquiditySweep",
  "Order Block": "enableOB",
  "Fair Value Gap": "enableFVG",
};

/** Map an AI-emitted key to a config dot-path. Returns null to skip safely. */
function resolveConfigPath(key: string): string | null {
  const direct: Record<string, string> = {
    "Risk/Trade": "risk.riskPerTrade",
    "SL": "exit.fixedSLPips",
    "TP": "exit.fixedTPPips",
    "instrument_filter": "instruments",
    "excluded_instruments": "excludedInstruments",
    "newYorkEnd": "sessions.newYorkEnd",
  };
  if (direct[key]) return direct[key];

  // Bare factor name → strategy toggle. If map already includes "strategy.", use as-is.
  const toggle = FACTOR_TOGGLE_MAP[key];
  if (toggle) return toggle.includes(".") ? toggle : `strategy.${toggle}`;

  // Display-name → camelCase config key map for factor weights
  const WEIGHT_KEY_MAP: Record<string, string> = {
    "Market Structure": "marketStructure", "Order Block": "orderBlock",
    "Fair Value Gap": "fairValueGap", "Premium/Discount & Fib": "premiumDiscountFib",
    "Premium/Discount": "premiumDiscountFib", "Session/Kill Zone": "sessionKillZone",
    "Judas Swing": "judasSwing", "PD/PW Levels": "pdPwLevels",
    "Reversal Candle": "reversalCandle", "Liquidity Sweep": "liquiditySweep",
    "Displacement": "displacement", "Breaker Block": "breakerBlock",
    "Unicorn Model": "unicornModel", "Silver Bullet": "silverBullet",
    "Macro Window": "macroWindow", "SMT Divergence": "smtDivergence",
    "Volume Profile": "volumeProfile", "AMD Phase": "amdPhase",
    "Currency Strength": "currencyStrength", "Trend Direction": "trendDirection",
    "Daily Bias": "dailyBias",
  };
  // Set of valid camelCase factor keys (the values of WEIGHT_KEY_MAP)
  const KNOWN_FACTOR_KEYS = new Set(Object.values(WEIGHT_KEY_MAP));

  // "<Factor>_weight" — display-name or camelCase with explicit suffix
  if (/_weight$/.test(key)) {
    const factorName = key.replace(/_weight$/, "");
    const configKey = WEIGHT_KEY_MAP[factorName] || factorName;
    return `factorWeights.${configKey}`;
  }

  // Bare camelCase factor key (e.g. "breakerBlock") → factorWeights.<key>
  if (KNOWN_FACTOR_KEYS.has(key)) {
    return `factorWeights.${key}`;
  }

  return null;
}

export interface ApplyResult {
  patched: Json;
  applied: Array<{ key: string; path: string; from: any; to: any }>;
  skipped: Array<{ key: string; reason: string }>;
}

/** Build a new config by applying the recommendation's suggested_value. */
export function applyRecommendationToConfig(
  currentConfig: Json,
  suggestedValue: Record<string, unknown> | null | undefined
): ApplyResult {
  const patched: Json = JSON.parse(JSON.stringify(currentConfig || {}));
  const applied: ApplyResult["applied"] = [];
  const skipped: ApplyResult["skipped"] = [];

  if (!suggestedValue || typeof suggestedValue !== "object") {
    return { patched, applied, skipped };
  }

  for (const [key, rawVal] of Object.entries(suggestedValue)) {
    const path = resolveConfigPath(key);
    if (!path) {
      skipped.push({ key, reason: "unknown config key" });
      continue;
    }
    let newVal = coerceValue(rawVal);

    // Read current value at path for audit + type validation
    const segs = path.split(".");
    let cur: any = patched;
    let from: any = undefined;
    for (let i = 0; i < segs.length; i++) {
      if (cur == null) { from = undefined; break; }
      if (i === segs.length - 1) from = cur[segs[i]];
      else cur = cur[segs[i]];
    }

    // Toggle paths must be booleans
    const isToggle =
      /\.(use[A-Z]|enable[A-Z])/.test(path) || /\.premiumDiscountEnabled$/.test(path);
    if (isToggle) newVal = !!newVal && newVal !== 0;

    // Type-safety guard: never overwrite a string config (e.g. time "21:00") with
    // a boolean/number, and never overwrite a number with a non-numeric string.
    // Exception: factorWeights paths allow "default" (string sentinel) → number replacement.
    if (from !== undefined && from !== null) {
      const fromType = typeof from;
      const newType = typeof newVal;
      const isFactorWeightPath = path.startsWith("factorWeights.");
      const isSentinelReplacement = isFactorWeightPath && from === "default" && newType === "number";
      if (fromType !== newType && !isSentinelReplacement) {
        skipped.push({
          key,
          reason: `type mismatch: existing ${fromType} (${JSON.stringify(from)}), suggested ${newType} (${JSON.stringify(newVal)})`,
        });
        continue;
      }
    }

    setPath(patched, path, newVal);
    applied.push({ key, path, from, to: newVal });
  }

  return { patched, applied, skipped };
}
