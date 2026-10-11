// Replay review chart: every required element is drawn (1H structure/bias, leg, POI, touch/arm, protected swing, CHoCH,
// entry, SL, target, opposing-POI constraint, terminal reason/outcome).
import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clause } from "./helpers/clause.ts";
import { baseScenario, build, ny, type OHLC } from "./helpers/scenario.ts";
import { runReplay } from "../../functions/_shared/v2/engine.ts";
import { renderSetup, setupsOf } from "../../../scripts/v2/chart.ts";
import { nyLocalToUtc } from "../../functions/_shared/v2/calendar.ts";

function html(mod: (s: ReturnType<typeof baseScenario>) => void = () => {}) {
  const s = baseScenario(); mod(s);
  const res = runReplay(build(s));
  const st = setupsOf(res).find((x) => x.pair === "EUR/USD")!;
  return renderSetup(res, "EUR/USD", st.id, st.confirmT);
}

clause(["12.1"], "chart for a winning LONG: structure, bias, leg, POI, arm, protected swing, CHoCH, entry/SL/TP, target, outcome", () => {
  const h = html();
  for (const s of ["BOS↑", "bias at arm: LONG (OK)", "leg o→b (LONG)", "FVG (this setup)", "touch/arm", "protected swing", "CHoCH",
    "entry 1.16045", "SL 1.15960", "TP 1.16200", "TARGET", "SWING VALID", "SWING SWEPT", "PREV_DAY VALID", "terminal: ENTERED", "EXIT_TP at 1.16200"]) {
    assertStringIncludes(h, s);
  }
  assert((h.match(/<svg/g) ?? []).length === 1 && h.includes("</svg>"));
});

clause(["12.1", "AM1"], "chart shows the opposing POI and the terminal reason for a skipped entry", () => {
  const h = html((s) => {
    const pre: OHLC[] = [];
    for (let i = 0; i < 38; i++) pre.push([5, 7, 3, 6]);
    pre.push([5, 6, -2, 0], [0, 4, -1, 3], [3, 8, 2, 7], [7, 25, 4.2, 24], [24, 24.5, 5, 6], [6, 8, 1, 2], [2, 3, -20, -19], [-19, -18, -20, -19], [-19, -18, -20, -19]);
    s.start = nyLocalToUtc(2026, 9, 9, 17, 0); s.h1 = [...pre, ...s.h1]; s.m5.delete(ny(14, 16, 30));
  });
  assertStringIncludes(h, "OB opposing");
  assertStringIncludes(h, "terminal: OPPOSING_POI_CONTAINS_ENTRY");
});
