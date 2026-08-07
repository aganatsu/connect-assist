import type { Candle, StructureBreak, SwingPoint } from "./smcAnalysis.ts";
import { buildCanonicalStructureAuthority, type CanonicalStructureAuthority } from "./canonicalStructureAuthority.ts";

export function canonicalStructureForLegacyConsumers(candles: Candle[]): { authority: CanonicalStructureAuthority; breaks: Array<StructureBreak & { breakType: "bos" | "choch" }>; swings: SwingPoint[] } {
  const authority = buildCanonicalStructureAuthority(candles);
  const breaks = authority.events.filter((event) => event.type !== "sweep").map((event) => ({ index: event.candleIndex, type: event.direction, price: event.extreme, datetime: event.datetime, closeBased: true, level: event.level, significance: event.significance, breakType: event.type === "bos" ? "bos" as const : "choch" as const }));
  const byPivot = new Map<string, SwingPoint>();
  for (const level of authority.levels) {
    const key = `${level.side}:${level.pivotIndex}`;
    const existing = byPivot.get(key);
    if (existing?.significance === "external") continue;
    byPivot.set(key, { index: level.pivotIndex, price: level.price, type: level.side, datetime: level.datetime, significance: level.significance, state: level.status, testedCount: 0 });
  }
  return { authority, breaks, swings: [...byPivot.values()].sort((a, b) => a.index - b.index) };
}
