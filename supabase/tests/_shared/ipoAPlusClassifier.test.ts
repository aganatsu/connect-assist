import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  CLASSIFIERS, classifierStats, sequential, type ScorableTrade,
} from "../../functions/_shared/ipoAPlusClassifier.ts";
import type { Annotation } from "../../functions/_shared/ipoConfluenceFeatures.ts";

const ann = (o: Partial<Annotation> = {}): Annotation => ({
  FVG: "ABSENT", TREND_ALIGNED: "PRESENT", HTF_PARENT: "NO_PARENT",
  FIB_50_100: "PRESENT", SR_OVERLAP: "ABSENT", INSTITUTIONAL_IPDA: "PRESENT",
  INSTITUTIONAL_VOLUME_PROFILE: "NOT_YET_MACHINE_DEFINED", touchBucket: "1st",
  ...o,
});
const by = (k: string) => CLASSIFIERS.find((c) => c.key === k)!;
const t = (netR: number, touchIndex: number, exitIndex: number, mae = 1): ScorableTrade =>
  ({ netR, touchIndex, exitIndex, mae });

Deno.test("every variant requires FVG — it is the only Tier-1 feature", () => {
  const noFvg = ann({ FVG: "ABSENT", SR_OVERLAP: "PRESENT" });
  for (const c of CLASSIFIERS) {
    assertEquals(c.admits(noFvg), false, `${c.key} admitted a setup with no FVG`);
  }
});

Deno.test("A1 requires FVG and nothing else", () => {
  assert(by("A1").admits(ann({ FVG: "PRESENT" })));
  assert(by("A1").admits(ann({
    FVG: "PRESENT", SR_OVERLAP: "ABSENT", HTF_PARENT: "PARENT_BOTH_SIDES",
    TREND_ALIGNED: "ABSENT", FIB_50_100: "ABSENT", touchBucket: "3rd+",
  })), "A1 must ignore every feature except FVG");
});

Deno.test("A2 additionally requires SR_OVERLAP", () => {
  assertEquals(by("A2").admits(ann({ FVG: "PRESENT", SR_OVERLAP: "ABSENT" })), false);
  assert(by("A2").admits(ann({ FVG: "PRESENT", SR_OVERLAP: "PRESENT" })));
});

Deno.test("A3 excludes only the contested-parent case, not conflicting parents", () => {
  const a3 = by("A3");
  assertEquals(a3.admits(ann({ FVG: "PRESENT", HTF_PARENT: "PARENT_BOTH_SIDES" })), false);
  assert(a3.admits(ann({ FVG: "PRESENT", HTF_PARENT: "CONFLICTING_PARENT" })),
    "a conflicting parent is not the excluded case — only both-sides is");
  assert(a3.admits(ann({ FVG: "PRESENT", HTF_PARENT: "NO_PARENT" })));
  assert(a3.admits(ann({ FVG: "PRESENT", HTF_PARENT: "PRESENT" })));
});

Deno.test("A4 is the conjunction of A2 and A3", () => {
  const cases = [
    ann({ FVG: "PRESENT", SR_OVERLAP: "PRESENT", HTF_PARENT: "NO_PARENT" }),
    ann({ FVG: "PRESENT", SR_OVERLAP: "PRESENT", HTF_PARENT: "PARENT_BOTH_SIDES" }),
    ann({ FVG: "PRESENT", SR_OVERLAP: "ABSENT", HTF_PARENT: "NO_PARENT" }),
    ann({ FVG: "ABSENT", SR_OVERLAP: "PRESENT", HTF_PARENT: "NO_PARENT" }),
  ];
  for (const c of cases) {
    assertEquals(by("A4").admits(c), by("A2").admits(c) && by("A3").admits(c));
  }
});

Deno.test("excluded features never influence admission", () => {
  // Same FVG/SR/parent state, every excluded feature flipped. Admission must not move.
  const base = { FVG: "PRESENT", SR_OVERLAP: "PRESENT", HTF_PARENT: "NO_PARENT" } as const;
  const permissive = ann({ ...base, TREND_ALIGNED: "PRESENT", FIB_50_100: "PRESENT",
    INSTITUTIONAL_IPDA: "PRESENT", touchBucket: "1st" });
  const hostile = ann({ ...base, TREND_ALIGNED: "ABSENT", FIB_50_100: "ABSENT",
    INSTITUTIONAL_IPDA: "ABSENT", touchBucket: "3rd+" });
  for (const c of CLASSIFIERS) {
    assertEquals(c.admits(permissive), c.admits(hostile),
      `${c.key} reacted to a feature that is not in its definition`);
  }
});

Deno.test("classifierStats reports drawdown, streak and per-month rate", () => {
  const m = classifierStats([t(2, 0, 1), t(-1, 2, 3), t(-1, 4, 5), t(-1, 6, 7), t(1, 8, 9)], 2);
  assertEquals(m.trades, 5);
  assertEquals(m.winRate, 40);
  assertEquals(m.longestLosingStreak, 3);
  assertEquals(m.maxDrawdownR, 3);
  assertEquals(m.totalR, 0);
  assertEquals(m.expectancyR, 0);
  assertEquals(m.profitFactor, 1);
  assertEquals(m.tradesPerMonth, 2.5);
});

Deno.test("statistics are order-independent of the input array, not of time", () => {
  const trades = [t(-1, 10, 11), t(2, 0, 1), t(-1, 20, 21)];
  const a = classifierStats(trades, null);
  const b = classifierStats([...trades].reverse(), null);
  assertEquals(a.maxDrawdownR, b.maxDrawdownR, "results must not depend on array order");
  assertEquals(a.maxDrawdownR, 2, "the +2 came first in TIME, so the drawdown after it is 2");
});

Deno.test("maxConcurrent counts overlapping holds, and is 1 after sequencing", () => {
  const overlapping = [t(1, 0, 10), t(1, 2, 12), t(1, 4, 6)];
  assertEquals(classifierStats(overlapping, null).maxConcurrent, 3);
  const seq = sequential(overlapping);
  assertEquals(seq.length, 1, "the first trade occupies bars 0-10 and blocks both others");
  assertEquals(classifierStats(seq, null).maxConcurrent, 1);
});

Deno.test("sequencing takes the next trade that opens strictly after the last exit", () => {
  const ts = [t(1, 0, 5), t(1, 5, 8), t(1, 6, 9), t(1, 20, 25)];
  const seq = sequential(ts).map((x) => x.touchIndex);
  assertEquals(seq, [0, 6, 20], "a touch ON the exit bar is still occupied");
});

Deno.test("an empty subset reports zeros rather than NaN", () => {
  const m = classifierStats([], 3);
  assertEquals(m.trades, 0);
  assertEquals(m.expectancyR, 0);
  assertEquals(m.profitFactor, null);
  assertEquals(m.tradesPerMonth, 0);
  assert(!Number.isNaN(m.avgMAE));
});

Deno.test("the classifier carries no weight, score or tuned threshold", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoAPlusClassifier.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const banned of ["weight", "score", "threshold", "tune"]) {
    assert(!new RegExp(banned, "i").test(code), `"${banned}" leaked into the classifier`);
  }
  // Admission must be pure membership: no numeric comparison against a constant.
  const admitLines = code.split("\n").filter((l) => l.includes("admits"));
  for (const l of admitLines) {
    assert(!/[<>]=?\s*\d/.test(l), `a numeric cutoff appeared in an admission rule: ${l.trim()}`);
  }
});

Deno.test("there are exactly four variants, named A1–A4", () => {
  assertEquals(CLASSIFIERS.map((c) => c.key), ["A1", "A2", "A3", "A4"]);
});
