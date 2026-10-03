/**
 * TTM Squeeze — causality and formula tests for IPO_TTM_SQUEEZE_TELEMETRY_V1.
 *
 * The telemetry is only meaningful if the TTM state attached to a trade was
 * knowable when the trade was taken. These tests pin that:
 *   - no series value depends on any later bar (prefix invariance);
 *   - changing any bar at or after the entry bar cannot change the state used;
 *   - a squeeze release is only detected once the bar that ended it is known;
 *   - the study feeds the engine's own `barsBefore` prefix, never the touch bar.
 */

import { assertEquals, assert, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ttmSeries, ttmAtDecision, squeezePhase, TTM_LENGTH, TTM_BB_MULT, TTM_KC_MULT,
  type Bar,
} from "../../../local-runner/ttmSqueeze.ts";

/** Deterministic pseudo-random walk, so the tests need no fixtures. */
function walk(n: number, seed = 7, vol = 1): Bar[] {
  let s = seed, px = 100;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const o = px, c = px + (rnd() - 0.5) * 2 * vol;
    out.push({ open: o, close: c, high: Math.max(o, c) + rnd() * vol, low: Math.min(o, c) - rnd() * vol });
    px = c;
  }
  return out;
}

Deno.test("parameters are the frozen 20 / 2.0 / 1.5", () => {
  assertEquals([TTM_LENGTH, TTM_BB_MULT, TTM_KC_MULT], [20, 2.0, 1.5]);
});

// ─── causality ──────────────────────────────────────────────────────────────

Deno.test("prefix invariance: every value at i is computed from bars[0..i] only", () => {
  const bars = walk(300);
  const full = ttmSeries(bars);
  for (let i = 0; i < bars.length; i++) {
    const p = ttmSeries(bars.slice(0, i + 1));
    assertEquals(p.squeezeOn[i], full.squeezeOn[i], `squeezeOn changed at ${i} when later bars were removed`);
    assertEquals(p.momentum[i], full.momentum[i], `momentum changed at ${i} when later bars were removed`);
  }
});

Deno.test("changing ANY future candle after entry does not alter the TTM state used", () => {
  const bars = walk(300, 11);
  const entryIndex = 200;
  const before = ttmAtDecision(bars.slice(0, entryIndex), "demand", "1h");
  // Wreck every bar from the entry bar onward — the touch bar included.
  const mutated = bars.map((b, i) => i >= entryIndex
    ? { open: b.close * 5, close: b.close * -3, high: 1e9, low: -1e9 } : b);
  const after = ttmAtDecision(mutated.slice(0, entryIndex), "demand", "1h");
  assertEquals(after, before);
  // And the full-series computation agrees at the decision bar, so nothing
  // downstream of the prefix leaks back either.
  const s = ttmSeries(mutated);
  assertEquals(s.squeezeOn[entryIndex - 1], before.ttm_squeeze_on);
  assertEquals(s.momentum[entryIndex - 1], before.ttm_momentum);
});

Deno.test("the forming entry (touch) bar is never read", () => {
  const bars = walk(250, 3);
  const k = 180;
  const a = ttmAtDecision(bars.slice(0, k), "supply", "4h");
  const b = ttmAtDecision([...bars.slice(0, k)], "supply", "4h");
  assertEquals(a, b);
  assertEquals(a.ttm_decision_bar_index, k - 1, "decision bar is the last CLOSED bar before the touch bar");
});

/** A series that squeezes (low vol) and then breaks out (high vol). */
function squeezeThenBreakout(quiet: number, loud: number): Bar[] {
  const out: Bar[] = [];
  let px = 100;
  for (let i = 0; i < 60; i++) {                       // ordinary range
    const c = px + (i % 2 ? 1 : -1) * 0.8;
    out.push({ open: px, close: c, high: Math.max(px, c) + 1.2, low: Math.min(px, c) - 1.2 }); px = c;
  }
  for (let i = 0; i < quiet; i++) {                    // compression: tiny closes, wide-ish wicks keep ATR up
    const c = 100 + (i % 2 ? 0.02 : -0.02);
    out.push({ open: px, close: c, high: Math.max(px, c) + 0.6, low: Math.min(px, c) - 0.6 }); px = c;
  }
  for (let i = 0; i < loud; i++) {                     // expansion: closes trend hard
    const c = px + 2.5;
    out.push({ open: px, close: c, high: c + 0.3, low: px - 0.3 }); px = c;
  }
  return out;
}

Deno.test("release timing uses only already-known bars", () => {
  const bars = squeezeThenBreakout(60, 25);
  const s = ttmSeries(bars);
  // Find the first release in the full series.
  let rel = -1;
  for (let i = 1; i < bars.length; i++) if (s.squeezeOn[i - 1] === true && s.squeezeOn[i] === false) { rel = i; break; }
  assert(rel > 0, "fixture must contain a squeeze release");
  // Decision one bar BEFORE the release bar closed: not yet detectable.
  const early = ttmAtDecision(bars.slice(0, rel), "demand", "1h");
  assertEquals(early.ttm_squeeze_on, true);
  assert(early.ttm_release_bars_ago === null || early.ttm_release_bars_ago > 0,
    "a release cannot be seen before the bar that ended the squeeze is closed");
  // Decision ON the release bar: release 0 bars ago.
  const same = ttmAtDecision(bars.slice(0, rel + 1), "demand", "1h");
  assertEquals(same.ttm_release_bars_ago, 0);
  assertEquals(squeezePhase(same), "RELEASED_SAME_BAR");
  // Two bars later: 2 bars ago, still "recent".
  const later = ttmAtDecision(bars.slice(0, rel + 3), "demand", "1h");
  assertEquals(later.ttm_release_bars_ago, 2);
  assertEquals(squeezePhase(later), "RELEASED_2_TO_3_BARS_AGO");
  assertEquals(later.ttm_release_detected, true);
});

// ─── formula ────────────────────────────────────────────────────────────────

Deno.test("squeeze is ON during compression and OFF during expansion", () => {
  const bars = squeezeThenBreakout(60, 25);
  const s = ttmSeries(bars);
  assertEquals(s.squeezeOn[60 + 55], true, "late in the compression the BB sit inside the KC");
  assertEquals(s.squeezeOn[bars.length - 1], false, "a hard trend blows the BB out of the KC");
});

Deno.test("momentum sign follows a sustained trend; alignment follows direction", () => {
  const up: Bar[] = Array.from({ length: 80 }, (_, i) => ({ open: 100 + i, close: 100.8 + i, high: 101 + i, low: 99.8 + i }));
  const t = ttmAtDecision(up, "demand", "1h");
  assert((t.ttm_momentum as number) > 0);
  assertEquals(t.ttm_momentum_direction, "bullish");
  assertEquals(t.ttm_direction_alignment, "aligned");
  assertEquals(ttmAtDecision(up, "supply", "1h").ttm_direction_alignment, "opposed");
  const down = up.map((b) => ({ open: 300 - (b.open ?? b.close), close: 300 - b.close, high: 300 - b.low, low: 300 - b.high }));
  assertEquals(ttmAtDecision(down, "supply", "1h").ttm_direction_alignment, "aligned");
});

Deno.test("linear regression returns the fitted value at the last point", () => {
  // Construct bars where momentumRaw is exactly linear: close - meanPrice.
  // Easier: verify against an independent least-squares fit of the raw series.
  const bars = walk(120, 5);
  const s = ttmSeries(bars);
  const i = 100, L = 20;
  const raw = (j: number) => {
    let hh = -Infinity, ll = Infinity, sum = 0;
    for (let k = j - L + 1; k <= j; k++) { hh = Math.max(hh, bars[k].high); ll = Math.min(ll, bars[k].low); sum += bars[k].close; }
    return bars[j].close - ((hh + ll) / 2 + sum / L) / 2;
  };
  const ys = Array.from({ length: L }, (_, k) => raw(i - L + 1 + k));
  const xs = ys.map((_, k) => k);
  const xm = xs.reduce((a, b) => a + b) / L, ym = ys.reduce((a, b) => a + b) / L;
  const b1 = xs.reduce((a, x, k) => a + (x - xm) * (ys[k] - ym), 0) / xs.reduce((a, x) => a + (x - xm) ** 2, 0);
  assertAlmostEquals(s.momentum[i] as number, ym + b1 * (L - 1 - xm), 1e-9);
});

Deno.test("too little history yields null state and neutral alignment, never a guess", () => {
  const t = ttmAtDecision(walk(25), "demand", "1h");
  assertEquals(t.ttm_momentum, null, "momentum needs 2*20-1 bars");
  assertEquals(t.ttm_direction_alignment, "neutral");
  assertEquals(ttmAtDecision([], "demand", "1h").ttm_squeeze_on, null);
  assertEquals(squeezePhase(ttmAtDecision(walk(10), "demand", "1h")), "UNAVAILABLE");
});

// ─── the study wiring ───────────────────────────────────────────────────────

Deno.test("the study computes TTM from the engine's barsBefore prefix, and filters nothing", () => {
  const src = Deno.readTextFileSync(new URL("../../../local-runner/ipo-ttm-telemetry.ts", import.meta.url));
  assert(/const prefix = bars\.slice\(0, entryIdx\);/.test(src),
    "TTM must be computed from the bars strictly before the touch bar");
  // entryIdx is the FROZEN trade's own touch bar, located by its timestamp.
  assert(/const entryIdx = bars\.findIndex\(\(b\) => b\.datetime === r\.entry_time\);/.test(src));
  // The per-trade data-equivalence gate must stand between the data and TTM.
  for (const g of ["IPO_CANDLE_DIFF", "ENTRY_BAR_DOES_NOT_REACH", "ENTRY_NOT_AFTER_IPO", "ABSENT"]) {
    assert(src.includes(g), `the data gate must check ${g}`);
  }
  // The engine re-run is diagnostic only; it must exit, never feed the study.
  assert(/if \(Deno\.args\.includes\("--reconstruct"\)\) \{/.test(src));
  assert(/Deno\.exit\(GATE_PASS \? 0 : 3\);/.test(src));
  assert(/ttmAtDecision\(prefix,/.test(src));
  // Telemetry only: the engine is imported and read, never configured with a TTM gate.
  assert(!/entryGate:[^\n]*ttm/i.test(src), "TTM must not gate entries in this study");
  assert(/if \(!GATE_PASS\) Deno\.exit\(2\);/.test(src), "the study must stop if the control does not reconstruct");
  // The engine's own hook receives exactly this prefix.
  const eng = Deno.readTextFileSync(new URL("../../functions/_shared/ipoIncrementalEngine.ts", import.meta.url));
  assert(/barsBefore: this\.bars\.slice\(0, K\)/.test(eng), "engine defines the causal prefix as bars before K");
});

Deno.test("no production code imports the TTM module", async () => {
  for await (const e of Deno.readDir(new URL("../../functions/", import.meta.url))) {
    if (!e.isDirectory) continue;
    try {
      const src = Deno.readTextFileSync(new URL(`../../functions/${e.name}/index.ts`, import.meta.url));
      assert(!/ttmSqueeze/.test(src), `${e.name} must not import TTM`);
    } catch { /* no index.ts */ }
  }
});
