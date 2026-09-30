/**
 * Route 2 display helpers for the Zone Setups panel.
 *
 * Labels are NOT defined here. They come from the same file the edge
 * functions use to build Telegram messages and the stored confirmation
 * record, so the dashboard and Telegram cannot describe one confirmation two
 * different ways. This module only READS stored fields and formats them.
 *
 * Every reader returns null when the data is absent. Legacy orders predate
 * most of these fields, and a missing value must render as missing — never as
 * a default that looks measured.
 */
import {
  tierLabel, typeLabel, huntingCaption, HUNT_TIERS_TEXT,
} from "../../supabase/functions/_shared/route2Confirmation.ts";
import { getPipSize, formatPipDisplay } from "@/lib/pipDisplay";

export { tierLabel, typeLabel, huntingCaption, HUNT_TIERS_TEXT };

/** The subset of a pending-order row these helpers read. All optional. */
export interface Route2OrderFields {
  symbol: string;
  direction: "long" | "short";
  status: string;
  entry_price?: number | string | null;
  placed_at?: string | null;
  expires_at?: string | null;
  resolved_at?: string | null;
  filled_at?: string | null;
  cancel_reason?: string | null;
  entry_confirmation?: Record<string, unknown> | null;
  confirmation_type?: string | null;
  confirmation_tier?: number | null;
  confirmation_timeframe?: string | null;
  fill_price?: number | string | null;
  fill_timestamp?: string | null;
  confirmation_accepted_at?: string | null;
  terminal_reason?: string | null;
  reset_reason?: string | null;
  structural_invalidation?: string | null;
  hard_invalidation?: boolean | null;
  would_have_been_route1?: boolean | null;
  strategy_version?: string | null;
}

export interface ConfirmationView {
  tier: number | null;
  type: string | null;
  timeframe: string | null;
  price: number | null;
  /** 0..1 body/range ratio. */
  displacement: number | null;
  significance: string | null;
  closeBased: boolean | null;
  supportingSignals: string[];
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null =>
  v === null || v === undefined || v === "" ? null : String(v);

/**
 * The confirmation that admitted this order, from stored data only.
 *
 * Prefers the canonical `entry_confirmation` record. Falls back to the three
 * scalar columns written at fill time since the forward deploy, which carry
 * tier/type/timeframe but not price or displacement — those stay null rather
 * than being parsed out of free-text `fill_reason`.
 */
export function readConfirmation(o: Route2OrderFields): ConfirmationView | null {
  const r = o.entry_confirmation;
  if (r && typeof r === "object" && (r.type || r.tier)) {
    return {
      tier: num(r.tier),
      type: str(r.type),
      timeframe: str(r.timeframe) ?? str(o.confirmation_timeframe),
      price: num(r.price),
      displacement: num(r.displacement),
      significance: str(r.significance),
      closeBased: typeof r.closeBased === "boolean" ? r.closeBased : null,
      supportingSignals: Array.isArray(r.supportingSignals) ? r.supportingSignals.map(String) : [],
    };
  }
  if (o.confirmation_type || o.confirmation_tier) {
    return {
      tier: num(o.confirmation_tier),
      type: str(o.confirmation_type),
      timeframe: str(o.confirmation_timeframe),
      price: null, displacement: null, significance: null, closeBased: null,
      supportingSignals: [],
    };
  }
  return null;
}

/**
 * Fill price minus pending entry, in the symbol's own display units.
 *
 * Route 2 fills at MARKET on confirmation, not at the limit level, and SL/TP
 * were computed from the limit — so this difference changes the realised R
 * of the trade. `favourable` is from the trade's point of view: a short that
 * fills higher sold better.
 */
export function entryDifference(o: Route2OrderFields): {
  rawPips: number; display: string; favourable: boolean;
} | null {
  const fill = num(o.fill_price), entry = num(o.entry_price);
  if (fill === null || entry === null) return null;
  const rawPips = (fill - entry) / getPipSize(o.symbol);
  return {
    rawPips,
    display: formatPipDisplay(rawPips, o.symbol, { showSign: true }),
    favourable: o.direction === "short" ? rawPips > 0 : rawPips < 0,
  };
}

/** Research cohort. Informational only — it never affects execution. */
export function cohortLabel(wouldHaveBeenRoute1: boolean | null | undefined): string | null {
  if (wouldHaveBeenRoute1 === true) return "Ex-Route-1 / Observational";
  if (wouldHaveBeenRoute1 === false) return "Primary Route 2";
  return null;
}

/** "V2" for the lifecycle-v2 contract; otherwise the raw version, or null. */
export function lifecycleShort(version: string | null | undefined): string | null {
  if (!version) return null;
  if (version.includes("confirmation-lifecycle-v2")) return "V2";
  if (version.includes("impulse-control-v1")) return "V1";
  return version;
}

const REASON_WORDS: Record<string, string> = {
  CANCELLED_SL_INVALIDATION: "SL INVALIDATION",
  CANCELLED_IMPULSE_BROKEN: "IMPULSE BROKEN",
  CANCELLED_ZONE_EXIT: "ZONE EXIT",
  CANCELLED_DIRECTION_FLIP: "DIRECTION FLIP",
  CANCELLED_THESIS_FOTSI: "FOTSI VETO",
  CANCELLED_REFINED_ZONE_FAILURE: "REFINED ZONE FAILURE",
  CANCELLED_POSITION_CAP: "POSITION CAP",
  CANCELLED_SUPERSEDED: "SUPERSEDED",
  EXPIRED_NEVER_TOUCHED: "NEVER TOUCHED",
  EXPIRED_AFTER_TOUCH_NO_CONFIRMATION: "TOUCHED, NO CONFIRMATION",
};

/** TTL actually applied, from the order's own timestamps. */
export function ttlHours(o: Route2OrderFields): number | null {
  if (!o.placed_at || !o.expires_at) return null;
  const ms = Date.parse(o.expires_at) - Date.parse(o.placed_at);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 3_600_000) : null;
}

/**
 * The headline for a resolved order, e.g. "CANCELLED — IMPULSE BROKEN" or
 * "EXPIRED — 8H TTL". Filled orders read "CONFIRMED". A legacy order without
 * a typed terminal reason shows its bare status: the free-text cancel_reason
 * is shown in the expanded view rather than squeezed into a guessed category.
 */
export function outcomeLabel(o: Route2OrderFields): { primary: string; detail: string | null } {
  if (o.status === "filled") return { primary: "CONFIRMED", detail: null };
  const detail = o.terminal_reason ? REASON_WORDS[o.terminal_reason] ?? o.terminal_reason : null;
  if (o.status === "expired") {
    const h = ttlHours(o);
    return { primary: h ? `EXPIRED — ${h}H TTL` : "EXPIRED", detail };
  }
  if (o.status === "cancelled") {
    return { primary: detail ? `CANCELLED — ${detail}` : "CANCELLED", detail: null };
  }
  return { primary: o.status.toUpperCase(), detail };
}
