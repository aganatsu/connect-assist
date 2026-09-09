import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The Tier 1 gate counts factors but never asks WHICH.
 *
 * Measured over the 30 days to 2026-09-09, 71 closed trades:
 *
 *   has OB or FVG    22 trades   45.5% win   +$1,234.83
 *   MS + P/D only    49 trades   32.7% win   -$3,008.10
 *
 * Break-even at 2:1 is 33.3%. Of 40 losers, 31 cleared a threshold of 2 on the
 * identical pair — Market Structure + Premium/Discount & Fib — which is "a
 * trend exists and price is in a discount", true most of the time on most
 * instruments. Order Block and Fair Value Gap carry weight 2 against Market
 * Structure's 1 because they are the entry evidence, and the count gate never
 * required either.
 *
 * The win-rate gap is NOT statistically established: 10/22 against 16/49 is
 * z ~ 1.0, p ~ 0.31. Shipped OFF for that reason. What is solid is that the
 * MS+P/D-only bucket is 69% of all trading and is down $3,008, and that
 * enabling this would have blocked those 49 trades — a smaller book, not just
 * a cleaner one.
 */

const scoring = await Deno.readTextFile(
  new URL("../../functions/_shared/confluenceScoring.ts", import.meta.url),
);
const mapper = await Deno.readTextFile(
  new URL("../../functions/_shared/configMapper.ts", import.meta.url),
);
const modal = await Deno.readTextFile(
  new URL("../../../src/components/BotConfigModal.tsx", import.meta.url),
);
const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

/** The gate's decision, mirroring confluenceScoring. */
const gate = (tier1Count: number, minTier1: number, requirePOI: boolean, hasPOI: boolean) =>
  tier1Count >= minTier1 && (!requirePOI || hasPOI);

Deno.test("off by default, the gate behaves exactly as before", () => {
  // MS + P/D at threshold 2 — the 31-of-40 case. Must still pass while off.
  assertEquals(gate(2, 2, false, false), true);
  assertEquals(gate(1, 2, false, false), false, "the count still binds");
  assertEquals(gate(4, 3, false, false), true);
});

Deno.test("on, a count-only pass without a POI is refused", () => {
  // This is the whole change: same count, same threshold, different verdict.
  assertEquals(gate(2, 2, true, false), false, "MS + P/D no longer clears it");
  assertEquals(gate(2, 2, true, true), true, "MS + OB does");
});

Deno.test("on, the count still binds independently", () => {
  // A POI alone is not enough — the threshold is not replaced, it is joined.
  assertEquals(gate(1, 2, true, true), false);
  assertEquals(gate(3, 3, true, true), true);
});

Deno.test("only Order Block and Fair Value Gap count as the trigger", () => {
  // Unicorn Model can be promoted to Tier 1 but was not part of the measured
  // split, so including it would widen the rule past its evidence.
  const i = scoring.indexOf("const _hasPOI =");
  assert(i > -1, "the POI test must exist");
  const block = scoring.slice(i, i + 260);
  assert(/\["Order Block", "Fair Value Gap"\]/.test(block), "exactly those two names");
  assert(!/Unicorn/.test(block), "Unicorn Model must not be treated as a POI here");
  // Same present/weight/tier predicate the display list uses, so a factor that
  // was demoted or zero-weighted cannot satisfy it.
  assert(/f\.present && f\.weight > 0 && \(f as any\)\.tier === 1/.test(block), "full predicate");
});

Deno.test("a POI refusal says so, rather than reporting a count problem", () => {
  // "only 2 core factors — need at least 2" would be nonsense, and this gate's
  // reason string is what lands in rejected_setups and drives every later
  // analysis of why a setup was refused.
  assert(
    /but no Order Block or Fair Value Gap — tier1RequirePOI requires an institutional entry trigger/.test(scoring),
    "distinct reason for the composition failure",
  );
  // The count branch must still exist and be chosen first.
  const i = scoring.indexOf("const tier1GateReason =");
  const block = scoring.slice(i, i + 700);
  assert(/: !tier1CountPassed/.test(block), "count failure takes precedence in the message");
});

Deno.test("impulse-zone credits satisfy the requirement by construction", () => {
  // That block only ever credits OB or FVG, so it needs no POI term of its own
  // — and it is the best-performing route (7 trades, 57.1%, +$1,100.70), so
  // silently breaking it would be the expensive mistake here.
  const i = scanner.indexOf("const newPassed = newTier1Count >= _minT1;");
  assert(i > -1, "the credit path still computes its own pass");
  const before = scanner.slice(Math.max(0, i - 400), i);
  assert(/only ever\s*\n?\s*\/\/ credits Order Block or Fair Value Gap/.test(before),
    "and says why it carries no POI term");
});

Deno.test("the flag is defaulted off and reachable from both config nestings", () => {
  assert(/^  tier1RequirePOI: false,$/m.test(mapper), "default must be off");
  assert(
    /tier1RequirePOI: strategy\.tier1RequirePOI \?\? raw\.tier1RequirePOI \?\? RUNTIME_DEFAULTS\.tier1RequirePOI,/
      .test(mapper),
    "strategy then raw then default, matching every other flag",
  );
});

Deno.test("the toggle is in the UI and hidden when the gate itself is off", () => {
  assert(/checked=\{config\.strategy\?\.tier1RequirePOI \?\? false\}/.test(modal), "toggle bound and off by default");
  // It sits inside the tier1GateEnabled conditional — offering a composition
  // rule while Gate 19 is disabled would imply a filter that cannot run.
  const guard = modal.indexOf("{(config.strategy?.tier1GateEnabled ?? true) && (");
  const toggle = modal.indexOf("tier1RequirePOI");
  const close = modal.indexOf("                    )}", guard);
  assert(guard > -1 && toggle > guard && toggle < close, "must render inside the enabled block");
});

Deno.test("the toggle states the cost, not just the benefit", () => {
  // 49 of 71 blocked is a different strategy, not a tuning nudge, and the
  // measurement behind it is not significant. Both belong in front of anyone
  // about to flip it.
  const i = modal.indexOf("Require Order Block or FVG");
  const block = modal.slice(i, i + 700);
  assert(/49 of 71/.test(block), "say how many trades it removes");
  assert(/45\.5%/.test(block) && /32\.7%/.test(block), "and the split it rests on");
});
