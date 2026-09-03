import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The Tier 2 Liquidity Sweep factor scored any swept pool with >=2 touches
 * anywhere in the array, ranked by candle index. It checked neither how far the
 * pool was from current price nor whether the swept side had anything to do with
 * the trade's direction.
 *
 * Observed live 2026-09-03 on a XAU/USD long entered at 4473:
 *
 *   "+1.0 — buy-side liquidity swept + rejected at 4392.99756 (2 touches) — older sweep"
 *
 * That pool is $80 below price, 1.8% of the instrument, and it is buy-side:
 * buy stops taken with price rejecting DOWN. A bearish event, $80 away, scored
 * as confluence for a long.
 *
 * zoneLiquidity.ts already models this properly — it filters on distance to
 * zone, filters on sweep age, requires quality >= 4, labels BSL vs SSL, and
 * classifies each pool as "entry_trigger" / "target" / "neutral" by direction.
 * It is imported only by unifiedZoneEngine and confirmationHierarchy, so the
 * zone story panel gets the good model and the scorer gets the crude one. This
 * change brings the scorer into line on the two checks that decide relevance.
 *
 * Direction convention (ICT):
 *   LONG  <- sell-side swept below (stops run down, then reversal up)
 *   SHORT <- buy-side swept above  (stops run up, then reversal down)
 */

const src = await Deno.readTextFile(
  new URL("../../functions/_shared/confluenceScoring.ts", import.meta.url),
);

/** The Factor 9 block, from its header to the factors.push that closes it. */
function sweepBlock(): string {
  const start = src.indexOf("// ── Factor 9: Liquidity Sweep");
  assert(start > -1, "Factor 9 block not found");
  const end = src.indexOf('name: "Liquidity Sweep"', start);
  assert(end > start, "Factor 9 block is unterminated");
  return src.slice(start, end);
}

Deno.test("a sweep too far from price is excluded", () => {
  const b = sweepBlock();
  assert(
    /Math\.abs\(lp\.price - lastPrice\) > maxSweepDistance/.test(b),
    "the sweep filter must reject pools beyond the distance threshold — a pool " +
      "$80 from price is not evidence for this entry",
  );
  assert(
    /maxSweepDistance\s*=\s*atrLiq \* maxSweepATR/.test(b),
    "the threshold must scale with ATR, not be a fixed price distance",
  );
});

Deno.test("the distance threshold is configurable with a sane default", () => {
  const b = sweepBlock();
  assert(
    /config\.liquiditySweepMaxATR/.test(b),
    "liquiditySweepMaxATR must be honoured so the threshold can be tuned",
  );
  const m = b.match(/:\s*([\d.]+);/);
  assert(m, "no default found for liquiditySweepMaxATR");
  const def = parseFloat(m[1]);
  assert(def > 0 && def <= 5, `default ${def}×ATR is outside a sensible range`);
});

Deno.test("a sweep on the wrong side for the direction is excluded", () => {
  const b = sweepBlock();
  assert(
    /direction === "long" && lp\.type !== "sell-side"/.test(b),
    'a long is supported by SELL-side liquidity being swept below, not buy-side',
  );
  assert(
    /direction === "short" && lp\.type !== "buy-side"/.test(b),
    'a short is supported by BUY-side liquidity being swept above, not sell-side',
  );
});

Deno.test("filtering happens before ranking, not after", () => {
  // Sorting first and filtering later would still let an irrelevant pool win
  // the sort and suppress a relevant one.
  const b = sweepBlock();
  const filterAt = b.indexOf("maxSweepDistance");
  const sortAt = b.indexOf("sweptPools.sort");
  assert(filterAt > -1 && sortAt > -1, "filter or sort missing");
  assert(filterAt < sortAt, "pools must be filtered before being ranked");
});

Deno.test("exclusions are reported rather than silently dropped", () => {
  const b = sweepBlock();
  assert(
    /rejectedFar/.test(b) && /rejectedSide/.test(b),
    "excluded pools must be counted so the reason is visible in the detail text",
  );
  assert(
    /too far|wrong side/.test(b),
    "the detail string should say why pools were excluded — a bare " +
      '"no sweep" hides that candidates existed and were rejected',
  );
});

Deno.test("the surviving sweep reports its distance", () => {
  // The old text gave a bare price, so nothing on screen revealed that the pool
  // was $80 away. Distance in ATR makes it comparable across instruments.
  const b = sweepBlock();
  const hits = b.match(/×ATR away/g) ?? [];
  assert(
    hits.length >= 2,
    `both the rejected-sweep and no-rejection messages should state distance, found ${hits.length}`,
  );
});

Deno.test("direction filtering is skipped when direction is unknown", () => {
  // With no direction there is no wrong side; filtering on it would drop
  // everything and silently zero the factor.
  const b = sweepBlock();
  assert(
    !/lp\.type !== "sell-side"\s*\)\s*\{[^}]*\}\s*return/.test(b.replace(/direction === "long" && /, "")),
    "side checks must be guarded by an explicit direction comparison",
  );
  assert(
    (b.match(/direction === "(long|short)"/g) ?? []).length === 2,
    "both side checks must test direction explicitly so a null direction skips them",
  );
});
