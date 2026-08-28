/**
 * Shared formatting helpers for detailed Telegram notifications.
 *
 * Presentation only — these helpers never mutate state, never fetch, and
 * always degrade to an empty string when the underlying evidence is missing,
 * so older signal_reason payloads keep working unchanged.
 */

export type Json = Record<string, any>;

/** Safely parse a signal_reason column that may be JSON text or an object. */
export function parseSignalReason(raw: unknown): Json {
  if (!raw) return {};
  if (typeof raw === "object") return raw as Json;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed as Json : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** `<b>Label:</b> value\n` — or an empty string when the value is missing. */
export function tgLine(label: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  if (!text || text === "NaN" || text === "null" || text === "undefined") return "";
  return `<b>${label}:</b> ${text}\n`;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
};

/** Human label for the timeframe that produced the impulse/zone. */
export function impulseTimeframeLabel(sr: Json): string | null {
  const iz = sr?.impulseZone;
  const tf = iz?.selectedTF ?? iz?.impulse?.timeframe ?? sr?.unifiedZone?.selectedTF;
  if (!tf) return null;
  const t = String(tf).toUpperCase();
  return t === "1H" ? "1H" : t === "4H" ? "4H" : t === "D" ? "Daily" : t === "1W" ? "Weekly" : t;
}

/**
 * The impulse → zone story: which timeframe found it, what the POI is,
 * where in the retracement it sits and which HTF layers back it.
 */
export function zoneEvidenceLines(sr: Json): string {
  const iz = sr?.impulseZone;
  if (!iz) return "";
  const zone = iz.bestZone;
  let out = "";
  out += tgLine("Impulse TF", impulseTimeframeLabel(sr));
  if (zone) {
    const fib = num(zone.fibLevel);
    const zoneType = zone.type ? String(zone.type).toUpperCase() : null;
    out += tgLine(
      "Zone",
      zoneType ? `${zoneType}${fib !== null ? ` @ fib ${fib.toFixed(3)}` : ""}` : null,
    );
    const layers = Array.isArray(zone.htfLayers) ? zone.htfLayers : [];
    if (layers.length > 0) {
      out += tgLine("HTF Confluence", layers.map((l: any) => String(l).replace(/_/g, " ")).join(", "));
    }
    const zoneScore = num(zone.totalScore);
    if (zoneScore !== null) out += tgLine("Zone evidence (diagnostic)", zoneScore.toFixed(1) + " · does not authorize");
    if (zone.ltfRefined) out += tgLine("LTF Refined", `yes${zone.ltfType ? ` (${zone.ltfType})` : ""}`);
  }
  const impulse = iz.impulse;
  if (impulse?.endDate) {
    out += tgLine(
      "Impulse",
      `${impulse.direction ?? ""} ends ${String(impulse.endDate).slice(0, 16).replace("T", " ")}`.trim()
        + (impulse.spanBars ? ` (${impulse.spanBars} bars)` : ""),
    );
  }
  return out;
}

/** Direction Verdict summary — the execution source of truth. */
export function directionVerdictLines(verdict: any): string {
  if (!verdict) return "";
  const conf = num(verdict.confidence);
  const agreement = num(verdict.agreement);
  const parts: string[] = [String(verdict.verdict ?? "").toUpperCase()];
  if (conf !== null) parts.push(`${conf.toFixed(0)}% conf`);
  if (agreement !== null) parts.push(`${(agreement * 100).toFixed(0)}% agreement`);
  return tgLine("Direction Verdict", parts.filter(Boolean).join(" · "));
}

/** Trading style + the timeframe ladder actually used for this decision. */
export function styleLadderLines(sr: Json, ladder?: { bias?: string; structure?: string; setup?: string } | null): string {
  const style = sr?.frozenStrategyContext?.style ?? sr?.decisionContext?.style ?? sr?.stylePolicy?.style;
  let out = tgLine("Style", style ? String(style) : null);
  const roles = ladder ?? sr?.frozenStrategyContext?.timeframeRoles ?? sr?.decisionContext?.timeframeRoles;
  if (roles?.bias && roles?.structure && roles?.setup) {
    out += tgLine(
      "TF Ladder",
      `${String(roles.bias).toUpperCase()} bias → ${String(roles.structure).toUpperCase()} structure → ${String(roles.setup).toUpperCase()} setup`,
    );
  }
  return out;
}

/** Cross-timeframe authority mode (observe / shadow / enforce). */
export function crossTimeframeAuthorityLine(authority: any): string {
  if (!authority) return "";
  const effective = authority.effectiveMode ?? authority.mode;
  if (!effective) return "";
  const requested = authority.requestedMode;
  const suffix = requested && requested !== effective ? ` (requested ${requested})` : "";
  return tgLine("Cross-TF Authority", `${effective}${suffix}`);
}

/** Watchlist provenance for setups promoted out of staging. */
export function watchlistOriginLines(sr: Json): string {
  const origin = sr?.watchlistOrigin;
  if (!origin) return "";
  const cycles = num(origin.cyclesWatched);
  const initial = num(origin.initialScore);
  const bits: string[] = [];
  if (cycles !== null) bits.push(`${cycles} cycles`);
  if (initial !== null) bits.push(`from ${initial.toFixed(1)}%`);
  return bits.length > 0 ? tgLine("Watchlist", bits.join(" · ")) : "";
}

/** Human-readable entry confirmation method; reversal candles are part of the structure path. */
export function confirmationMethodLabel(method: unknown, indicatorMinimum: unknown = 3): string {
  const minimum = num(indicatorMinimum) ?? 3;
  if (method === "indicators") return "Indicator consensus (" + minimum + "/4)";
  if (method === "choch_and_indicators") return "MSS / CHoCH / reversal candle + indicators (" + minimum + "/4)";
  return "MSS / CHoCH / reversal candle";
}

/** The actual signal that satisfied entry confirmation. */
export function confirmationEvidenceLines(signal: any): string {
  if (!signal) return tgLine("Entry Confirmation", "waiting");
  const supporting = Array.isArray(signal.supportingSignals) ? signal.supportingSignals : [];
  const pattern = supporting.find((item: unknown) => String(item).startsWith("pattern:"));
  const name = pattern ? String(pattern).slice("pattern:".length)
    : signal.type ? String(signal.type).replace(/_/g, " ") : "confirmed";
  const displacement = num(signal.displacement);
  const detail = displacement !== null ? name + " · displacement " + displacement.toFixed(2) : name;
  return tgLine("Entry Confirmation", detail);
}

/** Named execution authorities. Legacy percentages and tiers are intentionally excluded. */
export function tradeAuthorityLines(sr: Json): string {
  const decision = sr?.singleOwnershipDecision;
  const enforcement = sr?.singleOwnershipEnforcement;
  if (!decision) return "";
  const authorities = decision.authorities || {};
  const enforced = enforcement?.affectsAuthorization === true;
  let out = "🛡 <b>Trade Authority</b>\n";
  out += tgLine("Decision", String(decision.decision || "unavailable").toUpperCase() + " · " + (enforced ? "ENFORCED" : "OBSERVE ONLY"));
  const zone = authorities.entryZone || authorities.zoneStory;
  if (zone) out += tgLine("Entry Zone", zone.valid === true ? (zone.entryReady === true ? "valid · entry ready" : "valid · waiting") : zone.valid === false ? "invalid" : "unavailable");
  const location = authorities.canonicalLocation;
  if (location) out += tgLine("Price Location", location.required === false ? "off" : location.allowed === true ? "allowed" : location.allowed === false ? "blocked" : "unavailable");
  const confirmation = authorities.confirmation;
  if (confirmation) out += tgLine("Confirmation", confirmation.required === false ? "not required" : confirmation.passed === true ? "ready" : confirmation.passed === false ? "waiting" : "unavailable");
  const thesis = authorities.thesis;
  if (thesis) out += tgLine("Thesis", thesis.required === false ? "not required" : thesis.valid === true ? "valid" : thesis.valid === false ? "invalid" : "unavailable");
  const safety = authorities.safety;
  if (safety) out += tgLine("Operational Safety", safety.complete && !(safety.checks || []).some((check: any) => !check.passed) ? "passed" : "blocked or incomplete");
  return out;
}

/** Legacy scoring is retained for analysis, never presented as execution authority. */
export function diagnosticScoreLine(score: unknown): string {
  const value = num(score);
  return value === null ? "" : tgLine("Diagnostics only", "legacy score " + value.toFixed(1) + " · does not authorize");
}

/** Realised R multiple for a closed trade. */
export function rMultiple(
  entry: unknown,
  originalSL: unknown,
  exit: unknown,
  direction: string,
): number | null {
  const e = num(entry), s = num(originalSL), x = num(exit);
  if (e === null || s === null || x === null) return null;
  const risk = Math.abs(e - s);
  if (risk <= 0) return null;
  const move = direction === "long" ? x - e : e - x;
  return move / risk;
}

/** "2h 14m" style duration between two timestamps. */
export function durationLabel(from: unknown, to: unknown = new Date().toISOString()): string | null {
  const a = from ? Date.parse(String(from)) : NaN;
  const b = to ? Date.parse(String(to)) : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  const mins = Math.round((b - a) / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
