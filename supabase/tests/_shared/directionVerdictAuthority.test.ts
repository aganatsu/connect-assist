import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Gate 1 replaced the legacy HTF bias check with the Direction Verdict. The
 * legacy check compared the daily trend against the entry direction and blocked
 * a mismatch. Its replacement only reported the verdict and passed.
 *
 * Measured 2026-09-02, four GBP/JPY entries recorded in paper_trade_history:
 *
 *   gate:      "Direction OK: SHORT (conf: 60%, adj: +0.30, agreement: 67%)"
 *   direction: long
 *   outcome:   sl_hit, four times, -1,110 of a -2,546 week
 *
 * The verdict was correct, was written into the gate reason, and was ignored.
 * A gate that prints the right answer and passes anyway is worse than no gate,
 * because it reads like confirmation in the logs.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

/** The Gate 1 block inside runSafetyGates. */
function gate1(): string {
  const start = scanner.indexOf("// Gate 1: Direction Verdict");
  assert(start > -1, "Gate 1 block not found");
  const end = scanner.indexOf("config.htfBiasRequired", start);
  assert(end > start, "Gate 1 block is unterminated");
  return scanner.slice(start, end);
}

Deno.test("Gate 1 compares the verdict against the direction being traded", () => {
  const block = gate1();
  assert(
    /directionVerdict\.verdict\s*!==\s*direction/.test(block),
    "Gate 1 must compare verdict to the entry direction — reporting it is not checking it",
  );
});

Deno.test("a contradiction fails the gate rather than passing with a note", () => {
  const block = gate1();
  const at = block.indexOf("directionVerdict.verdict !== direction");
  assert(at > -1, "conflict comparison missing");
  // The push that follows the comparison must be a failure.
  const after = block.slice(at, at + 900);
  assert(
    /passed:\s*false/.test(after),
    "a verdict/direction conflict must fail the gate",
  );
  assert(
    /CONFLICT/i.test(after),
    "the reason should name the conflict so it is greppable in scan_logs",
  );
});

Deno.test("a neutral verdict is not treated as a conflict", () => {
  // Neutral means the verdict has no opinion, which is different from
  // disagreeing. Blocking on neutral is a separate, larger tightening —
  // measured at 2 of 548 verdicts — and is deliberately not done here.
  const block = gate1();
  assert(
    /verdict\s*!==\s*"neutral"/.test(block),
    "neutral must be excluded from the conflict check",
  );
});

Deno.test("an agreeing verdict still passes", () => {
  const block = gate1();
  assert(
    /passed:\s*true[\s\S]{0,200}Direction OK/.test(block),
    "the agreeing path must still pass",
  );
});

Deno.test("shouldBlock is still honoured ahead of the conflict check", () => {
  const block = gate1();
  const blockAt = block.indexOf("directionVerdict.shouldBlock");
  const conflictAt = block.indexOf("directionVerdict.verdict !== direction");
  assert(blockAt > -1 && conflictAt > -1, "both checks must be present");
  assert(
    blockAt < conflictAt,
    "an explicit block should be reported as BLOCKED, not reinterpreted as a conflict",
  );
});

Deno.test("the legacy fallback still compares too", () => {
  // The legacy path is what the verdict replaced; it compared htfTrend against
  // entryBias. If it ever stops comparing, the fallback has the same hole.
  assert(
    /htfTrend !== entryBias/.test(scanner),
    "legacy HTF bias check must still compare trend against entry direction",
  );
});
