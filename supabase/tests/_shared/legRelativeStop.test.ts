import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The origin-based stop was already implemented — `bot-scanner:6549` places it
 * beyond the impulse origin plus a buffer, which is the rule as written. Two
 * parameters stopped it applying.
 *
 * BUFFER. `slBufferPips x assetProfile.slBufferMultiplier` (forex 1.0,
 * commodity 2.0, crypto 2.0), with swing forcing slBufferPips = 5:
 *
 *   EUR/USD   5 pips    0.046% of price
 *   XAU/USD   $0.10     0.0023%          <- a ten-cent stop-hunt allowance
 *   BTC/USD   10 pts    0.013%
 *
 * Twenty times apart for something that should mean the same thing. The same
 * unit bug that left gold's stop floor at 50 pips ($0.50) for months.
 *
 * CAP. The override only applied if the result fitted inside
 * `staticFloor x impulseSlCapMultiplier` — an absolute pip count unrelated to
 * the move. On swing (6x) that is 120 pips on EUR/USD and $42 on gold, while a
 * Daily impulse leg is routinely wider. So the origin stop was rejected as
 * "absurdly wide" on most Daily structure and the setup fell back to a swing
 * stop, silently, which is not the rule at all.
 *
 * Both are now taken from the leg, which is what the rule is relative to.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const mapper = await Deno.readTextFile(
  new URL("../../functions/_shared/configMapper.ts", import.meta.url),
);

/** Buffer selection, mirroring the scanner. */
const buffer = (legRange: number, pipBuffer: number, pct = 0.02) =>
  Math.max(pipBuffer, legRange * pct);

Deno.test("the buffer scales with the leg, and means the same thing everywhere", () => {
  // A 300-pip EUR/USD leg and a 6000-pip ($60) gold leg both get 2%.
  assertEquals(buffer(0.0300, 0.0005), 0.0006, "EUR/USD: 6 pips on a 300-pip leg");
  assertEquals(Math.round(buffer(60, 0.10) * 100) / 100, 1.20, "XAU: $1.20 on a $60 leg, not $0.10");
  assertEquals(buffer(4000, 10), 80, "BTC: 80 points on a 4000-point leg, not 10");
});

Deno.test("the pip buffer stays as a floor, so nothing shrinks", () => {
  // A tiny leg must not produce a smaller allowance than the old behaviour.
  assertEquals(buffer(0.0010, 0.0005), 0.0005, "2% of a 10-pip leg is under the pip floor");
  assert(buffer(0.0010, 0.0005) >= 0.0005);
});

Deno.test("the buffer percentage is clamped to something sane", () => {
  const i = scanner.indexOf("const legBufferPct =");
  const block = scanner.slice(i, i + 240);
  assert(/Math\.max\(0, Math\.min\(0\.2,/.test(block), "0-20%: a buffer past a fifth of the leg is a typo");
  assert(/: 0\.02;/.test(block), "defaults to 2%");
});

/** Cap selection, mirroring the scanner. */
const cap = (legPips: number, floorCapPips: number, mult = 1.2) =>
  Math.max(floorCapPips, legPips * mult);

Deno.test("the cap follows the leg, so Daily structure is no longer rejected", () => {
  // EUR/USD swing: floor cap is 20 x 6 = 120 pips. A 300-pip Daily leg needs
  // more than that or the origin stop is thrown away.
  assertEquals(cap(300, 120), 360, "a 300-pip leg permits 360, not 120");
  // Gold: floor cap 700 x 6 = 4200 pips ($42); a $60 leg needs $72.
  assertEquals(cap(6000, 4200), 7200);
});

Deno.test("the floor-based cap remains a lower bound", () => {
  // A small leg on a wide-floor instrument must not be squeezed below what the
  // old cap allowed.
  assertEquals(cap(50, 120), 120, "short leg keeps the floor cap");
});

Deno.test("the scanner uses both, not one or the other", () => {
  assert(/const slBuffer = Math\.max\(pipBuffer, impulseRange \* legBufferPct\);/.test(scanner),
    "buffer is the larger of the pip floor and the leg fraction");
  assert(/const maxImpulseSlPips = Math\.max\(floorCapPips, legCapPips\);/.test(scanner),
    "cap is the larger of the floor cap and the leg cap");
  assert(!/const maxImpulseSlPips = \(staticMinSlPips \* \(pairConfig\.impulseSlCapMultiplier/.test(scanner),
    "the floor-only cap must be gone");
});

Deno.test("the stop is still measured from the impulse origin", () => {
  // The rule itself is unchanged — only what decides the buffer and the ceiling.
  assert(
    /impulseSL = analysis\.direction === "long"\s*\n\s*\? impulseData\.low - slBuffer\s*\n\s*: impulseData\.high \+ slBuffer;/
      .test(scanner),
    "origin minus buffer for a long, plus for a short",
  );
});

Deno.test("which term decided is recorded on the trade", () => {
  // A stop that looks wrong is otherwise indistinguishable from a leg that was
  // measured wrong.
  const i = scanner.indexOf("detail.impulseZoneSLOverride = {");
  const block = scanner.slice(i, i + 700);
  for (const f of ["legRangePips", "bufferPips", "bufferSource", "capPips", "capSource"]) {
    assert(new RegExp(`${f}:`).test(block), `must record ${f}`);
  }
});

Deno.test("both knobs are config-defaulted and reachable from either nesting", () => {
  assert(/^  legStopBufferPct: 0\.02,$/m.test(mapper));
  assert(/^  legStopCapMultiple: 1\.2,$/m.test(mapper));
  for (const k of ["legStopBufferPct", "legStopCapMultiple"]) {
    assert(
      new RegExp(`${k}: strategy\\.${k} \\?\\? raw\\.${k} \\?\\? RUNTIME_DEFAULTS\\.${k},`).test(mapper),
      `${k} must resolve strategy then raw then default`,
    );
  }
});
