/** Scalper15 scan-detail helpers (shape written by bot-scanner as detail.scalper15). */

export interface Scalper15Detail {
  bias?: number;
  legHigh?: number;
  legLow?: number;
  zone?: { type: string; low: number; high: number };
  limit?: number;
  stop?: number;
  target?: number;
  plannedR?: number;
  reason?: string;
  outcome?: string;
}

export const fmt = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? String(+v.toPrecision(7)) : "—");

/** The one-line answer: the placement line when an order went in, else the skip reason without its "Scalper15: " prefix. */
export function scalper15Headline(status: string | undefined, s: Scalper15Detail, skipReason?: string, reason?: string): string {
  const text = status === "scalper15_order_placed" ? reason ?? "order placed" : skipReason ?? s.reason ?? reason ?? "no decision recorded";
  return text.replace(/^Scalper15:\s*/, "");
}
