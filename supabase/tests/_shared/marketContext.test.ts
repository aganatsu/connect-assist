/**
 * Market-context features — DST correctness and causality.
 *
 * IPO_MARKET_CONTEXT_TELEMETRY_V1 attaches session, fix, rollover, volatility
 * and price-location context to frozen IPO trades. The context is only
 * meaningful if it was knowable at the 1m fill minute, and only correct if
 * DST is handled by the real calendar. Both are pinned here.
 */

import { assertEquals, assert, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  zonedToUtc, offsetMin, session, sessionTiming, fixContext, rolloverContext, tradingDayStart,
  atrSeries, realizedVolSeries, trailingPercentile, volRegime, contextFeatures, LONDON, NEW_YORK,
  type Bar,
} from "../../../local-runner/marketContext.ts";

const T = (s: string) => Date.parse(s);

// ─── DST: the IANA calendar, not a hand-written table ───────────────────────

Deno.test("London and New York offsets follow their own DST dates", () => {
  assertEquals(offsetMin(T("2025-03-29T12:00:00Z"), LONDON), 0);     // GMT
  assertEquals(offsetMin(T("2025-03-31T12:00:00Z"), LONDON), 60);    // BST from 30 Mar
  assertEquals(offsetMin(T("2025-03-08T12:00:00Z"), NEW_YORK), -300);  // EST
  assertEquals(offsetMin(T("2025-03-10T12:00:00Z"), NEW_YORK), -240);  // EDT from 9 Mar
  assertEquals(new Date(zonedToUtc(2025, 3, 31, 8, 0, LONDON)).toISOString(), "2025-03-31T07:00:00.000Z");
  assertEquals(new Date(zonedToUtc(2025, 3, 28, 8, 0, LONDON)).toISOString(), "2025-03-28T08:00:00.000Z");
});

Deno.test("sessions shift correctly through the US/UK DST mismatch weeks", () => {
  // 12 Mar 2025: US already on EDT, UK still on GMT. NY 08:00 = 12:00 UTC,
  // London 08:00-17:00 = 08:00-17:00 UTC, so 12:30 UTC is the OVERLAP.
  assertEquals(session(T("2025-03-12T12:30:00Z")), "LONDON_NY_OVERLAP");
  // 5 Mar 2025: both standard. NY opens 13:00 UTC, so 12:30 UTC is London only.
  assertEquals(session(T("2025-03-05T12:30:00Z")), "LONDON");
  // Summer 2025, both on DST: London 07:00-16:00 UTC, NY 12:00-21:00 UTC.
  assertEquals(session(T("2025-07-01T07:30:00Z")), "LONDON");
  assertEquals(session(T("2025-07-01T13:00:00Z")), "LONDON_NY_OVERLAP");
  assertEquals(session(T("2025-07-01T17:00:00Z")), "NEW_YORK");
  assertEquals(session(T("2025-07-01T20:30:00Z")), "LATE_NY_ROLLOVER");   // NY 16:30
  assertEquals(session(T("2025-07-01T23:30:00Z")), "ASIA");               // NY 19:30
  assertEquals(session(T("2025-07-01T02:00:00Z")), "ASIA");
});

Deno.test("session timing anchors on each centre's own local clock", () => {
  const s = sessionTiming(T("2025-07-01T09:00:00Z"));          // London 10:00 BST
  assertEquals(s.minutes_from_london_open, 120);
  assertEquals(s.minutes_from_new_york_open, 9 * 60 - 12 * 60); // NY 05:00 EDT -> -180
  assertEquals(sessionTiming(T("2025-01-15T09:00:00Z")).minutes_from_london_open, 60);
});

Deno.test("the London fix is 16:00 Europe/London, with a five-minute window", () => {
  assertEquals(fixContext(T("2025-07-01T15:00:00Z")).fix_bucket, "fix window");   // 16:00 BST
  assertEquals(fixContext(T("2025-01-15T16:00:00Z")).fix_bucket, "fix window");   // 16:00 GMT
  assertEquals(fixContext(T("2025-01-15T16:02:00Z")).in_fix_window, true);
  assertEquals(fixContext(T("2025-01-15T16:03:00Z")).fix_bucket, "0-30 after");
  assertEquals(fixContext(T("2025-01-15T15:20:00Z")).fix_bucket, "30-60 before");
  assertEquals(fixContext(T("2025-01-15T15:20:00Z")).minutes_to_london_fix, 40);
  assertEquals(fixContext(T("2025-01-15T09:00:00Z")).fix_bucket, ">120 before");
  assertEquals(fixContext(T("2025-01-15T19:00:00Z")).fix_bucket, ">120 after");
});

Deno.test("the rollover is 17:00 America/New_York, through DST", () => {
  const s = rolloverContext(T("2025-07-01T20:50:00Z"));   // 16:50 EDT
  assertEquals(s.minutes_to_ny_rollover, 10);
  assertEquals(s.rollover_pre_15, true);
  const w = rolloverContext(T("2025-01-15T22:10:00Z"));   // 17:10 EST
  assertEquals(w.minutes_since_ny_rollover, 10);
  assertEquals(w.rollover_post_15, true);
  assertEquals(rolloverContext(T("2025-01-15T12:00:00Z")).rollover_outside_60, true);
});

Deno.test("the FX trading day starts at the New York rollover; BTC uses UTC days", () => {
  assertEquals(new Date(tradingDayStart(T("2025-07-01T20:00:00Z"), true)).toISOString(), "2025-06-30T21:00:00.000Z");
  assertEquals(new Date(tradingDayStart(T("2025-07-01T21:30:00Z"), true)).toISOString(), "2025-07-01T21:00:00.000Z");
  assertEquals(new Date(tradingDayStart(T("2025-01-15T21:30:00Z"), true)).toISOString(), "2025-01-14T22:00:00.000Z");
  assertEquals(new Date(tradingDayStart(T("2025-07-01T20:00:00Z"), false)).toISOString(), "2025-07-01T00:00:00.000Z");
});

// ─── causality ──────────────────────────────────────────────────────────────

/** Hourly bars from `start`, a gentle oscillating walk. */
function hourly(start: string, n: number): Bar[] {
  const out: Bar[] = []; let px = 1.1;
  for (let i = 0; i < n; i++) {
    const o = px, c = px + Math.sin(i / 3) * 0.0008;
    out.push({ datetime: new Date(T(start) + i * 3_600_000).toISOString(), open: o, close: c,
      high: Math.max(o, c) + 0.0004, low: Math.min(o, c) - 0.0004 });
    px = c;
  }
  return out;
}

const D = T("2025-07-01T13:25:00Z");                   // inside the 13:00 bar
const BASE = hourly("2025-06-26T00:00:00Z", 140);       // covers well past D
const own = BASE.filter((b) => T(b.datetime) + 3_600_000 <= T("2025-07-01T13:00:00Z"));
const feat = (h: Bar[], o = own) => contextFeatures({ decisionMs: D, entryPrice: 1.1, fx: true, ownPrefix: o, hourly: h });

Deno.test("changing any FUTURE bar does not alter any feature", () => {
  const f0 = feat(BASE);
  const wrecked = BASE.map((b) => T(b.datetime) > D ? { ...b, open: 9, high: 99, low: -99, close: 9 } : b);
  assertEquals(feat(wrecked), f0);
});

Deno.test("the bar still FORMING at the decision minute contributes nothing but its open", () => {
  const f0 = feat(BASE);
  // The 13:00 bar contains D. Its high/low/close are not yet known.
  const forming = BASE.map((b) => b.datetime === "2025-07-01T13:00:00.000Z"
    ? { ...b, high: b.high + 1, low: b.low - 1, close: b.close + 0.5 } : b);
  const f1 = feat(forming);
  assertEquals(f1.session_high_so_far, f0.session_high_so_far);
  assertEquals(f1.session_low_so_far, f0.session_low_so_far);
  assertEquals(f1.prev_day_high, f0.prev_day_high);
});

Deno.test("previous-day values come only from the completed previous trading day", () => {
  const f0 = feat(BASE);
  // Mutate every CLOSED bar of the CURRENT trading day (from 2025-06-30 21:00Z).
  const curDay = BASE.map((b) => T(b.datetime) >= T("2025-06-30T21:00:00Z") && T(b.datetime) + 3_600_000 <= D
    ? { ...b, high: b.high + 0.05, low: b.low - 0.05 } : b);
  const f1 = feat(curDay);
  assertEquals(f1.prev_day_high, f0.prev_day_high);
  assertEquals(f1.prev_day_low, f0.prev_day_low);
  assertEquals(f1.prev_day_close, f0.prev_day_close);
  // …while current-session values DO move, proving the mutation landed.
  assertNotEquals(f1.session_high_so_far, f0.session_high_so_far);
});

Deno.test("volatility series and percentiles are trailing-only (prefix invariance)", () => {
  const bars = hourly("2025-01-01T00:00:00Z", 400);
  const atr = atrSeries(bars), rv = realizedVolSeries(bars);
  for (const i of [50, 150, 260, 399]) {
    const p = bars.slice(0, i + 1);
    assertEquals(atrSeries(p)[i], atr[i]);
    assertEquals(realizedVolSeries(p)[i], rv[i]);
    assertEquals(trailingPercentile(atrSeries(p), i, 100), trailingPercentile(atr, i, 100));
  }
  assertEquals(trailingPercentile(atr, 50, 100), null, "no full-sample fallback when history is short");
  assertEquals(volRegime(0.25), "LOW");
  assertEquals(volRegime(0.75), "HIGH");
  assertEquals(volRegime(0.5), "NORMAL");
});

Deno.test("own-timeframe features read only the closed prefix handed in", () => {
  const f0 = feat(BASE);
  const longer = [...own, { datetime: "2025-07-01T13:00:00.000Z", open: 1, high: 50, low: -50, close: 1 }];
  // Feeding a longer prefix (one that includes the forming bar) WOULD change
  // the result — so the study must hand in exactly the closed prefix.
  assertNotEquals(feat(BASE, longer).last_bar_range_atr, f0.last_bar_range_atr);
});

Deno.test("fix, rollover and session context depend only on the timestamp", () => {
  const a = feat(BASE), b = contextFeatures({ decisionMs: D, entryPrice: 99, fx: true, ownPrefix: own.slice(0, 50), hourly: BASE.slice(0, 60) });
  for (const k of ["session", "fix_bucket", "minutes_to_london_fix", "minutes_to_ny_rollover",
    "minutes_from_london_open", "utc_window", "utc_hour"] as const) {
    assertEquals(b[k], a[k], `${k} must not depend on prices`);
  }
});

// ─── study wiring ───────────────────────────────────────────────────────────

Deno.test("the study feeds the closed prefix and the fill minute, and filters nothing", () => {
  const src = Deno.readTextFileSync(new URL("../../../local-runner/ipo-market-context-telemetry.ts", import.meta.url));
  assert(/ownPrefix: bars\.slice\(0, entryIdx\)/.test(src), "own-TF bars strictly before the touch bar");
  assert(/decisionMs: Date\.parse\(r\.m1_entry_time\)/.test(src), "the decision instant is the 1m fill minute");
  assert(/if \(!GATE_PASS\) Deno\.exit\(2\);/.test(src), "the study must stop if the control does not reproduce");
  assert(/NEWS_CONTEXT_UNAVAILABLE/.test(src), "news must be declared unavailable, not fabricated");
});

Deno.test("no production code imports the market-context module", async () => {
  for await (const e of Deno.readDir(new URL("../../functions/", import.meta.url))) {
    if (!e.isDirectory) continue;
    try {
      const src = Deno.readTextFileSync(new URL(`../../functions/${e.name}/index.ts`, import.meta.url));
      assert(!/marketContext/.test(src), `${e.name} must not import market context`);
    } catch { /* no index.ts */ }
  }
});
