import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Direction blocks were the one refusal with no producer.
 *
 * recordRejectedSetup opens with `if (!analysis?.direction || ...) return;` and
 * a direction block sets _overrideDirection = null, so analysis.direction is
 * null by construction. Every such block has been invisible to rejected_setups
 * since the table was built — which means the 1,527 graded setups behind
 * "refused setups win 18.4% against a 33.3% break-even" exclude this gate
 * structurally, not by sampling.
 *
 * It matters because 82 of 148 trend-gate blocks were retracements
 * (2026-09-15) and nothing could say whether taking them would have paid.
 *
 * These tests pin the two things that make the new rows worth having: they are
 * gradeable, and they cannot be confused with the organically-scored ones.
 */

const scanner = Deno.readTextFileSync(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
/** Assertions must not match the prose explaining them. */
const code = scanner.split("\n")
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join("\n");
const fn = code.slice(
  code.indexOf("async function recordDirectionBlock"),
  code.indexOf("async function loadConfig"),
);

Deno.test("the recorder exists and runs on the no-direction path", () => {
  assert(fn.length > 0, "recordDirectionBlock is defined");
  assert(
    /await recordDirectionBlock\(supabase, userId, pair, analysis, simpleDirectionResult\)/
      .test(code),
    "and is called where the direction engine refused",
  );
});

Deno.test("a row is only written when it can actually be graded", () => {
  // THE POINT OF THIS FILE. outcome-tracker only reaches would_have_won or
  // would_have_lost when a candle crosses stop_loss or take_profit:
  //
  //   if (takeProfit !== null && candle.low <= takeProfit) tpHitThisCandle = true;
  //   if (stopLoss   !== null && candle.high >= stopLoss)  slHitThisCandle = true;
  //
  // With nulls neither fires and the row grades "inconclusive" forever. That
  // produces a table that fills up and answers nothing — the exact failure
  // this work exists to fix. No ATR means no levels, so no row.
  assert(/if \(!Number\.isFinite\(atr\) \|\| atr <= 0\) return;/.test(fn),
    "no ATR, no row");
  assert(/stop_loss: sl,/.test(fn) && /take_profit: tp,/.test(fn),
    "both levels are always written");
  assert(/if \(!Number\.isFinite\(sl\) \|\| !Number\.isFinite\(tp\) \|\| sl <= 0\) return;/.test(fn),
    "and neither can be NaN or negative");
});

Deno.test("only genuine blocks with a bias are recorded", () => {
  // No bias = no hypothesis to grade, which is a different situation from a
  // refused setup. And if a direction resolved, the confluence recorder owns
  // it — recording both would double-count the same pair.
  assert(/if \(bias !== "bullish" && bias !== "bearish"\) return;/.test(fn));
  assert(/if \(analysis\?\.direction\) return;/.test(fn));
});

Deno.test("the synthetic levels are flagged as synthetic", () => {
  // No setup was scored, so there is no structural stop. A 1.5x ATR stop and a
  // 2R target stand in — identical for every row, so they compare with each
  // other and NOT with gate_blocked rows, whose levels came from scoring.
  // Anything drawing a win rate has to know which population it is reading.
  assert(/syntheticLevels: true,/.test(fn));
  assert(/levelBasis: \{ atr, atrMultiple: ATR_SL_FLOOR_MULTIPLIER, targetR: DIRECTION_BLOCK_R \}/.test(fn));
  assert(/rejection_type: "direction_blocked",/.test(fn),
    "a distinct type keeps existing analyses unaffected");
});

Deno.test("the stop uses the same ATR multiple as the real stop floor", () => {
  // A stand-in stop that is wider or tighter than the one a real trade would
  // get would answer a question nobody asked.
  assert(/const stopDistance = atr \* ATR_SL_FLOOR_MULTIPLIER;/.test(fn));
  assert(/ATR_SL_FLOOR_MULTIPLIER,/.test(code.slice(0, code.indexOf("async function"))),
    "imported from smcAnalysis, not redefined");
});

Deno.test("the retracement flag is carried onto the graded row", () => {
  // This is the column the priceAwareStructureBlocks decision will be made on:
  // among blocked pullbacks specifically, do they beat 33.3%?
  assert(/blockedRetracement: dir\?\.blockedRetracement === true,/.test(fn));
  assert(/bias,/.test(fn) && /biasSource: dir\?\.biasSource \?\? null,/.test(fn));
});

Deno.test("re-evaluation does not flood the table", () => {
  // A blocked pair is re-scanned every 5 minutes. Without dedup that is ~12
  // identical rows an hour, and every statistic drawn from the table would be
  // weighted by how long a pair stayed blocked.
  assert(/\.eq\("rejection_type", "direction_blocked"\)/.test(fn),
    "dedup is scoped to this type so it cannot mask a confluence rejection");
  assert(/\.eq\("outcome_status", "pending"\)/.test(fn));
  assert(/6 \* 60 \* 60 \* 1000/.test(fn), "same 6h window as the other producers");
});

Deno.test("it is observational — it writes a row and nothing else", () => {
  // The whole justification for adding this now rather than after the strategy
  // question is settled: it cannot change which trades happen.
  assert(!/paper_positions|pending_orders|\.update\(|_overrideDirection/.test(fn),
    "no writes outside rejected_setups, no direction mutation");
  assert(/catch \(e: any\) \{/.test(fn), "and it fails open");
});

Deno.test("the migration allows the new type", () => {
  // The CHECK permitted exactly two values; an insert would have failed on
  // every blocked pair, silently, because the recorder swallows errors.
  const mig = Deno.readTextFileSync(
    new URL("../../migrations/20260915130000_direction_blocked_rejection_type.sql", import.meta.url),
  );
  assert(/DROP CONSTRAINT IF EXISTS rejected_setups_rejection_type_check/.test(mig));
  for (const t of ["gate_blocked", "below_threshold_strong_t1", "direction_blocked"]) {
    assert(mig.includes(`'${t}'::text`), `${t} survives the rewrite`);
  }
});

Deno.test("direction is long or short, never the raw bias", () => {
  // rejected_setups_direction_check permits only long/short. Writing
  // "bullish" would fail the CHECK on every row — and be swallowed.
  assert(/const direction = bias === "bullish" \? "long" : "short";/.test(fn));
  assertEquals(
    [/direction: "bullish"/, /direction: bias/].filter((r) => r.test(fn)).length,
    0,
    "the bias string never reaches the direction column",
  );
});
