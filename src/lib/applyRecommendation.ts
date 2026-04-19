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

/** Map an AI-emitted key to a config dot-path. */
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

  // Factor weight keys: "Silver Bullet_weight" → factorWeights["Silver Bullet"]
  const wm = key.match(/^(.+)_weight$/);
  if (wm) return `factorWeights.${wm[1]}`;

  // Bare factor names (not weight) → enable/select map; keep as factorWeights too
  // Conservative: skip unknown keys so we don't corrupt config.
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
    const newVal = coerceValue(rawVal);

    // Read current value at path for audit
    const segs = path.split(".");
    let cur: any = patched;
    let from: any = undefined;
    for (let i = 0; i < segs.length; i++) {
      if (cur == null) { from = undefined; break; }
      if (i === segs.length - 1) from = cur[segs[i]];
      else cur = cur[segs[i]];
    }

    setPath(patched, path, newVal);
    applied.push({ key, path, from, to: newVal });
  }

  return { patched, applied, skipped };
}
