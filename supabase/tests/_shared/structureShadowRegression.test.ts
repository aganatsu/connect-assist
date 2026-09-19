import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  analyzeMarketStructure,
  analyzeMarketStructureCanonical,
} from "../../functions/_shared/smcAnalysis.ts";
import {
  buildStructureShadowDiff,
  SHADOW_MAX_EVENT_AGE_BARS,
  SHADOW_POLICY,
} from "../../functions/_shared/structureShadow.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

/**
 * Two real production disagreements, frozen as regression fixtures.
 *
 * On 2026-09-19 the shadow engine recorded its first live disagreements against
 * the production structure engine, on BTC/USD and ETH/USD 5m during weekend
 * crypto mode. The exact 50-bar input windows were reconstructed afterwards and
 * VERIFIED by reproducing the stored telemetry values — not assumed. Those
 * windows are the fixtures here.
 *
 * Both cases share one window: 2026-09-19T00:20:00 -> 04:25:00, the last 50 of
 * a 198-bar 5m series, matching confluenceScoring's sc.slice(-structureLookback)
 * with the default lookback of 50.
 *
 * WHY EACH CASE MATTERS
 *
 *   ETH/USD  Both engines break on the SAME bar (03:00) and pick DIFFERENT
 *            levels. Live takes 2623.47 (internal) because it builds events
 *            pairwise between consecutive same-type swings, so the only high it
 *            can pair with swing 32 is its immediate predecessor. Canonical
 *            takes 2627.00 (external) because it retained that older, higher
 *            swing — a lower high does not engulf it — and its selection
 *            prefers external before falling back to most-extreme.
 *
 *   BTC/USD  Both levels were already crossed by the 03:15 close. Canonical
 *            fires there; live cannot, because the 81280 low has no SUBSEQUENT
 *            swing low to pair with until bar 39, so its event is dated 03:35 —
 *            four bars (20 minutes) late on the same move. Neither level is
 *            external, so external-preference plays no part: this is purely
 *            first-close-through versus pairwise construction.
 *
 * These are pinned as CORRECT CURRENT BEHAVIOUR of two engines that legitimately
 * differ, not as a defect. If either side changes, that is a real behavioural
 * change and should be a deliberate one.
 */

const FIXTURES = "supabase/tests/fixtures/structure";

interface FixtureCase {
  name: string;
  file: string;
  /** Guards the input. If this changes, every assertion below is meaningless. */
  sha256: string;
  live: { level: number; time: string; significance: string; type: string };
  canonical: { level: number; time: string; significance: string; type: string };
  /** Exactly as persisted to structure_shadow_telemetry on 2026-09-19. */
  telemetry: {
    latestEventReason: string;
    latestBosReason: string;
    latestChochReason: string;
    currentLevel: number;
    currentDatetime: string;
    canonicalLevel: number;
    canonicalDatetime: string;
    canonicalBarsSinceConfirmation: number;
    currentBosCount: number;
    canonicalBosCount: number;
    canonicalLedgerEntries: number;
    canonicalIneligibleByAge: number;
  };
}

const CASES: FixtureCase[] = [
  {
    name: "BTC/USD",
    file: `${FIXTURES}/btcusd-5m-20260919-0020-0425.json`,
    sha256: "1443b55a8e16816d174e490bda6b82bf4e20c440553c59e3a6f94df7adfbfd9e",
    live: { level: 81280, time: "2026-09-19T03:35:00", significance: "internal", type: "bearish" },
    canonical: { level: 81264, time: "2026-09-19T03:15:00", significance: "internal", type: "bearish" },
    telemetry: {
      latestEventReason: "different_primary_level",
      latestBosReason: "different_primary_level",
      latestChochReason: "same",
      currentLevel: 81280,
      currentDatetime: "2026-09-19T03:35:00",
      canonicalLevel: 81264,
      canonicalDatetime: "2026-09-19T03:15:00",
      canonicalBarsSinceConfirmation: 11,
      currentBosCount: 1,
      canonicalBosCount: 1,
      canonicalLedgerEntries: 2,
      canonicalIneligibleByAge: 0,
    },
  },
  {
    name: "ETH/USD",
    file: `${FIXTURES}/ethusd-5m-20260919-0020-0425.json`,
    sha256: "36815cf75060ce70bf91d8f5c37f86287cd035df6be026d839c634c238d41d0c",
    live: { level: 2623.47, time: "2026-09-19T03:00:00", significance: "internal", type: "bullish" },
    canonical: { level: 2627.00, time: "2026-09-19T03:00:00", significance: "external", type: "bullish" },
    telemetry: {
      latestEventReason: "different_primary_level",
      latestBosReason: "different_primary_level",
      latestChochReason: "same",
      currentLevel: 2623.47,
      currentDatetime: "2026-09-19T03:00:00",
      canonicalLevel: 2627.00,
      canonicalDatetime: "2026-09-19T03:00:00",
      canonicalBarsSinceConfirmation: 21,
      currentBosCount: 2,
      canonicalBosCount: 2,
      canonicalLedgerEntries: 3,
      canonicalIneligibleByAge: 0,
    },
  },
];

const load = (f: string): Candle[] => JSON.parse(Deno.readTextFileSync(f));

async function sha256Of(candles: Candle[]): Promise<string> {
  // Canonical serialisation, independent of JSON key order or whitespace, so
  // reformatting the fixture file cannot silently change the hash.
  const text = candles
    .map((c) => `${c.datetime}|${c.open}|${c.high}|${c.low}|${c.close}`)
    .join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const latest = <T extends { index: number }>(xs: T[]) =>
  xs.length ? xs.reduce((a, b) => (b.index >= a.index ? b : a)) : null;

for (const c of CASES) {
  Deno.test(`[${c.name}] fixture is byte-stable (sha256 guard)`, async () => {
    const w = load(c.file);
    assertEquals(w.length, 50, "structure window is the last 50 bars");
    assertEquals(w[0].datetime, "2026-09-19T00:20:00");
    assertEquals(w[49].datetime, "2026-09-19T04:25:00");
    assertEquals(
      await sha256Of(w),
      c.sha256,
      "the input window changed — every assertion in this file is void until this is understood",
    );
  });

  Deno.test(`[${c.name}] live engine picks its documented primary level`, () => {
    const st = analyzeMarketStructure(load(c.file));
    const e = latest([...st.bos, ...st.choch]);
    assert(e, "live engine produced an event");
    assertEquals(e!.level, c.live.level);
    assertEquals(e!.datetime, c.live.time);
    assertEquals(e!.significance, c.live.significance);
    assertEquals(e!.type, c.live.type);
  });

  Deno.test(`[${c.name}] canonical engine picks its documented primary level`, () => {
    const st = analyzeMarketStructureCanonical(load(c.file), {
      policy: SHADOW_POLICY,
      maxEventAgeBars: SHADOW_MAX_EVENT_AGE_BARS,
    });
    const e = latest([...st.bos, ...st.choch]);
    assert(e, "canonical engine produced an event");
    assertEquals(e!.level, c.canonical.level);
    assertEquals(e!.datetime, c.canonical.time);
    assertEquals(e!.significance, c.canonical.significance);
    assertEquals(e!.type, c.canonical.type);
  });

  Deno.test(`[${c.name}] the window reproduces the STORED telemetry exactly`, () => {
    // This is what makes the reconstruction trustworthy: the fixture was chosen
    // by sweeping candidate end-bars until the engines reproduced the values
    // already persisted in structure_shadow_telemetry. Asserting it here keeps
    // that link intact rather than leaving it in a one-off script.
    const w = load(c.file);
    const live = analyzeMarketStructure(w);
    const diff = (() => {
      const prev = Deno.env.get("STRUCTURE_CANONICAL_SHADOW");
      Deno.env.set("STRUCTURE_CANONICAL_SHADOW", "true");
      try {
        return buildStructureShadowDiff(w, live, "regression");
      } finally {
        if (prev === undefined) Deno.env.delete("STRUCTURE_CANONICAL_SHADOW");
        else Deno.env.set("STRUCTURE_CANONICAL_SHADOW", prev);
      }
    })();
    assert(diff, "shadow diff produced");
    const t = c.telemetry;

    assertEquals(diff!.latestEvent.reason, t.latestEventReason);
    assertEquals(diff!.latestBOS.reason, t.latestBosReason);
    assertEquals(diff!.latestCHoCH.reason, t.latestChochReason);

    assertEquals(diff!.latestEvent.current?.level, t.currentLevel);
    assertEquals(diff!.latestEvent.current?.datetime, t.currentDatetime);
    assertEquals(diff!.latestEvent.canonical?.level, t.canonicalLevel);
    assertEquals(diff!.latestEvent.canonical?.datetime, t.canonicalDatetime);
    assertEquals(
      diff!.latestEvent.canonical?.barsSinceConfirmation,
      t.canonicalBarsSinceConfirmation,
    );

    assertEquals(diff!.counts.currentBOS, t.currentBosCount);
    assertEquals(diff!.counts.canonicalBOS, t.canonicalBosCount);
    assertEquals(diff!.counts.canonicalLedgerEntries, t.canonicalLedgerEntries);
    assertEquals(diff!.counts.canonicalIneligibleByAge, t.canonicalIneligibleByAge);
  });
}

Deno.test("[ETH/USD] canonical prefers the EXTERNAL level over the internal one on the same bar", () => {
  // The distinguishing mechanic. All three crossed levels were active and
  // unbroken at bar 32; canonical takes the only external one and keeps the
  // rest as metadata.
  const st = analyzeMarketStructureCanonical(load(CASES[1].file), {
    policy: SHADOW_POLICY,
    maxEventAgeBars: SHADOW_MAX_EVENT_AGE_BARS,
  });
  const e = latest([...st.bos, ...st.choch])!;
  assertEquals(e.significance, "external");
  assertEquals(e.level, 2627.00);

  const also = (e as unknown as { alsoBrokenLevels: Array<{ level: number; significance: string }> })
    .alsoBrokenLevels;
  assert(
    also.some((x) => x.level === 2623.47 && x.significance === "internal"),
    "the internal level live chose is retained as alsoBrokenLevels, not discarded",
  );

  // Honest limitation: the most-extreme tiebreak would also have chosen 2627.00
  // here, so this fixture demonstrates external-preference but cannot prove it
  // is the only rule responsible.
  const crossedHighs = [2627.00, 2623.47, 2620.00];
  assertEquals(Math.max(...crossedHighs), 2627.00);
});

Deno.test("[BTC/USD] canonical fires 4 bars earlier on the same move", () => {
  const w = load(CASES[0].file);
  const live = latest([...analyzeMarketStructure(w).bos, ...analyzeMarketStructure(w).choch])!;
  const canSt = analyzeMarketStructureCanonical(w, {
    policy: SHADOW_POLICY,
    maxEventAgeBars: SHADOW_MAX_EVENT_AGE_BARS,
  });
  const can = latest([...canSt.bos, ...canSt.choch])!;
  assertEquals(live.index - can.index, 4, "live reports the break four 5m bars later");
  assertEquals(live.type, can.type, "same direction — this is timing, not disagreement on direction");
});
