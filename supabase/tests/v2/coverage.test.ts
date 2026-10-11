// Every normative clause of STRATEGY_SPEC_V2.1.1_FROZEN.md has at least one tagged test; every §13 reason is asserted somewhere.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clause } from "./helpers/clause.ts";

export const CLAUSES = [
  "0.1", "0.2", "0.3", "0.4", "0.5", "0.6", "0.7", "0.8", "0.9", "0.10", "0.11",
  "1.1", "1.2", "1.3", "1.3a", "1.4", "1.5", "1.6", "1.7", "1.8", "1.9",
  "2.0", "2.1", "2.2", "2.3",
  "3.1", "3.2", "3.3", "3.4", "3.5", "3.6", "3.7", "3.8", "3.9", "3.10", "3.11", "3.12",
  "4.1", "4.2", "4.3", "5.1", "5.2", "5.3", "5.4", "5.5",
  "6.1", "6.2", "6.3", "6.4", "6.5", "7.1", "7.1a", "7.2", "7.3", "7.4", "7.5", "7.6",
  "8.1", "8.2", "8.3", "8.4", "9", "10.1", "10.2", "10.3",
  "11.1", "11.2", "11.3", "11.4", "11.5", "11.6",
  "12.1", "12.2", "12.3", "12.4", "12.5", "12.6", "12.7", "12.8",
  "0.12", "13", "14", "15", "16", "OWN", "AM1", "AM2", "AM3", "W1", "B1", "GT", "PS", "TP1", "SA1", "LO1", "3.13", "CF1",
];
/** Clauses with no Phase 2 (pure engine) behaviour to test, and why. */
export const DEFERRED: Record<string, string> = {
  "11.1": "V2 bar storage and TwelveData-only fetching — Phase 4 runtime, not built (not wired to production)",
  "11.2": "run cadence, batch requests, credit reservation — Phase 4 runtime",
  "11.3": "credit accounting against the provider counter — operational check before Phase 4",
  "12.6": "process rule (no verdicts between gates, no changes during the test) — governance, not code",
  "12.8": "Baseline A descriptive comparison — reporting, outside V2",
  "14": "Candidate C retirement — no V2 code",
};
const REASONS = [
  "LOOKBACK_EXPIRED", "LEG_INVALIDATED", "DATA_GAP_FRESHNESS_UNKNOWN", "DATA_GAP_PROVIDER_WIDE", "SPENT_OUTSIDE_WINDOW", "SPENT_NEWS_BLOCK",
  "SPENT_DATA_PENDING", "SPENT_FEED_UNAVAILABLE", "SPENT_CAP", "SPENT_PAIR_BUSY", "SPENT_SAME_BAR",
  "NEWS_FEED_UNAVAILABLE", "DATA_PENDING_CONFIRMATION", "NEWS_BLOCKED_CONFIRMATION",
  "EXPIRED", "DATA_GAP_ARMED", "DATA_GAP_ENTRY", "STOP_TOO_WIDE", "STOP_TOO_TIGHT", "OPPOSING_POI_CONTAINS_ENTRY", "NO_TARGET",
  "RR_BELOW_MIN", "SIZING_FAILED", "ENTERED", "EXIT_SL", "EXIT_TP", "SPENT_WARMUP", "SPENT_CONFLICT",
];

async function testSources() {
  const dir = new URL(".", import.meta.url).pathname;
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.name.endsWith(".test.ts") && e.name !== "coverage.test.ts") out.push(await Deno.readTextFile(dir + e.name));
  return out.join("\n");
}

clause(["13", "16"], "every normative clause has a tagged test (deferred clauses listed with a reason)", async () => {
  const src = await testSources();
  const tagged = new Set<string>();
  for (const m of src.matchAll(/clause\(\[([^\]]*)\]/g)) for (const id of m[1].matchAll(/"([^"]+)"/g)) tagged.add(id[1]);
  const missing = CLAUSES.filter((c) => !tagged.has(c) && !(c in DEFERRED));
  assertEquals(missing, []);
});

clause(["13"], "every §13 terminal reason is asserted by at least one test (SIZING_FAILED: unreachable by construction, checked in 6.4)", async () => {
  const src = await testSources();
  const absent = REASONS.filter((r) => !new RegExp(`["':]${r}["',\\]:]`).test(src) && r !== "SIZING_FAILED");
  assertEquals(absent, []);
});
