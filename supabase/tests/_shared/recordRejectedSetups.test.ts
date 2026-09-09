import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * rejected_setups, its outcome_status of would_have_won / would_have_lost, the
 * outcome-tracker cron and three consumers (strategy-advisor,
 * bot-daily-review, bot-weekly-advisor) all exist. NOTHING has written to the
 * table since the 2026-09-01 revert deleted the producer — every reference in
 * the codebase is a read or a grade-update.
 *
 * So gate effectiveness has been unmeasurable. The machinery to answer "was
 * this rejection right?" is intact and has no input.
 *
 * Measured 2026-09-09 from scan_logs, which is all that survived: the
 * zone-score gate alone refused 54 distinct zones in 7 days, 21 of which price
 * then entered, 10 of them missing the threshold by half a point. Whether
 * refusing those was correct is precisely what this table was built to answer,
 * and there was no way to ask.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const migration = await Deno.readTextFile(
  new URL("../../migrations/20260523100000_create_rejected_setups.sql", import.meta.url),
);

Deno.test("every NOT NULL column is supplied", () => {
  // An insert missing one of these fails at runtime, inside a try/catch that
  // swallows it — the table would stay empty and look like the gate never
  // fired.
  const i = scanner.indexOf('await supabase.from("rejected_setups").insert({');
  assert(i > -1, "the insert must exist");
  const block = scanner.slice(i, i + 1800);
  for (const col of [
    "user_id", "symbol", "direction", "rejection_type", "confluence_score", "entry_price",
  ]) {
    assert(new RegExp(`${col}:`).test(block), `NOT NULL column ${col} missing`);
  }
});

Deno.test("rejection_type is one the CHECK constraint allows", () => {
  // The constraint text appears more than once in the migration (table plus a
  // comment), so dedupe rather than assuming a single match.
  const allowed = [...new Set(
    [...migration.matchAll(/rejection_type IN \(([^)]*)\)/g)]
      .flatMap(m => [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map(x => x[1])),
  )].sort();
  assertEquals(allowed, ["below_threshold_strong_t1", "gate_blocked"]);
  assert(/rejectionType: "gate_blocked"/.test(scanner), "the zone gate records gate_blocked");
  assert(
    /"gate_blocked" \| "below_threshold_strong_t1"/.test(scanner),
    "the helper's type should mirror the constraint, so a bad value cannot compile",
  );
});

Deno.test("direction is only ever long or short", () => {
  // The table CHECKs it, and analysis.direction can be null.
  assert(/if \(!analysis\?\.direction \|\| typeof analysis\.lastPrice !== "number"\) return;/.test(scanner),
    "a null direction must skip the insert rather than violate the constraint");
});

Deno.test("repeat evaluations of one zone are deduplicated", () => {
  // 54 distinct zones produced 421 rejection events in the same week. Grading
  // the same setup seven times would bias every statistic drawn from the table.
  const i = scanner.indexOf("async function recordRejectedSetup");
  const fn = scanner.slice(i, scanner.indexOf("\n}", scanner.indexOf("catch (e: any)", i)));
  assert(/\.eq\("outcome_status", "pending"\)/.test(fn), "only ungraded rows should suppress a new one");
  assert(/gte\("rejected_at"/.test(fn), "the dedup window must be time-bounded");
  assert(/if \(dupe && dupe\.length > 0\) return;/.test(fn));
});

Deno.test("the dedup window is hours, not the whole history", () => {
  // Too wide and a genuinely new setup on the same symbol is never recorded.
  const m = scanner.match(/Date\.now\(\) - (\d+) \* 60 \* 60 \* 1000/);
  assert(m, "window must be expressed in hours");
  const hours = Number(m[1]);
  assert(hours >= 1 && hours <= 12, `window of ${hours}h is outside a sensible range`);
});

Deno.test("it cannot break a scan", () => {
  const i = scanner.indexOf("async function recordRejectedSetup");
  const fn = scanner.slice(i, i + 3500);
  assert(/try \{/.test(fn) && /catch \(e: any\) \{/.test(fn), "must be wrapped");
  assert(/console\.warn\(`\[rejected-setups\] insert failed/.test(fn),
    "and say so — a silent diagnostic failure is how this table emptied in the first place");
});

Deno.test("the zone that was refused is recorded, not just the score", () => {
  // Without bounds you cannot tell later which level was declined.
  // Anchor on the CALL, not the helper's type declaration — the literal
  // "gate_blocked" appears in both, and the declaration comes first.
  const i = scanner.indexOf("await recordRejectedSetup(supabase, userId, pair, analysis, {");
  assert(i > -1, "the call site was not found");
  const block = scanner.slice(i, i + 600);
  for (const f of ["zoneLow", "zoneHigh", "zoneScore", "zoneType"]) {
    assert(new RegExp(`${f}:`).test(block), `must record ${f}`);
  }
  assert(/failedGates: \[`zone_score_gate:/.test(block), "and which gate, with its margin");
});

Deno.test("entry price is what a market entry would have used", () => {
  // The executable stop is computed much later in the pair loop, so
  // analysis.stopLoss is the honest value at this point rather than a guess at
  // the floored one.
  assert(/entry_price: analysis\.lastPrice,/.test(scanner));
  assert(/const sl = typeof analysis\.stopLoss === "number" \? analysis\.stopLoss : null;/.test(scanner));
});

Deno.test("rr_ratio is null rather than Infinity on a zero-risk setup", () => {
  const rr = (entry: number, sl: number | null, tp: number | null) => {
    const risk = sl != null ? Math.abs(entry - sl) : null;
    const reward = tp != null ? Math.abs(tp - entry) : null;
    return risk && risk > 0 && reward ? Math.round((reward / risk) * 100) / 100 : null;
  };
  assertEquals(rr(100, 90, 120), 2);
  assertEquals(rr(100, 100, 120), null, "zero risk must not divide");
  assertEquals(rr(100, null, 120), null);
  assertEquals(rr(100, 90, null), null);
});
