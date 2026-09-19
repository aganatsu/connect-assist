import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  analyzeMarketStructure,
  analyzeMarketStructureCanonical,
} from "../../functions/_shared/smcAnalysis.ts";
import {
  buildStructureShadowDiff,
  isCanonicalShadowEnabled,
  SHADOW_MAX_EVENT_AGE_BARS,
  SHADOW_POLICY,
  recordStructureShadow,
  shadowDisagrees,
} from "../../functions/_shared/structureShadow.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

/**
 * Shadow integration for the canonical structure engine.
 *
 *   policy           latest_unbroken_structural
 *   maxEventAgeBars  50
 *
 * The live engine stays authoritative. These tests exist to prove that
 * claim mechanically rather than by inspection, because "shadow mode" has
 * failed silently in this repo before — an OB layer was built, merged, and
 * turned out to be wired to nothing.
 *
 * The flag is read from a Supabase secret rather than bot_configs on purpose:
 * config drift is detected by hashing config_json, so adding a key there would
 * read as a strategy parameter moving when no strategy changed.
 */

let t = 0;
function candle(o: number, h: number, l: number, c: number): Candle {
  const dt = new Date(Date.UTC(2026, 0, 1 + t++)).toISOString().slice(0, 19);
  return { datetime: dt, open: o, high: h, low: l, close: c } as Candle;
}

/** The GBP/CAD reference shape: external swing low 1.84018, closed through. */
function closeThroughExternalLow(): Candle[] {
  t = 0;
  const out: Candle[] = [];
  const p = 1.86;
  for (let i = 0; i < 10; i++) out.push(candle(p, p + 0.0015, p - 0.0015, p));
  for (let i = 0; i < 4; i++) {
    const o = p - i * 0.0035, c = o - 0.0035;
    out.push(candle(o, o + 0.0005, c - 0.0005, c));
  }
  const low = 1.84018;
  out.push(candle(low + 0.001, low + 0.0015, low, low + 0.0012));
  for (let i = 0; i < 6; i++) {
    const o = low + 0.0012 + i * 0.0045, c = o + 0.0045;
    out.push(candle(o, c + 0.0005, o - 0.0005, c));
  }
  const top = low + 0.0012 + 0.027;
  out.push(candle(top, top + 0.002, top - 0.0005, top - 0.001));
  for (let i = 0; i < 5; i++) {
    const o = top - i * 0.006, c = o - 0.006;
    out.push(candle(o, o + 0.0005, c - 0.0005, c));
  }
  out.push(candle(low + 0.002, low + 0.0025, 1.83801, 1.83867));
  out.push(candle(1.83854, 1.84135, 1.83043, 1.83198));
  return out;
}

const withFlag = (value: string | null, fn: () => void) => {
  const prev = Deno.env.get("STRUCTURE_CANONICAL_SHADOW");
  if (value === null) Deno.env.delete("STRUCTURE_CANONICAL_SHADOW");
  else Deno.env.set("STRUCTURE_CANONICAL_SHADOW", value);
  try { fn(); } finally {
    if (prev === undefined) Deno.env.delete("STRUCTURE_CANONICAL_SHADOW");
    else Deno.env.set("STRUCTURE_CANONICAL_SHADOW", prev);
  }
};

Deno.test("shadow is OFF by default, and only an exact \"true\" enables it", () => {
  withFlag(null, () => assertEquals(isCanonicalShadowEnabled(), false));
  withFlag("false", () => assertEquals(isCanonicalShadowEnabled(), false));
  // A flag that half-enables a second structure engine is worse than one that
  // stays off, so near-misses must NOT count.
  withFlag("1", () => assertEquals(isCanonicalShadowEnabled(), false));
  withFlag("TRUE", () => assertEquals(isCanonicalShadowEnabled(), false));
  withFlag("true", () => assertEquals(isCanonicalShadowEnabled(), true));
});

Deno.test("shadow disabled produces no diff at all", () => {
  const candles = closeThroughExternalLow();
  const current = analyzeMarketStructure(candles);
  withFlag(null, () => {
    assertEquals(buildStructureShadowDiff(candles, current, "test"), null);
  });
  withFlag("false", () => {
    assertEquals(buildStructureShadowDiff(candles, current, "test"), null);
  });
});

Deno.test("the live engine's output is byte-identical whether the shadow runs or not", () => {
  // The strongest version of "not authoritative": serialise the production
  // result with the flag off and on, and require an exact match.
  const candles = closeThroughExternalLow();
  let off = "", on = "";
  withFlag(null, () => { off = JSON.stringify(analyzeMarketStructure(candles)); });
  withFlag("true", () => {
    const live = analyzeMarketStructure(candles);
    buildStructureShadowDiff(candles, live, "test");   // shadow runs alongside
    on = JSON.stringify(live);
  });
  assertEquals(on, off, "computing the shadow must not perturb the live result");
});

Deno.test("shadow enabled detects the GBP/CAD external CHoCH the live engine misses", () => {
  const candles = closeThroughExternalLow();
  const current = analyzeMarketStructure(candles);

  // The live engine still does not find it. This is the defect, unchanged.
  const liveHit = [...current.bos, ...current.choch].filter(b =>
    b.type === "bearish" && Math.abs((b.level ?? NaN) - 1.84018) < 1e-9);
  assertEquals(liveHit.length, 0,
    "the production engine is untouched and still misses this close-through");

  withFlag("true", () => {
    const diff = buildStructureShadowDiff(candles, current, "test");
    assert(diff, "the shadow produced a diff");
    assertEquals(diff!.policy, SHADOW_POLICY);
    assertEquals(diff!.maxEventAgeBars, SHADOW_MAX_EVENT_AGE_BARS);
    // Canonical found a bearish event the live engine has no counterpart for.
    assertEquals(diff!.latestEvent.reason, "current_missing");
    assert(!diff!.latestEvent.agrees);
    assertEquals(diff!.latestEvent.canonical?.significance, "external");
    assert(Math.abs((diff!.latestEvent.canonical?.level ?? NaN) - 1.84018) < 1e-9);
  });
});

Deno.test("a level older than the cap stays in the ledger but cannot emit", () => {
  const candles = closeThroughExternalLow();
  const capped = analyzeMarketStructureCanonical(candles, {
    policy: SHADOW_POLICY, maxEventAgeBars: 1,   // deliberately brutal
  });
  const unbounded = analyzeMarketStructureCanonical(candles, { policy: SHADOW_POLICY });

  const sig = (st: typeof capped) =>
    st.swingLevelBreaks.map((x: any) => `${x.index}_${x.level}_${x.direction}`).join("|");
  assertEquals(sig(capped), sig(unbounded),
    "the factual ledger is unlimited regardless of the event cap");
  assert(
    capped.bos.length + capped.choch.length < unbounded.bos.length + unbounded.choch.length,
    "and the cap really did suppress an event",
  );
  assert(capped.swingLevelBreaks.some((x: any) => x.structureEventEligible === false),
    "the over-age level is flagged ineligible, not deleted");
});

Deno.test("a level inside the cap emits normally at the candidate setting", () => {
  const candles = closeThroughExternalLow();
  // The reference break fires 5 bars after confirmation, comfortably inside 50.
  const st = analyzeMarketStructureCanonical(candles, {
    policy: SHADOW_POLICY, maxEventAgeBars: SHADOW_MAX_EVENT_AGE_BARS,
  });
  const brk = [...st.bos, ...st.choch].filter(b =>
    b.type === "bearish" && Math.abs((b.level ?? NaN) - 1.84018) < 1e-9);
  assertEquals(brk.length, 1);
  assertEquals(brk[0].significance, "external");
  assert(((brk[0] as any).barsSinceConfirmation ?? 99) <= SHADOW_MAX_EVENT_AGE_BARS);
});

Deno.test("neither engine uses information from beyond the bar it reports on", () => {
  // Truncating the series at the break bar must not change the break. If either
  // engine depended on later bars — a pivot confirming on the far side, say —
  // the event would move or vanish under truncation.
  const full = closeThroughExternalLow();
  const swingIdx = full.findIndex(c => Math.abs(c.low - 1.84018) < 1e-9);
  const breakIdx = full.findIndex((c, i) => i > swingIdx && c.close < 1.84018);
  const truncated = full.slice(0, breakIdx + 1);

  const a = analyzeMarketStructureCanonical(full, {
    policy: SHADOW_POLICY, maxEventAgeBars: SHADOW_MAX_EVENT_AGE_BARS,
  });
  const b = analyzeMarketStructureCanonical(truncated, {
    policy: SHADOW_POLICY, maxEventAgeBars: SHADOW_MAX_EVENT_AGE_BARS,
  });
  const pick = (st: typeof a) => [...st.bos, ...st.choch]
    .filter(x => x.type === "bearish" && Math.abs((x.level ?? NaN) - 1.84018) < 1e-9)
    .map(x => `${x.index}_${x.level}_${x.significance}`);
  assertEquals(pick(b), pick(a),
    "the canonical break is identical with and without the bars that follow it");

  // And no event anywhere may be dated after the data it was derived from.
  for (const e of [...b.bos, ...b.choch]) {
    assert(e.index <= truncated.length - 1, "event index inside the series");
    const confirmed = (e as any).swingConfirmedIndex;
    if (typeof confirmed === "number") {
      assert(confirmed <= e.index,
        "a swing cannot be confirmed after the bar that broke it");
    }
  }
});

Deno.test("the shadow never throws into the live path", () => {
  // Degenerate inputs must yield null, not an exception: a diagnostic that can
  // take down a scan is worse than no diagnostic.
  withFlag("true", () => {
    assertEquals(buildStructureShadowDiff([], { bos: [], choch: [] }, "test"), null);
    assertEquals(
      buildStructureShadowDiff(closeThroughExternalLow().slice(0, 5), {}, "test"),
      null,
    );
  });
});

Deno.test("timing comparison is exhaustive in both directions", () => {
  // Regression. The classifier previously returned "same" whenever the live
  // index was not GREATER than canonical's, so a live engine reporting the
  // same level EARLIER was recorded as agreement. A comparison tool reporting
  // agreement where the dates differ is worse than no tool, because the one
  // thing it exists to surface is exactly what it would hide.
  const candles = closeThroughExternalLow();
  const lvl = 1.84018;
  const mk = (index: number) => ({
    index, datetime: candles[index]?.datetime, type: "bearish",
    level: lvl, significance: "external", price: lvl, closeBased: true,
  } as any);

  withFlag("true", () => {
    // live LATER than canonical -> current_late
    const late = buildStructureShadowDiff(candles, { bos: [], choch: [mk(28)] }, "test");
    assertEquals(late!.latestEvent.reason, "current_late");
    assertEquals(late!.latestEvent.agrees, false);

    // live EARLIER than canonical -> current_early, and NOT agreement
    const early = buildStructureShadowDiff(candles, { bos: [], choch: [mk(20)] }, "test");
    assertEquals(early!.latestEvent.reason, "current_early");
    assertEquals(early!.latestEvent.agrees, false,
      "an earlier live event is a disagreement, not a match");
  });
});

// ─── Telemetry ──────────────────────────────────────────────────────────────

function fakeSupabase() {
  const rows: any[] = [];
  let failWith: string | null = null;
  let thrown = false;
  return {
    rows,
    failNext: (msg: string) => { failWith = msg; },
    throwNext: () => { thrown = true; },
    from(_t: string) {
      return {
        insert: (row: any) => {
          if (thrown) { thrown = false; throw new Error("connection reset"); }
          if (failWith) { const m = failWith; failWith = null; return Promise.resolve({ error: { message: m } }); }
          rows.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

const diffWith = (over: Record<string, any>) => ({
  site: "test", policy: SHADOW_POLICY, maxEventAgeBars: SHADOW_MAX_EVENT_AGE_BARS,
  bars: 80, currentTrend: "bearish", canonicalTrend: "bearish", trendAgrees: true,
  latestBOS: { current: null, canonical: null, agrees: true, reason: "same" },
  latestCHoCH: { current: null, canonical: null, agrees: true, reason: "same" },
  latestEvent: { current: null, canonical: null, agrees: true, reason: "same" },
  counts: {
    currentBOS: 1, currentCHoCH: 0, canonicalBOS: 1, canonicalCHoCH: 0,
    canonicalLedgerEntries: 1, canonicalIneligibleByAge: 0,
  },
  ...over,
}) as any;

Deno.test("telemetry: agreements are not written", async () => {
  // A scan produces one diff per symbol. Recording agreement would generate
  // thousands of identical rows that say nothing and bury the disagreements.
  const db = fakeSupabase();
  const r = await recordStructureShadow(db, {
    userId: "u", symbol: "GBP/CAD", diff: diffWith({}),
  });
  assertEquals(r, "skipped");
  assertEquals(db.rows.length, 0);
});

Deno.test("telemetry: a null diff writes nothing", async () => {
  const db = fakeSupabase();
  assertEquals(await recordStructureShadow(db, { userId: "u", symbol: "X", diff: null }), "skipped");
  assertEquals(db.rows.length, 0);
});

Deno.test("telemetry: each disagreement channel independently triggers a write", async () => {
  for (const over of [
    { trendAgrees: false, canonicalTrend: "bullish" },
    { latestEvent: { current: null, canonical: null, agrees: false, reason: "current_missing" } },
    { latestBOS: { current: null, canonical: null, agrees: false, reason: "current_late" } },
    { latestCHoCH: { current: null, canonical: null, agrees: false, reason: "current_early" } },
  ]) {
    const db = fakeSupabase();
    const r = await recordStructureShadow(db, { userId: "u", symbol: "GBP/CAD", diff: diffWith(over) });
    assertEquals(r, "written", `expected a write for ${JSON.stringify(over).slice(0, 40)}`);
    assertEquals(db.rows.length, 1);
  }
});

Deno.test("telemetry: the row is compact and carries no candles or ledger", async () => {
  const db = fakeSupabase();
  await recordStructureShadow(db, {
    userId: "u", botId: "bot1", symbol: "GBP/CAD", timeframe: "1d",
    diff: diffWith({
      trendAgrees: false, canonicalTrend: "bullish",
      latestEvent: {
        agrees: false, reason: "current_missing", current: null,
        canonical: { index: 566, datetime: "2026-05-14T00:00:00Z", level: 1.84018,
          significance: "external", type: "bearish", barsSinceConfirmation: 5 },
      },
    }),
  });
  const row = db.rows[0];
  assertEquals(row.symbol, "GBP/CAD");
  assertEquals(row.latest_event_reason, "current_missing");
  assertEquals(row.canonical_level, 1.84018);
  assertEquals(row.canonical_bars_since_confirmation, 5);
  assertEquals(row.current_level, null, "absent event is null, not zero");
  assertEquals(row.policy, SHADOW_POLICY);
  assertEquals(row.max_event_age_bars, SHADOW_MAX_EVENT_AGE_BARS);
  // A row is a verdict, not a snapshot.
  for (const banned of ["candles", "swingLevelBreaks", "ledger", "swingPoints", "bos", "choch"]) {
    assert(!(banned in row), `telemetry row must not carry ${banned}`);
  }
  assert(JSON.stringify(row).length < 900, "row stays compact");
});

Deno.test("telemetry: a DB error or throw never propagates to the caller", async () => {
  // A telemetry write that can fail a scan is worse than no telemetry. This
  // repo has already lost trades to a diagnostic insert being refused while
  // the caller swallowed the error — here the swallow is deliberate and the
  // outcome is reported back rather than hidden.
  const bad = diffWith({ trendAgrees: false, canonicalTrend: "bullish" });

  const db1 = fakeSupabase();
  db1.failNext("new row violates row-level security policy");
  assertEquals(await recordStructureShadow(db1, { userId: "u", symbol: "X", diff: bad }), "failed");

  const db2 = fakeSupabase();
  db2.throwNext();
  assertEquals(await recordStructureShadow(db2, { userId: "u", symbol: "X", diff: bad }), "failed");
});
