import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runLifecycle, lifecycleStats, sanityChecks } from "../../functions/_shared/ipoLifecycle.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  datetime: new Date(Date.UTC(2021, 0, 1, i)).toISOString(),
  open: o, high: h, low: l, close: c, volume: 0,
} as Candle);

/** Contraction, then a red candle, then a rally that clears the contraction high. */
function clearingSeries(): Candle[] {
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < 14; i++) out.push(bar(i, p, p + 2, p - 2, p + (i % 2 ? 0.4 : -0.4)));
  out.push(bar(14, 100, 101, 96, 97));                       // red: the candidate
  for (let i = 15; i < 28; i++) { out.push(bar(i, p, p + 8, p - 1, p + 7)); p += 7; }
  return out;
}

Deno.test("a candidate only validates after clearing the prior contraction", () => {
  const s = clearingSeries();
  const eps = [{ start: 0, end: 13, high: 102, low: 98 }];
  const all = runLifecycle(s, eps);
  const v = all.filter((x) => x.validAt !== null);
  assert(v.length > 0, "nothing validated on a series that clearly clears");
  for (const x of v) {
    assert(x.clearedAt !== null, "validation without clearance");
    assert(x.validAt! >= x.clearedAt!, "validation cannot precede clearance");
  }
});

Deno.test("a candidate inside an active contraction is suppressed, offset 0 included", () => {
  const s = clearingSeries();
  const eps = [{ start: 0, end: 20, high: 102, low: 98 }];   // swallows the candidate
  const all = runLifecycle(s, eps);
  const sup = all.filter((x) => x.suppressedByContraction);
  assert(sup.length > 0, "a candidate inside a contraction must be suppressed");
  for (const x of sup) assertEquals(x.validAt, null, "a suppressed candidate must never validate");
});

Deno.test("repeated touches never invalidate", () => {
  const s = clearingSeries();
  const all = runLifecycle(s, [{ start: 0, end: 13, high: 102, low: 98 }]);
  const sc = sanityChecks(s, all, [{ start: 0, end: 13, high: 102, low: 98 }]);
  assertEquals(sc.touchCausedInvalidation, 0);
  assertEquals(sc.invalidationOnWickOnly, 0);
});

Deno.test("invalidation requires a CLOSE beyond the original candle extreme", () => {
  const s: Candle[] = [];
  let p = 100;
  for (let i = 0; i < 14; i++) s.push(bar(i, p, p + 2, p - 2, p + (i % 2 ? 0.4 : -0.4)));
  s.push(bar(14, 100, 101, 96, 97));                          // candidate, low 96
  for (let i = 15; i < 22; i++) s.push(bar(i, 100, 110, 99, 109));  // clears
  s.push(bar(22, 109, 110, 90, 108));                         // deep WICK below 96, closes above
  const all = runLifecycle(s, [{ start: 0, end: 13, high: 102, low: 98 }]);
  for (const x of all.filter((v) => v.validAt !== null)) {
    if (x.invalidatedAt !== null) {
      const c = s[x.invalidatedAt];
      const beyond = x.direction === "demand" ? c.close < x.invalidationLevel : c.close > x.invalidationLevel;
      assert(beyond, "invalidation fired without a close beyond the extreme");
    }
  }
});

Deno.test("stats never report more valid than pending", () => {
  const s = clearingSeries();
  const eps = [{ start: 0, end: 13, high: 102, low: 98 }];
  const st = lifecycleStats(s, runLifecycle(s, eps));
  assert(st.validPer1000 <= st.pendingPer1000);
  assert(st.pctPendingBecomingValid >= 0 && st.pctPendingBecomingValid <= 100);
});
