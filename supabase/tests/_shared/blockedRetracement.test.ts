import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * "1H bearish bias BUT 15m trend is bullish (opposes bias) → BLOCKED"
 *
 * A bullish 15m inside a bearish 1H bias is also exactly what a retracement
 * into a sell zone looks like. So this gate may be refusing the core setup
 * rather than protecting against a reversal.
 *
 * directionEngine already knows: skipTrendBlock at :880 waives the block while
 * is4HRetracing() reports a healthy pullback, with the comment "those two
 * checks otherwise contradict each other and the blunter one wins". But it is
 * conditional on priceAwareStructureBlocks, which defaults to FALSE in both
 * directionEngine:247 and configMapper:183 — so the waiver never applies.
 *
 * Both block sites then hardcoded the retrace flag to false on the way out,
 * which destroyed the only evidence that could tell "blocked a reversal" from
 * "blocked a pullback".
 *
 * These tests pin the recording. They do NOT enable the waiver: that changes
 * which trades happen, and the Era C freeze rules it out until ~40 trades.
 */

const engine = await Deno.readTextFile(
  new URL("../../functions/_shared/directionEngine.ts", import.meta.url),
);
const mapper = await Deno.readTextFile(
  new URL("../../functions/_shared/configMapper.ts", import.meta.url),
);
const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("the waiver exists and is still gated on priceAwareStructureBlocks", () => {
  assert(/const skipTrendBlock = priceAware && structCheck\.retracing;/.test(engine),
    "structure-TF waiver");
  assert(/const skipLegacyTrendBlock = priceAwareLegacy && h4Check\.retracing;/.test(engine),
    "legacy 4H waiver");
});

Deno.test("it is OFF by default, in both places that define it", () => {
  // If this ever changes, it is a strategy change and the freeze applies.
  assert(/priceAwareStructureBlocks: false,/.test(engine), "directionEngine default");
  assert(/priceAwareStructureBlocks: false,/.test(mapper), "configMapper default");
});

Deno.test("neither block discards the retracement flag any more", () => {
  // Was `structureRetrace: false` / `h4Retrace: false` regardless of the truth.
  const structBlock = engine.slice(
    engine.indexOf("if (!skipTrendBlock &&"),
    engine.indexOf("// ── Step 3: Check confirmation TF ──"),
  );
  assert(/structureRetrace: structCheck\.retracing,/.test(structBlock),
    "structure block reports the real value");
  assert(!/structureRetrace: false,/.test(structBlock), "the hardcoded false must be gone");

  const legacyBlock = engine.slice(
    engine.indexOf("if (!skipLegacyTrendBlock &&"),
    engine.indexOf("// ── Step 3: Check 1H confirmation ──"),
  );
  assert(/h4Retrace: h4Check\.retracing,/.test(legacyBlock),
    "legacy block reports the real value");
  assert(!/h4Retrace: false,/.test(legacyBlock), "the hardcoded false must be gone");
});

Deno.test("both block sites set blockedRetracement", () => {
  assert(/blockedRetracement: structCheck\.retracing,/.test(engine));
  assert(/blockedRetracement: h4Check\.retracing,/.test(engine));
  // And both result types carry it, or the style-aware path will not compile.
  const dr = engine.slice(engine.indexOf("export interface DirectionResult"),
    engine.indexOf("// ── Configuration ──"));
  const sdr = engine.slice(engine.indexOf("export interface StyleDirectionResult"),
    engine.indexOf("determineDirectionStyleAware —"));
  assert(/blockedRetracement\?: boolean;/.test(dr), "DirectionResult");
  assert(/blockedRetracement\?: boolean;/.test(sdr), "StyleDirectionResult");
});

Deno.test("the reason string says when a pullback was the thing refused", () => {
  // Reading a scan log should not require knowing this test exists.
  const marker = "[RETRACEMENT — would pass with priceAwareStructureBlocks]";
  assert(engine.split(marker).length - 1 === 2,
    "both block sites annotate the reason");
});

Deno.test("it reaches the scan record, so it can be counted", () => {
  assert(/blockedRetracement: \(simpleDirectionResult as any\)\.blockedRetracement \?\? false,/
    .test(scanner), "written into impulseZone.directionDetail");
});

Deno.test("nothing acts on it", () => {
  // Recording only. Turning the waiver on is the strategy change.
  assert(!/if \([^)]*blockedRetracement[^)]*\)\s*\{[^}]*continue/.test(scanner),
    "the scanner must not branch on it");
});

Deno.test("the style-aware mapping carries the flag through", () => {
  // bot-scanner remaps StyleDirectionResult onto the legacy DirectionResult
  // shape FIELD BY FIELD. Anything not listed is silently dropped, and that is
  // what happened: blockedRetracement was set correctly at the block, mapped
  // away before the scan log, and read as 0 of 148 trend-gate blocks — which
  // looks exactly like "the gate never refuses a pullback".
  //
  // Both style branches must copy it. The day_trader branch calls
  // determineDirection directly and returns a DirectionResult, so it is
  // unaffected.
  const mappings = [...scanner.matchAll(
    /simpleDirectionResult = \{[\s\S]{0,900}?reason: `\[(scalper|swing)\]/g,
  )];
  assertEquals(mappings.length, 2, "both style branches remap");
  for (const m of mappings) {
    assert(/blockedRetracement: styleDirectionResult\.blockedRetracement,/.test(m[0]),
      `the ${m[1]} mapping must carry blockedRetracement`);
  }
});

Deno.test("the annotation survives in the reason, as a second route to the truth", () => {
  // reason IS copied by the mapping, so the "[RETRACEMENT — ...]" marker
  // reaches scan_logs even when a structured field does not. Worth keeping:
  // it is how the dropped flag was detectable at all.
  assert(/\$\{styleDirectionResult\.reason\}/.test(scanner), "reason is passed through verbatim");
});
