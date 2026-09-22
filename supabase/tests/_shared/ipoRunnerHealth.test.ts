import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildHealth, parseHealth, isStale, runnerHealthKey,
  RUNNER_NAME, RUNNER_HEALTH_VERSION,
  type RunSummary, type RunnerHealth,
} from "../../functions/_shared/ipoRunnerHealth.ts";

const T0 = Date.UTC(2026, 8, 22, 10, 0, 0);
const base = (over: Partial<RunSummary> = {}): RunSummary => ({
  strategyId: "ipo_cet", strategyVersion: "spec-1.1",
  startedAtMs: T0, endedAtMs: T0 + 1500,
  instrumentsChecked: 3, barsProcessed: 0, eventsEmitted: 0,
  bootstrapRequired: [], divergent: [], errors: [], ...over,
});

// ── the whole reason it exists ───────────────────────────────────────────────

Deno.test("a successful NO-OP run still beats", () => {
  // The runner writes nothing when nothing changed. Without this the quiet case
  // is indistinguishable from a stopped scheduler.
  const h = buildHealth(base(), null);
  assertEquals(h.lastStatus, "OK");
  assertEquals(h.barsProcessed, 0);
  assertEquals(h.eventsEmitted, 0);
  assertEquals(h.lastRunAt, new Date(T0 + 1500).toISOString());
  assertEquals(h.lastSuccessAt, h.lastRunAt, "a no-op IS a success");
  assertEquals(h.consecutiveFailures, 0);
  assertEquals(h.durationMs, 1500);
});

Deno.test("an advancing run beats with the work it did", () => {
  const h = buildHealth(base({ barsProcessed: 3, eventsEmitted: 3 }), null);
  assertEquals(h.lastStatus, "OK");
  assertEquals(h.barsProcessed, 3);
  assertEquals(h.eventsEmitted, 3);
});

// ── failure must not look like success ───────────────────────────────────────

Deno.test("a failed run records the failure and preserves the last real success", () => {
  const good = buildHealth(base(), null);
  const bad = buildHealth(
    base({ startedAtMs: T0 + 900_000, endedAtMs: T0 + 900_500,
           errors: [{ instrument: "EUR/USD", message: "boom" }] }),
    good);
  assertEquals(bad.lastStatus, "PARTIAL");
  assertEquals(bad.errorCode, "INSTRUMENT_ERROR");
  assert(bad.errorMessage!.includes("EUR/USD: boom"));
  // The question worth answering is "when did it last actually work".
  assertEquals(bad.lastSuccessAt, good.lastSuccessAt);
  assert(bad.lastRunAt > bad.lastSuccessAt!);
  assertEquals(bad.consecutiveFailures, 1);
});

Deno.test("a fatal invocation is FAILED, not PARTIAL", () => {
  const h = buildHealth(base({ instrumentsChecked: 0,
    fatal: { code: "RUNNER_FATAL", message: "IPO_PAPER_USER_ID is not configured" } }), null);
  assertEquals(h.lastStatus, "FAILED");
  assertEquals(h.errorCode, "RUNNER_FATAL");
  assertEquals(h.lastSuccessAt, null);
});

Deno.test("checking nothing at all is FAILED even without an error", () => {
  // Zero instruments means the loop never ran. Reporting OK would be a lie of
  // omission, and the most dangerous kind: it looks healthy.
  assertEquals(buildHealth(base({ instrumentsChecked: 0 }), null).lastStatus, "FAILED");
});

Deno.test("bootstrap-required and divergence are PARTIAL, and named", () => {
  const b = buildHealth(base({ bootstrapRequired: ["BTC/USD"] }), null);
  assertEquals(b.lastStatus, "PARTIAL");
  assertEquals(b.bootstrapRequired, ["BTC/USD"]);
  const d = buildHealth(base({ divergent: ["USD/JPY"] }), null);
  assertEquals(d.lastStatus, "PARTIAL");
  assertEquals(d.divergent, ["USD/JPY"]);
  assertEquals(d.lastSuccessAt, null, "a divergent run is not a success");
});

Deno.test("consecutive failures accumulate and reset only on a clean run", () => {
  let h = buildHealth(base({ errors: [{ instrument: "A", message: "x" }] }), null);
  assertEquals(h.consecutiveFailures, 1);
  h = buildHealth(base({ errors: [{ instrument: "A", message: "x" }] }), h);
  h = buildHealth(base({ errors: [{ instrument: "A", message: "x" }] }), h);
  assertEquals(h.consecutiveFailures, 3);
  const recovered = buildHealth(base(), h);
  assertEquals(recovered.consecutiveFailures, 0);
  assertEquals(recovered.lastStatus, "OK");
});

// ── staleness ────────────────────────────────────────────────────────────────

Deno.test("staleness allows a missed tick but not a stopped scheduler", () => {
  const cadence = 15 * 60_000;
  const h = buildHealth(base(), null);
  const at = new Date(h.lastRunAt).getTime();
  assertEquals(isStale(h, at + cadence, cadence), false, "one tick is not an alarm");
  assertEquals(isStale(h, at + cadence * 2, cadence), false);
  assertEquals(isStale(h, at + cadence * 4, cadence), true, "four missed ticks is");
  assertEquals(isStale(null, at, cadence), true, "no heartbeat at all is stale");
});

// ── shape and isolation ──────────────────────────────────────────────────────

Deno.test("the key is namespaced and round-trips", () => {
  assertEquals(runnerHealthKey("ipo_cet"), `ipo_runner_health:ipo_cet:${RUNNER_NAME}`);
  const h = buildHealth(base(), null);
  assertEquals(parseHealth(JSON.stringify(h)), h);
  assertEquals(parseHealth(null), null);
  assertEquals(parseHealth("not json"), null);
  assertEquals(parseHealth('{"nope":1}'), null);
  assertEquals(h.healthVersion, RUNNER_HEALTH_VERSION);
});

Deno.test("the heartbeat is invisible to strategy code", async () => {
  // If any of these could read it, it would stop being operational.
  for (const f of ["ipoPaperContract.ts", "ipoPaperRunner.ts", "ipoIncrementalEngine.ts",
                   "ipoEngineState.ts", "ipoObservation.ts", "ipoLiveEngine.ts"]) {
    const src = await Deno.readTextFile(`supabase/functions/_shared/${f}`);
    assert(!src.includes("ipoRunnerHealth"), `${f} imports the heartbeat`);
    assert(!src.includes("runner_health"), `${f} references the heartbeat key`);
  }
  // And the read surfaces must not have started writing it either.
  for (const f of ["ipo-observation", "ipo-paper-state"]) {
    const src = await Deno.readTextFile(`supabase/functions/${f}/index.ts`);
    assert(!src.includes("ipoRunnerHealth"), `${f} writes a heartbeat`);
  }
});

Deno.test("the heartbeat cannot break a run", async () => {
  const src = await Deno.readTextFile("supabase/functions/ipo-paper-runner/index.ts");
  const fn = src.slice(src.indexOf("async function writeHeartbeat"));
  assert(fn.includes("try {") && fn.includes("catch"),
    "writeHeartbeat can throw — a monitoring hiccup would fail the run");
  // It must be written AFTER the strategy work, never before it.
  assert(src.indexOf("await applyPlan(") < src.indexOf("await writeHeartbeat(db, summary)"),
    "the heartbeat is written before the plan is committed");
  // And the far-future expiry, or the hourly sweep deletes it.
  assert(fn.includes("365 * 24 * 3_600_000"), "the heartbeat can be swept by cleanup");
});

Deno.test("the runner beats on the fatal path too", async () => {
  const src = await Deno.readTextFile("supabase/functions/ipo-paper-runner/index.ts");
  const tail = src.slice(src.lastIndexOf("} catch (e) {"));
  assert(src.includes("RUNNER_FATAL"), "a crash would leave no heartbeat");
  assert(tail.includes("writeHeartbeat") || src.includes('code: "RUNNER_FATAL"'),
    "the fatal path does not beat");
});
