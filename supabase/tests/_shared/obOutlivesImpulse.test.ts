import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { enumerateImpulseLegs, findImpulseLeg } from "../../functions/_shared/impulseZoneEngine.ts";
import { detectStructuralOrderBlocks } from "../../functions/_shared/structuralOrderBlocks.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

/**
 * A parent impulse must not retroactively delete its child order block.
 *
 * validateImpulseFromBOS discards a leg once price retraces past its origin.
 * That is the right answer to "would I trade this impulse now" and the wrong
 * answer to "does this zone still exist".
 *
 * From the AUD/USD daily reference chart: a bearish move began in late March
 * and produced a supply zone at 0.70584 -> 0.70000. In May price rallied above
 * where that move started, so the leg died and took the zone with it — while
 * the hand-drawn chart still carries that box months later, because price
 * never accepted through the BOX.
 *
 * Third inherited rule of the same shape, after "newest leg only" and "last 50
 * candles". Each is correct for a live setup and wrong for an inventory.
 */

let t = 0;
function candle(o: number, h: number, l: number, c: number): Candle {
  const dt = new Date(Date.UTC(2026, 0, 1 + t++)).toISOString().slice(0, 19);
  return { datetime: dt, open: o, high: h, low: l, close: c } as Candle;
}

/**
 * A rising staircase, then a selloff deep enough to close below every swing low
 * that started those legs — the exact shape that killed the March AUD/USD zone.
 *
 * Measured on this fixture: with no selloff both paths find 3 legs. Add the
 * selloff and the DEFAULT path finds 0 while the opt-in path finds 4. Price
 * action arriving later deletes zones that already existed.
 */
function risingThenCrash(crashBars: number): Candle[] {
  t = 0;
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < 4; i++) out.push(candle(p, p + 1, p - 1, p));
  for (let s = 0; s < 5; s++) {
    for (let i = 0; i < 4; i++) { const o = p - i * 3, c = o - 3; out.push(candle(o, o + 0.5, c - 0.5, c)); }
    const low = p - 12;
    out.push(candle(low, low + 0.5, low - 4, low + 1));            // trough pivot
    for (let i = 0; i < 5; i++) { const o = low + 1 + i * 4, c = o + 4; out.push(candle(o, c + 0.5, o - 0.5, c)); }
    const hi = low + 21;
    out.push(candle(hi, hi + 4, hi - 0.5, hi - 1));                // peak pivot
    p = hi + 4;
  }
  for (let i = 0; i < crashBars; i++) { const o = p - i * 8, c = o - 8; out.push(candle(o, o + 0.5, c - 0.5, c)); }
  return out;
}

Deno.test("later price action used to delete zones that already existed", () => {
  // The bug in one comparison. Same chart, one with a selloff appended.
  const quiet = enumerateImpulseLegs(risingThenCrash(0), "D");
  const afterCrash = enumerateImpulseLegs(risingThenCrash(14), "D");
  assert(quiet.length >= 3, `the staircase produces legs (${quiet.length})`);
  assertEquals(afterCrash.length, 0,
    "on the default path a selloff erases every historical leg — and its zones");
});

Deno.test("the live finder is unchanged — it never returns a dead leg", () => {
  // findImpulseLeg answers "would I trade this now". That must keep working
  // exactly as before; only the inventory question changes.
  const candles = risingThenCrash(14);
  const leg = findImpulseLeg(candles, "bullish");
  assert(leg === null || leg.isValid);
  assert(enumerateImpulseLegs(candles).every(l => l.isValid !== false));
});

Deno.test("opting in keeps the leg, flagged rather than discarded", () => {
  const candles = risingThenCrash(14);
  const withBroken = enumerateImpulseLegs(candles, "D", { includeBrokenOrigin: true });
  assert(withBroken.length >= 4, `legs survive the crash (${withBroken.length})`);
  const broken = withBroken.filter(l => l.originBroken);
  assertEquals(broken.length, withBroken.length, "all are flagged, not silently kept");
  for (const l of broken) assertEquals(l.isValid, false, "isValid still answers the live question");
});

Deno.test("the block survives its parent and records why", () => {
  const candles = risingThenCrash(14);
  const legs = enumerateImpulseLegs(candles, "D", { includeBrokenOrigin: true });
  const blocks = detectStructuralOrderBlocks(candles, legs, { symbol: "TEST/USD", timeframe: "D" });
  assert(blocks.length > 0, "a zone exists even though its parent impulse is dead");
  const orphaned = blocks.filter(b => b.parentImpulseBroken);
  assert(orphaned.length > 0, "and says so");
  // Crucially the block is NOT invalidated by the parent. Only price accepting
  // through the distal boundary can do that.
  for (const b of orphaned) {
    assert(["NEW", "ACTIVE", "MITIGATED", "OLD", "INVALIDATED"].includes(b.status));
    if (b.status === "INVALIDATED") {
      assert(b.invalidatedIndex !== undefined,
        "an invalidated block was invalidated by PRICE, with the bar recorded");
    }
  }
});

Deno.test("the runner opts in; the live path does not", () => {
  const runner = Deno.readTextFileSync(
    new URL("../../functions/_shared/structuralOrderBlockRunner.ts", import.meta.url));
  assert(/includeBrokenOrigin: true/.test(runner), "V2 keeps orphaned zones");

  const engine = Deno.readTextFileSync(
    new URL("../../functions/_shared/impulseZoneEngine.ts", import.meta.url));
  const finder = engine.slice(engine.indexOf("export function findImpulseLeg"),
                              engine.indexOf("export function enumerateImpulseLegs"));
  assert(!/allowBrokenOrigin/.test(finder),
    "findImpulseLeg must keep answering the live-setup question unchanged");
});

Deno.test("the column exists to store it", () => {
  const mig = Deno.readTextFileSync(new URL(
    "../../migrations/20260918000000_ob_parent_impulse_broken.sql", import.meta.url));
  assert(/ADD COLUMN IF NOT EXISTS parent_impulse_broken boolean/.test(mig));
  const runner = Deno.readTextFileSync(
    new URL("../../functions/_shared/structuralOrderBlockRunner.ts", import.meta.url));
  assert(/parent_impulse_broken: ob\.parentImpulseBroken/.test(runner), "and the row writes it");
});
