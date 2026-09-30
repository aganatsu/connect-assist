/**
 * ROUTE 2 CONFIRMATION — the one canonical record, and the one set of labels.
 *
 * WHY THIS EXISTS. The confirmation that admitted a Route 2 trade was
 * described in three places that could disagree: Telegram formatted the raw
 * `confirmationSignal` itself, the pending row kept only type/tier/timeframe,
 * and the position kept a free-form `signal_reason.confirmation` that lacked
 * the timeframe and silently dropped `significance` whenever it was undefined.
 * The dashboard, meanwhile, reduced every fill to the word "confirmed".
 *
 * Everything that STORES or DISPLAYS a confirmation now goes through this
 * file: both pollers build the record here, Telegram labels it here, and the
 * web panel imports this same file for its labels. There is no second
 * interpretation to drift.
 *
 * ZERO IMPORTS, deliberately. It is loaded by Deno edge functions and by the
 * Vite frontend, so it may not depend on either runtime.
 *
 * Observability only. Nothing here participates in a trade decision.
 */

/** What the confirmation engine emits. Mirrors zoneConfirmation.ConfirmationSignal. */
export interface ConfirmationSignalLike {
  type: string;
  tier: number;
  price: number;
  displacement: number;
  significance?: string | null;
  closeBased: boolean;
  supportingSignals?: string[] | null;
}

/** The persisted form. Every field explicit — `null`, never `undefined`. */
export interface ConfirmationRecord {
  contract: "route2-confirmation.v1";
  type: string;
  tier: number;
  timeframe: string | null;
  price: number | null;
  /** Body/range ratio, 0..1. */
  displacement: number | null;
  significance: string | null;
  closeBased: boolean | null;
  supportingSignals: string[];
}

const finite = (n: unknown): number | null =>
  typeof n === "number" && Number.isFinite(n) ? n : null;

/**
 * Build the record the moment a confirmation is accepted.
 *
 * `significance` is written as `null` when absent. JSON.stringify drops
 * `undefined`, which is how it vanished from every stored confirmation before
 * this — a missing key reads as "never computed", a null as "computed, none".
 */
export function buildConfirmationRecord(
  s: ConfirmationSignalLike, timeframe: string | null,
): ConfirmationRecord {
  return {
    contract: "route2-confirmation.v1",
    type: String(s.type),
    tier: Number(s.tier),
    timeframe: timeframe ?? null,
    price: finite(s.price),
    displacement: finite(s.displacement),
    significance: s.significance ?? null,
    closeBased: typeof s.closeBased === "boolean" ? s.closeBased : null,
    supportingSignals: Array.isArray(s.supportingSignals) ? s.supportingSignals.map(String) : [],
  };
}

// ─── labels — the single source both Telegram and the dashboard use ─────────

/**
 * Short tier badge. Tier 2 is a wick-based CHoCH WITH a supporting signal,
 * hence the "+"; tier 3 is a reversal pattern with no CHoCH at all, which is
 * exactly why a panel that says "CHoCH" for every fill was wrong.
 */
export function tierLabel(tier: number | null | undefined): string | null {
  switch (Number(tier)) {
    case 1: return "T1 CHoCH";
    case 2: return "T2 CHoCH+";
    case 3: return "T3 Reversal";
    default: return null;
  }
}

/** Human form of a ConfirmationType. Unknown types are shown verbatim, not guessed. */
export function typeLabel(type: string | null | undefined): string | null {
  if (!type) return null;
  const t = String(type);
  const dir = t.startsWith("bearish") ? "Bearish" : t.startsWith("bullish") ? "Bullish" : null;
  if (!dir) return t;
  if (t.endsWith("_choch_relaxed")) return `${dir} CHoCH (wick)`;
  if (t.endsWith("_choch")) return `${dir} CHoCH`;
  if (t.endsWith("_reversal_pattern")) return `${dir} Reversal Pattern`;
  return t;
}

/** The three tiers production accepts, in the order it checks them. */
export const HUNT_TIERS_TEXT = "T1 CHoCH · T2 CHoCH+ · T3 Reversal";

/** "bearish" for a short, "bullish" for a long. */
export function confirmationDirectionWord(direction: string | null | undefined): string {
  return direction === "short" ? "bearish" : "bullish";
}

/** Active-hunt caption: what the hunt is actually waiting for. */
export function huntingCaption(direction: string | null | undefined, timeframe: string | null | undefined): string {
  return `Waiting for ${confirmationDirectionWord(direction)} ${timeframe || "5m"} confirmation`;
}

/** One line for notifications, built only from the stored record. */
export function confirmationSummaryLine(r: ConfirmationRecord): string {
  const parts = [tierLabel(r.tier) ?? `T${r.tier}`, typeLabel(r.type) ?? r.type];
  if (r.timeframe) parts.push(r.timeframe);
  if (r.displacement !== null) parts.push(`disp ${(r.displacement * 100).toFixed(0)}%`);
  return parts.join(" · ");
}

// ─── provenance ─────────────────────────────────────────────────────────────

/** The fields of a pending order that identify WHICH lifecycle produced a fill. */
export interface Route2Provenance {
  contract: "route2-provenance.v1";
  pendingOrderId: string | null;
  pendingRowId: string | null;
  strategyVersion: string | null;
  configHash: string | null;
  lifecycleVersion: string | null;
  wouldHaveBeenRoute1: boolean | null;
  zoneId: string | null;
  pendingCreatedAt: string | null;
  pendingEntryPrice: number | null;
  pendingDistanceAtr: number | null;
  zoneTouchTime: string | null;
  confirmationArmCount: number | null;
  /** Checks that did NOT pass before the accepting one. */
  confirmationChecksCount: number | null;
}

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Copy provenance off a pending-order row. Reads only; invents nothing.
 *
 * A legacy row without these columns yields nulls — never a V2 label it did
 * not earn.
 */
export function buildRoute2Provenance(p: Record<string, unknown>): Route2Provenance {
  const s = (k: string) => (p[k] === null || p[k] === undefined ? null : String(p[k]));
  const wr1 = p.would_have_been_route1;
  const version = s("strategy_version");
  return {
    contract: "route2-provenance.v1",
    pendingOrderId: s("order_id"),
    pendingRowId: s("id"),
    strategyVersion: version,
    configHash: s("config_hash"),
    // Only a V2 order has a lifecycle version; V1 rows stay null.
    lifecycleVersion: version && version.includes("lifecycle") ? version : null,
    wouldHaveBeenRoute1: typeof wr1 === "boolean" ? wr1 : null,
    zoneId: s("zone_id"),
    pendingCreatedAt: s("placed_at"),
    pendingEntryPrice: numOrNull(p.entry_price),
    pendingDistanceAtr: numOrNull(p.pending_distance_atr),
    zoneTouchTime: s("zone_touch_time") ?? s("last_touch_detection_time"),
    confirmationArmCount: numOrNull(p.confirmation_arm_count),
    confirmationChecksCount: numOrNull(p.confirmation_checks_count),
  };
}
