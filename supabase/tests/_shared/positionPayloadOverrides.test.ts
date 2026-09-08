import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveExitSettings } from "../../../src/lib/exitSettings.ts";

/**
 * #493 taught the UI to resolve exit settings from trade_overrides. It still
 * showed "—", because the API never sent them.
 *
 * The /status position payload listed id, symbol, direction, size, entryPrice,
 * currentPrice, pnl, stopLoss, takeProfit, openTime, signalReason, signalScore,
 * orderId, botId, mirroredConnectionIds, mirrorStatus — and no overrides. So
 * the only source the UI could reach was the entry-time snapshot inside
 * signalReason, which is exactly the stale value the resolver exists to look
 * past.
 *
 * Observed with NZD/USD: trade_overrides
 * {"breakEvenEnabled":true,"breakEvenPips":8} in the database, stop already
 * moved to 0.58805 (entry 0.58835 minus the 3-pip offset), BE column reading
 * disabled.
 *
 * A resolver with nothing to resolve from is just a slower way of reading the
 * snapshot.
 */

const paper = await Deno.readTextFile(
  new URL("../../functions/paper-trading/index.ts", import.meta.url),
);

Deno.test("the position payload carries the overrides", () => {
  assert(
    /tradeOverrides: p\.trade_overrides \?\? null,/.test(paper),
    "the /status payload must include the per-trade overrides",
  );
});

Deno.test("null rather than undefined, so the field is always present", () => {
  // `undefined` is dropped by JSON.stringify, which would make "no overrides"
  // and "field missing" indistinguishable on the client — the state this bug
  // was hiding in.
  assert(/\?\? null/.test(paper.slice(paper.indexOf("tradeOverrides:") - 40, paper.indexOf("tradeOverrides:") + 60)));
  assertEquals(JSON.parse(JSON.stringify({ tradeOverrides: null })).tradeOverrides, null);
  assertEquals("tradeOverrides" in JSON.parse(JSON.stringify({ tradeOverrides: undefined })), false);
});

Deno.test("end to end: the payload the API now sends resolves correctly", () => {
  // The exact NZD/USD row, as the client will now receive it.
  const positionFromApi = {
    id: "c7d7983b",
    symbol: "NZD/USD",
    stopLoss: 0.58805,
    signalReason: JSON.stringify({
      originalSL: 0.59085,
      exitFlags: { breakEvenEnabled: false, breakEvenPips: 8, breakEvenActivated: true },
    }),
    tradeOverrides: '{"maxHoldEnabled":false,"breakEvenEnabled":true,"breakEvenPips":8}',
  };
  const ef = JSON.parse(positionFromApi.signalReason).exitFlags;
  const r = resolveExitSettings(positionFromApi, ef, {});
  assertEquals(r.breakEvenEnabled, true, "the column must now read enabled");
  assertEquals(r.breakEvenActivated, true, "and show it has fired");
  assertEquals(r.breakEvenSource, "override");
  assertEquals(r.maxHoldEnabled, false, "hold off, as overridden");
});

Deno.test("without the field it falls back to the snapshot — the old behaviour", () => {
  // Demonstrates the bug rather than asserting about source text: same row,
  // payload missing tradeOverrides, resolves to disabled.
  const ef = { breakEvenEnabled: false, breakEvenPips: 8, breakEvenActivated: true };
  const r = resolveExitSettings({ id: "c7d7983b" }, ef, {});
  assertEquals(r.breakEvenEnabled, false);
  assertEquals(r.breakEvenSource, "snapshot");
  // And this is why the column rendered "—": the render short-circuits on
  // !beEnabled and never reaches breakEvenActivated.
  assertEquals(r.breakEvenActivated, true, "it HAD fired; the flag was just unreachable");
});
