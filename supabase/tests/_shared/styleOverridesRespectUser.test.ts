import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isExplicitlySet, STYLE_PROTECTED_SOURCES } from "../../functions/_shared/configMapper.ts";

/**
 * STYLE_OVERRIDES decided "did the user set this?" by comparing the RESOLVED
 * VALUE against DEFAULTS. For a boolean that leaves exactly two reachable
 * outcomes — !DEFAULTS, or the style's value — and they collapse into one
 * whenever the style wants the opposite of the default:
 *
 *   breakEvenEnabled     DEFAULTS true,  scalper false  -> only false reachable
 *   partialTPEnabled     DEFAULTS true,  scalper false  -> only false reachable
 *   trailingStopEnabled  DEFAULTS false, scalper false  -> both reachable, fine
 *
 * So the break-even toggle could not be switched ON for a scalper at all. It
 * fired 2 times in 59 Era C trades while the stored config read `true`, and
 * both of those came through per-position trade_overrides.
 *
 * Numbers had the milder version: maxHoldHours deliberately set to 0 is
 * indistinguishable from unset, so the style applied 4 while the config screen
 * said "no limit".
 *
 * Presence in the stored JSON is the honest question, and it is what
 * isExplicitlySet asks.
 */

const mapper = await Deno.readTextFile(
  new URL("../../functions/_shared/configMapper.ts", import.meta.url),
);
const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("the old value-comparison test is gone", () => {
  assert(
    !/if \(\(config as any\)\[key\] === \(DEFAULTS as any\)\[key\]\)/.test(scanner),
    "comparing against DEFAULTS is the bug, not a style",
  );
  assert(
    /if \(!isExplicitlySet\(\(config as any\)\.__rawConfigJson, key\)\)/.test(scanner),
    "the style loop must ask about presence",
  );
  assert(
    /__rawConfigJson = data\?\.config_json \?\? null;/.test(scanner),
    "and the raw config must be carried for it to read",
  );
});

Deno.test("a boolean set to the default value still counts as set", () => {
  // The exact case that made break-even unreachable.
  assertEquals(isExplicitlySet({ exit: { breakEven: true } }, "breakEvenEnabled"), true);
  assertEquals(isExplicitlySet({ exit: { breakEven: false } }, "breakEvenEnabled"), true);
  assertEquals(isExplicitlySet({ exit: {} }, "breakEvenEnabled"), false);
});

Deno.test("a number set to zero still counts as set", () => {
  // maxHoldHours 0 means "no limit" and is a real choice, not an absence.
  assertEquals(isExplicitlySet({ exit: { timeExitHours: 0 } }, "maxHoldHours"), true);
  assertEquals(isExplicitlySet({ exit: {} }, "maxHoldHours"), false);
});

Deno.test("any of the mapper's alternate paths counts", () => {
  // trailingStopEnabled resolves from exit.trailingStop, then
  // exit.trailingStopEnabled, then the root. All three are the user writing it.
  for (const raw of [
    { exit: { trailingStop: true } },
    { exit: { trailingStopEnabled: true } },
    { trailingStopEnabled: true },
  ]) {
    assertEquals(isExplicitlySet(raw, "trailingStopEnabled"), true, JSON.stringify(raw));
  }
});

Deno.test("null and undefined are absence, not a value", () => {
  assertEquals(isExplicitlySet({ exit: { breakEven: null } }, "breakEvenEnabled"), false);
  assertEquals(isExplicitlySet({ exit: { breakEven: undefined } }, "breakEvenEnabled"), false);
  assertEquals(isExplicitlySet(null, "breakEvenEnabled"), false);
  assertEquals(isExplicitlySet({}, "breakEvenEnabled"), false);
  assertEquals(isExplicitlySet({ exit: "not an object" }, "breakEvenEnabled"), false);
});

Deno.test("an unknown key is never treated as set", () => {
  // Fail closed: a field with no declared sources must not silently defeat the
  // style just because someone added it to userProtectedFields.
  assertEquals(isExplicitlySet({ anything: 1 }, "someFieldNobodyDeclared"), false);
});

Deno.test("the source lists match the mapper's own ?? chains", () => {
  // This is the anti-drift guard. Parse mapNestedToFlat and require every
  // source it reads for a protected key to appear in STYLE_PROTECTED_SOURCES.
  // Without it the two definitions rot apart silently and the bug returns.
  const missing: string[] = [];
  for (const [key, declared] of Object.entries(STYLE_PROTECTED_SOURCES)) {
    const m = mapper.match(new RegExp(`^    ${key}: (.+?),\\s*$`, "m"));
    if (!m) continue; // minConfluence uses an IIFE; covered by its own case below
    const sources = [...m[1].matchAll(/\b(strategy|entry|exit|risk)\.(\w+)/g)].map((x) => `${x[1]}.${x[2]}`);
    const roots = [...m[1].matchAll(/\braw\.(\w+)/g)].map((x) => x[1]);
    for (const src of [...sources, ...roots]) {
      if (!declared.includes(src)) missing.push(`${key} <- ${src}`);
    }
  }
  assertEquals(missing, [], "sources read by the mapper but not declared here");
});

Deno.test("minConfluence's IIFE sources are declared too", () => {
  // It resolves inside an arrow-IIFE, so the regex above skips it. Assert its
  // real sources explicitly rather than leaving a hole.
  const i = mapper.indexOf("minConfluence: (() => {");
  const block = mapper.slice(i, mapper.indexOf("})(),", i));
  for (const src of ["strategy.confluenceThreshold", "strategy.minConfluenceScore"]) {
    assert(block.includes(src), `mapper should read ${src}`);
    assert(STYLE_PROTECTED_SOURCES.minConfluence.includes(src), `must declare ${src}`);
  }
});
