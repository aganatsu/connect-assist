import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Pending orders never reach zone touch. Measured 2026-09-07: 31 orders over 48
 * hours, 0 filled, confirmation_attempts 0 on every one — while 110 evaluations
 * that same day had price INSIDE a zone.
 *
 * Four explanations have now been wrong:
 *
 *   zone-exit reset      2 orders in 60 days
 *   supersession         309 of 400 replaced at the IDENTICAL price
 *   credit starvation    refusals retry; only gaveUp abandons, ~10%
 *   CHECK constraint     the live schema already allowed awaiting_confirmation
 *
 * The comparison itself has never been observed:
 *
 *   filled = direction === "long"
 *     ? lastCandle.low  <= entryPrice
 *     : lastCandle.high >= entryPrice
 *
 * It reads ONE bar — the last of the entry-timeframe series — so it fails
 * silently if that bar is stale, if the series lags, or if price dipped through
 * the level and recovered inside a bar the loop never saw. And the write that
 * follows has never had its error checked.
 *
 * This records the inputs instead of inferring from the outcome a fifth time.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("the check is recorded on every evaluation, not only on a touch", () => {
  // Recording only successes would show nothing at all, which is the current
  // state of knowledge.
  const push = scanner.indexOf("touchChecks.push({");
  const filled = scanner.indexOf("if (filled) {", scanner.indexOf("const filled = pending.direction"));
  assert(push > -1, "touchChecks.push missing");
  assert(push < filled, "the record must be written BEFORE the filled branch");
});

Deno.test("both sides of the comparison are captured", () => {
  const i = scanner.indexOf("touchChecks.push({");
  const block = scanner.slice(i, i + 1200);
  for (const f of ["entryPrice", "barLow", "barHigh", "barClose", "filled"]) {
    assert(new RegExp(`${f}[,:]`).test(block), `must record ${f}`);
  }
});

Deno.test("bar freshness is captured, because a stale bar fails silently", () => {
  const i = scanner.indexOf("touchChecks.push({");
  const block = scanner.slice(i, i + 1200);
  for (const f of ["barTime", "barStalenessMin", "interval", "barsInSeries"]) {
    assert(new RegExp(`${f}[,:]`).test(block), `must record ${f}`);
  }
  assert(
    /Date\.now\(\) - tdBarTimeMs\) \/ 60000/.test(scanner),
    "staleness must be minutes between now and the bar's own timestamp",
  );
});

Deno.test("staleness is null rather than NaN when the bar has no timestamp", () => {
  // NaN serialises to null in JSON anyway, but an explicit null distinguishes
  // 'no timestamp' from 'timestamp unparseable' when reading the rows back.
  assert(
    /Number\.isFinite\(tdBarTimeMs\)\s*\n?\s*\? \(Date\.now\(\) - tdBarTimeMs\) \/ 60000 : null/.test(scanner),
    "guard the parse",
  );
});

Deno.test("distancePips separates a data problem from a logic problem", () => {
  // Negative distance means the bar DID reach the level. Negative with
  // filled=false would mean the comparison is wrong, not the data.
  const dist = (dir: "long" | "short", low: number, high: number, entry: number, pip: number) =>
    (dir === "long" ? low - entry : entry - high) / pip;
  // Long, bar low 1.1000, entry 1.1010 -> reached, negative.
  assertEquals(Math.round(dist("long", 1.1000, 1.1030, 1.1010, 0.0001) * 10) / 10, -10);
  // Long, bar low 1.1020, entry 1.1010 -> missed by 10 pips, positive.
  assertEquals(Math.round(dist("long", 1.1020, 1.1030, 1.1010, 0.0001) * 10) / 10, 10);
  // Short mirrors.
  assertEquals(Math.round(dist("short", 1.1000, 1.1030, 1.1010, 0.0001) * 10) / 10, -20);
  assert(/distancePips: tdDistancePips/.test(scanner), "must be recorded");
});

Deno.test("the pip size comes from the order's own symbol", () => {
  // `spec` belongs to the per-pair loop and is not in scope here; using it
  // would have been a different instrument's pip size, or a crash.
  assert(
    /const tdSpec = SPECS\[pending\.symbol\] \|\| SPECS\["EUR\/USD"\];/.test(scanner),
    "resolve the spec from the pending order",
  );
});

Deno.test("the zone-touch write finally has its error checked", () => {
  // This write has never been error-checked. A rejection leaves the order
  // silently 'pending' — indistinguishable from price never arriving, which is
  // exactly the ambiguity that has cost four wrong diagnoses.
  const i = scanner.indexOf('status: "awaiting_confirmation"');
  const before = scanner.slice(Math.max(0, i - 300), i);
  assert(/const \{ error: touchErr \}/.test(before), "the update must capture its error");
  const after = scanner.slice(i, i + 900);
  assert(/if \(touchErr\)/.test(after), "and test it");
  assert(/ZONE TOUCH WRITE FAILED/.test(after), "and say so loudly");
  assert(/writeError = touchErr\.message/.test(after), "and attach it to the record");
});

Deno.test("the records reach scan detail", () => {
  assert(/^  const touchChecks: any\[\] = \[\];$/m.test(scanner), "collector declared");
  assert(/^      touchChecks,$/m.test(scanner), "surfaced in the scan meta");
});
