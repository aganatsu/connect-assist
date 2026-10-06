/**
 * STEP 10 — Route 2 stop measured from the order's limit entry. Real case
 * shape from the pre-reset data: GBP/USD short, market→SL 32.4p (passed the
 * 25p floor), but limit→SL only 12.0p once the order's own entry was used.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { route2StopFromLimit } from "../../functions/_shared/route2StopGeometry.ts";
import { resolveSimplification } from "../../functions/_shared/simplification.ts";

const P = 0.0001;
const base = { direction: "short" as const, limit: 1.33000, pipSize: P, tpRatio: 1.1, minSlPips: 25, impulseCapPips: 60 };

Deno.test("the real failure shape: a stop inside the floor from the limit is widened to the floor", () => {
  const g = route2StopFromLimit({ ...base, swingSL: 1.33120, impulseSL: null });
  assert(g.ok);
  assertEquals(g.source, "floor");
  assert(g.widenedToFloor);
  assert(Math.abs(g.riskPips - 25) < 1e-9);
  assert(Math.abs(g.sl - 1.33250) < 1e-12);
  assert(Math.abs(g.tp - (1.33000 - 0.0025 * 1.1)) < 1e-12);
});

Deno.test("a swing stop beyond the floor is kept", () => {
  const g = route2StopFromLimit({ ...base, swingSL: 1.33400, impulseSL: null });
  assertEquals(g.source, "swing");
  assert(Math.abs(g.riskPips - 40) < 1e-9);
});

Deno.test("Impulse origin replaces the swing stop only if farther from the limit AND within the cap", () => {
  const wider = route2StopFromLimit({ ...base, swingSL: 1.33300, impulseSL: 1.33450 });
  assertEquals(wider.source, "impulse");
  const tighter = route2StopFromLimit({ ...base, swingSL: 1.33400, impulseSL: 1.33300 });
  assertEquals([tighter.source, tighter.impulseRejected], ["swing", "not_wider"]);
  const overCap = route2StopFromLimit({ ...base, swingSL: 1.33300, impulseSL: 1.33700 });
  assertEquals([overCap.source, overCap.impulseRejected], ["swing", "over_cap"]);
});

Deno.test("a stop on the wrong side of the limit is never used", () => {
  const g = route2StopFromLimit({ ...base, swingSL: 1.32900, impulseSL: 1.32800 });
  assertEquals(g.source, "floor");
  assertEquals(g.impulseRejected, "wrong_side");
  assert(g.sl > base.limit, "short stop above the entry");
  const long = route2StopFromLimit({ ...base, direction: "long", limit: 1.1, swingSL: 1.1005, impulseSL: null });
  assert(long.sl < 1.1 && Math.abs(long.riskPips - 25) < 1e-9);
});

Deno.test("result is always at least the floor from the limit, on the correct side", () => {
  for (const swing of [null, 1.3301, 1.3310, 1.3320, 1.3330, 1.3350, 1.3290]) {
    for (const imp of [null, 1.3305, 1.3340, 1.3380, 1.3290]) {
      const g = route2StopFromLimit({ ...base, swingSL: swing, impulseSL: imp });
      assert(g.ok && g.sl > base.limit && g.riskPips >= 25 - 1e-9, `${swing}/${imp} → ${g.sl}`);
      assert(Math.abs(Math.abs(g.tp - base.limit) - Math.abs(g.sl - base.limit) * 1.1) < 1e-12, "TP = limit ± risk × ratio");
    }
  }
});

Deno.test("invalid inputs fail closed; switch defaults to market", () => {
  assertEquals(route2StopFromLimit({ ...base, limit: 0, swingSL: 1.334, impulseSL: null }).ok, false);
  assertEquals(route2StopFromLimit({ ...base, minSlPips: 0, swingSL: 1.334, impulseSL: null }).ok, false);
  assertEquals(resolveSimplification({}).stopAnchor, "market");
  assertEquals(resolveSimplification({ simplification: { stopAnchor: "limit" } }).stopAnchor, "limit");
});

const scanner = Deno.readTextFileSync(new URL("../../functions/bot-scanner/index.ts", import.meta.url));
Deno.test("wiring: anchored geometry computed from the limit, before the order R:R check and sizing; both recorded", () => {
  const a = scanner.indexOf("const anchored = route2StopFromLimit({");
  const rr = scanner.indexOf("const orr = orderEffectiveRR({ entry: limitEntry.price, stop: limitSL, target: limitTP");
  const plan = scanner.indexOf("plannedSizing = fillTimeSize({");
  assert(a > 0 && a < rr && rr < plan);
  const block = scanner.slice(a, a + 1800);
  assert(/limit: limitEntry\.price,/.test(block));
  assert(/minSlPips: effectiveMinSlPips,/.test(block));
  assert(/\(detail as any\)\.route2Stop = \{/.test(block) && /market: \{ sl: limitSL/.test(block) && /limit: anchored/.test(block));
  assert(/if \(simp\.stopAnchor === "limit"\) \{[\s\S]*limitSL = anchored\.sl;[\s\S]*limitTP = anchored\.tp;/.test(block));
  assert(/impulseStopCandidate = \{ sl: impulseSL, capPips: maxImpulseSlPips \};/.test(scanner), "the impulse candidate is captured from the existing chain");
});
