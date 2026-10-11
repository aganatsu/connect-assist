import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clause } from "./helpers/clause.ts";
import { mkSeries, MON } from "./helpers/series.ts";
import type { OHLC } from "./helpers/scenario.ts";
import { buildStructure } from "../../functions/_shared/v2/v2Structure.ts";
import { direction } from "../../functions/_shared/v2/v2Direction.ts";

const F: OHLC = [0, 1, -1, 0];
const mir = (bs: (OHLC | null)[]) => bs.map((b) => (b ? [-b[0], -b[2], -b[1], -b[3]] as OHLC : null));
const flat = (n: number) => Array.from({ length: n }, () => F);

// 1H: swing high (5) at 2, bullish break at 5 → bias LONG
const H1_LONG: OHLC[] = [F, F, [0, 5, -1, 0], F, F, [0, 6, -1, 6], [6, 7, 5, 6], [6, 7, 5, 6]];

// 1H starts Wed 00:00 NY; the 15m series is placed so that its last bar closes exactly at the decision time t.
const WED = MON + 2 * 86_400_000;
function dirOf(h1: (OHLC | null)[], m15: (OHLC | null)[]) {
  const s1 = mkSeries(h1, "1h", "EUR/USD", WED);
  const t = s1.grid[s1.grid.length - 1] + s1.step;
  const s15 = mkSeries(m15, "15m", "EUR/USD", t - m15.length * 900_000);
  return direction(s1, buildStructure(s1), s15, buildStructure(s15), t);
}

clause(["2.1", "0.2"], "1H bias = latest 1H break; 15m with no breaks and ≥96 bars does not veto; LONG/SHORT mirror", () => {
  assertEquals(dirOf(H1_LONG, flat(120)), { dir: "LONG", status: "OK", bias: "LONG" });
  assertEquals(dirOf(mir(H1_LONG), flat(120)), { dir: "SHORT", status: "OK", bias: "SHORT" });
});

clause(["2.1"], "no 1H break event → NONE (no 15m fallback, no extension filter)", () => {
  assertEquals(dirOf(flat(8), flat(120)).status, "BIAS_NONE");
});

clause(["2.1"], "the most recent break wins (bullish then bearish → SHORT)", () => {
  //   swing H(5)@2, swing L(-5)@4? build: H at 2 broken at 5; L at 7 broken at 10
  const h1: OHLC[] = [F, F, [0, 5, -1, 0], F, F, [0, 6, -1, 6], [6, 7, -4, 0], [0, 1, -5, 0], [0, 1, -4, 0], [0, 1, -4, 0], [0, 1, -7, -6], [-6, -5, -7, -6]];
  assertEquals(dirOf(h1, flat(160)).dir, "SHORT");
});

clause(["2.1"], "15m veto: an opposite break on one of the 10 most recent closed 15m bars → NONE; on the 11th → no veto", () => {
  const veto = (pos: number) => {
    const m: OHLC[] = flat(110);
    // 15m swing low at slot s (−5), broken (close −6) at slot s+3 = pos
    const s = pos - 3;
    m[s] = [0, 1, -5, 0];
    m[pos] = [0, 1, -7, -6];
    return dirOf(H1_LONG, m);
  };
  assertEquals(veto(109).status, "VETOED");      // last bar
  assertEquals(veto(100).status, "VETOED");      // 10th most recent (109−9)
  assertEquals(veto(99).dir, "LONG");            // 11th → outside the veto window
  // same-direction 15m break never vetoes
  const m: OHLC[] = flat(110); m[100] = [0, 5, -1, 0]; m[105] = [0, 6, -1, 6];
  assertEquals(dirOf(H1_LONG, m).dir, "LONG");
});

clause(["1.8", "2.1"], "NOT COMPUTABLE: latest 1H or 15m MISSING; MISSING among the last 10 15m; short 15m segment without a break", () => {
  assertEquals(dirOf([...H1_LONG.slice(0, 7), null], flat(32)).status, "NOT_COMPUTABLE");
  const m = flat(120); m[115] = null as unknown as OHLC;
  assertEquals(dirOf(H1_LONG, m).status, "NOT_COMPUTABLE");               // gap among the last 10
  const m2 = flat(120); m2[100] = null as unknown as OHLC;                 // segment of 19 bars < 96, no break
  assertEquals(dirOf(H1_LONG, m2).status, "NOT_COMPUTABLE");
  const m3 = flat(120); m3[100] = null as unknown as OHLC; m3[105] = [0, 5, -1, 0]; m3[110] = [0, 6, -1, 6];
  assertEquals(dirOf(H1_LONG, m3).dir, "LONG");                            // post-gap 15m break exists → computable
  assertEquals(dirOf(H1_LONG, flat(20)).status, "NOT_COMPUTABLE");         // series shorter than the window, no break
});

clause(["1.8", "2.1"], "after a 1H gap: pre-gap breaks do not count; bias returns with the first post-gap break", () => {
  const pre: OHLC[] = [F, F, [0, 5, -1, 0], F, F, [0, 6, -1, 6], [6, 7, 5, 6]];
  assertEquals(dirOf([...pre, null, F, F, F, F, F], flat(160)).status, "BIAS_NONE");
  const post: OHLC[] = [F, F, [0, 1, -5, 0], F, F, [0, 1, -7, -6]];
  assertEquals(dirOf([...pre, null, ...post], flat(160)).dir, "SHORT");
});

clause(["2.1", "2.0"], "one bar breaking both a swing high and a swing low is impossible (guard)", () => {
  // construct impossible break data directly and check the guard fires
  const s1 = mkSeries(H1_LONG, "1h", "EUR/USD", WED), ix = buildStructure(s1);
  ix.swings.push({ i: 3, kind: "L", level: 0, conf: 5, seg: 0, breakIdx: ix.swings[0].breakIdx });
  const s15 = mkSeries(flat(120), "15m", "EUR/USD", s1.grid[7] + s1.step - 120 * 900_000);
  assertThrows(() => direction(s1, ix, s15, buildStructure(s15), s1.grid[7] + s1.step));
});
