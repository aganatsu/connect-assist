/**
 * route2Display — the pure readers behind the Zone Setups panel.
 */
import { describe, it, expect } from "vitest";
import {
  readConfirmation, entryDifference, cohortLabel, lifecycleShort, outcomeLabel, ttlHours,
  tierLabel, typeLabel, HUNT_TIERS_TEXT, huntingCaption,
} from "../route2Display";
import * as canonical from "../../../supabase/functions/_shared/route2Confirmation.ts";

describe("labels come from the canonical module, not a local copy", () => {
  it("re-exports the exact functions Telegram uses", () => {
    // Identity, not equality: a copied implementation would pass an equality
    // test today and drift tomorrow.
    expect(tierLabel).toBe(canonical.tierLabel);
    expect(typeLabel).toBe(canonical.typeLabel);
    expect(HUNT_TIERS_TEXT).toBe(canonical.HUNT_TIERS_TEXT);
  });
  it("tiers are distinct and only tier 1/2 mention CHoCH", () => {
    expect(tierLabel(1)).toBe("T1 CHoCH");
    expect(tierLabel(2)).toBe("T2 CHoCH+");
    expect(tierLabel(3)).toBe("T3 Reversal");
    expect(tierLabel(null)).toBeNull();
    expect(tierLabel(7)).toBeNull();
    expect(HUNT_TIERS_TEXT).toBe("T1 CHoCH · T2 CHoCH+ · T3 Reversal");
  });
  it("types are directional; unknown types pass through verbatim", () => {
    expect(typeLabel("bearish_reversal_pattern")).toBe("Bearish Reversal Pattern");
    expect(typeLabel("bullish_choch")).toBe("Bullish CHoCH");
    expect(typeLabel("bearish_choch_relaxed")).toBe("Bearish CHoCH (wick)");
    expect(typeLabel("something_new")).toBe("something_new");
    expect(typeLabel(null)).toBeNull();
  });
  it("hunting caption carries direction and timeframe", () => {
    expect(huntingCaption("short", "5m")).toBe("Waiting for bearish 5m confirmation");
    expect(huntingCaption("long", "15m")).toBe("Waiting for bullish 15m confirmation");
  });
});

describe("entry difference uses the symbol's own pip size", () => {
  it("NZD/CAD short: filled 1.6 pips higher is favourable", () => {
    const d = entryDifference({ symbol: "NZD/CAD", direction: "short", status: "filled",
      entry_price: 0.80165, fill_price: 0.80181 })!;
    expect(d.rawPips).toBeCloseTo(1.6, 6);
    expect(d.display).toBe("+1.6 pips");
    expect(d.favourable).toBe(true);
  });
  it("USD/JPY short: filled 7 pips LOWER is adverse (pip = 0.01, not 0.0001)", () => {
    // The legacy a439f5bc fill: limit 157.6272, market fill 157.55707.
    const d = entryDifference({ symbol: "USD/JPY", direction: "short", status: "filled",
      entry_price: 157.6272, fill_price: 157.55707 })!;
    expect(d.rawPips).toBeCloseTo(-7.013, 2);
    expect(d.favourable).toBe(false);
  });
  it("long: filling lower is favourable", () => {
    expect(entryDifference({ symbol: "EUR/USD", direction: "long", status: "filled",
      entry_price: 1.1, fill_price: 1.0998 })!.favourable).toBe(true);
  });
  it("missing fill yields null, not zero", () => {
    expect(entryDifference({ symbol: "EUR/USD", direction: "long", status: "filled", entry_price: 1.1 })).toBeNull();
  });
});

describe("readConfirmation", () => {
  it("prefers the canonical record", () => {
    const c = readConfirmation({ symbol: "X", direction: "short", status: "filled",
      entry_confirmation: { type: "bearish_choch", tier: 1, timeframe: "5m", price: 1.2,
        displacement: 0.6, significance: "external", closeBased: true, supportingSignals: ["fvg"] } })!;
    expect(c).toMatchObject({ tier: 1, type: "bearish_choch", price: 1.2, closeBased: true,
      significance: "external", supportingSignals: ["fvg"] });
  });
  it("falls back to scalar columns without inventing price/displacement", () => {
    const c = readConfirmation({ symbol: "X", direction: "short", status: "filled",
      confirmation_tier: 3, confirmation_type: "bearish_reversal_pattern", confirmation_timeframe: "5m" })!;
    expect(c.price).toBeNull();
    expect(c.displacement).toBeNull();
    expect(c.closeBased).toBeNull();
    expect(c.supportingSignals).toEqual([]);
  });
  it("legacy: null", () => {
    expect(readConfirmation({ symbol: "X", direction: "long", status: "filled" })).toBeNull();
  });
});

describe("cohort, lifecycle and outcome labels", () => {
  it("cohort is informational and three-valued", () => {
    expect(cohortLabel(false)).toBe("Primary Route 2");
    expect(cohortLabel(true)).toBe("Ex-Route-1 / Observational");
    expect(cohortLabel(null)).toBeNull();
    expect(cohortLabel(undefined)).toBeNull();
  });
  it("lifecycle short form never promotes a V1 row to V2", () => {
    expect(lifecycleShort("smc-route2-confirmation-lifecycle-v2")).toBe("V2");
    expect(lifecycleShort("smc-zone-impulse-control-v1")).toBe("V1");
    expect(lifecycleShort(null)).toBeNull();
  });
  it("TTL comes from the order's own timestamps", () => {
    expect(ttlHours({ symbol: "X", direction: "long", status: "expired",
      placed_at: "2026-09-30T02:00:00Z", expires_at: "2026-09-30T10:00:00Z" })).toBe(8);
    expect(ttlHours({ symbol: "X", direction: "long", status: "expired",
      placed_at: "2026-09-16T07:10:00Z", expires_at: "2026-09-16T08:10:00Z" })).toBe(1);
  });
  it("outcome labels", () => {
    expect(outcomeLabel({ symbol: "X", direction: "long", status: "filled" }).primary).toBe("CONFIRMED");
    expect(outcomeLabel({ symbol: "X", direction: "long", status: "cancelled",
      terminal_reason: "CANCELLED_REFINED_ZONE_FAILURE" }).primary).toBe("CANCELLED — REFINED ZONE FAILURE");
    expect(outcomeLabel({ symbol: "X", direction: "long", status: "cancelled" }).primary).toBe("CANCELLED");
    const e = outcomeLabel({ symbol: "X", direction: "long", status: "expired",
      placed_at: "2026-09-30T02:00:00Z", expires_at: "2026-09-30T10:00:00Z",
      terminal_reason: "EXPIRED_AFTER_TOUCH_NO_CONFIRMATION" });
    expect(e.primary).toBe("EXPIRED — 8H TTL");
    expect(e.detail).toBe("TOUCHED, NO CONFIRMATION");
  });
});
