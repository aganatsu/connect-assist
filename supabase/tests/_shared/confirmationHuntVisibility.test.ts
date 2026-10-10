import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The confirmation hunt has produced ZERO fills in the system's history.
 *
 * All 27 recorded fills came from routes that no longer exist — 26 plain
 * `Price touched X` limit fills between 2026-05-04 and 05-15, and one
 * `nested_poi_market` on 08-26. Both live fill paths require status
 * `awaiting_confirmation` plus a confirmation signal, and that pair has never
 * once occurred.
 *
 * Five checks stand between a touch and a fill, each of which `continue`s:
 *
 *   1. confirm5mCandles.length < 10
 *   2. resetsHunt — price left the zone, zone_touch_time nulled
 *   3. detectZoneConfirmation returned null
 *   4. !hasRefZone && tier !== 1 — a confirmation WAS found and discarded
 *   5. max open positions / max per symbol, at fill time
 *
 * None recorded anything durable. The branch logs to console, and management
 * cycles returned before the scan_logs insert — so which check kills the hunt
 * has never been observable. Worse, the sample that WAS recorded came only
 * from full scans, and since a management cycle resolves an order first, it
 * could only ever contain orders nothing killed. A 3-day query on 2026-09-09
 * read a 0.0% thesis firing rate against 24 real kills in the same window.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("every exit from the hunt is recorded, including the fill", () => {
  // A denominator needs the successes too, or a rate cannot be computed.
  for (const outcome of [
    "insufficient_candles",
    "reset_zone_exit",
    "no_tier_passed",
    "tier_rejected_no_refined_zone",
    "blocked_max_open_positions",
    "blocked_max_per_symbol",
    "FILLED",
  ]) {
    assert(
      new RegExp(`outcome: "${outcome}"`).test(scanner),
      `the hunt must record ${outcome}`,
    );
  }
  // 8 since 2026-09-30: losing the atomic fill claim (another poller won,
  // the order was reset/re-armed, or the RPC failed) is a new exit from the
  // hunt and is recorded as FILL_<outcome>.
  assert(/outcome: `FILL_\$\{claim\.outcome\.toUpperCase\(\)\}`/.test(scanner),
    "a lost fill claim must be recorded, not silent");
  // 10 since step 8: the dry-run hypothetical fill and the post-reset
  // entries-locked skip are exits too.
  assert(/outcome: "DRY_RUN_FILL"/.test(scanner), "a dry-run fill must be recorded");
  assert(/outcome: "ENTRIES_LOCKED"/.test(scanner), "a locked skip must be recorded");
  assert(/outcome: "FILL_SIZING_UNAVAILABLE"/.test(scanner), "a refused fill-time sizing must be recorded (step 9)");
  // 12 since step 13: a fill refused by the account risk gate.
  assert(/outcome: "PROP_FIRM_LOCKED"/.test(scanner), "a fill refused by the account risk gate must be recorded (step 13)");
  // Candidate C shadow: the hunt pushes through `huntObs`, which IS
  // confirmationHunt for every A order (a shadow order gets its own sink), and
  // C's own hypothetical-fill exit adds one push — 12 A exits + 1 C exit.
  assert(scanner.includes("const huntObs = isShadow ? shadowObservations : confirmationHunt;"));
  assertEquals((scanner.match(/confirmationHunt\.push\(\{/g) ?? []).length, 0, "every hunt push is routed");
  assertEquals(
    (scanner.match(/huntObs\.push\(\{/g) ?? []).length, 13,
    "one push per exit, and no path left silent",
  );
});

Deno.test("the two most diagnostic outcomes carry their evidence", () => {
  // "a confirmation was found and thrown away" is a different problem from
  // "the market never confirmed", and the tier is what separates them.
  const i = scanner.indexOf('outcome: "tier_rejected_no_refined_zone"');
  const block = scanner.slice(i, i + 300);
  assert(/tier: confirmationSignal\.tier/.test(block), "which tier was discarded");
  assert(/displacement: confirmationSignal\.displacement/.test(block), "and how strong it was");

  // zoneTouchIdx undefined means the hunt scanned the WHOLE series rather than
  // the window since the touch — the shape of the TwelveData timezone bug.
  const j = scanner.indexOf('outcome: "no_tier_passed"');
  const nb = scanner.slice(j, j + 400);
  assert(/zoneTouchIdxFound: zoneTouchIdx !== undefined/.test(nb), "was the touch window found");
  assert(/candlesSinceTouch/.test(nb), "and how long the hunt has had");
});

Deno.test("the reset records that it is an abandonment", () => {
  // confirmation_attempts increments HERE, on reset — reading it as hunting
  // activity inverts its meaning, which it did in analysis on 2026-09-10.
  const i = scanner.indexOf('outcome: "reset_zone_exit"');
  assert(i > -1);
  const block = scanner.slice(Math.max(0, i - 400), i + 300);
  assert(/counts ABANDONMENTS, not hunts/.test(block), "say so where it is incremented");
  assert(/zoneExit, currentPrice, zoneLow, zoneHigh/.test(scanner.slice(i, i + 300)),
    "and record how far outside price actually was");
});

Deno.test("management-only cycles now persist their observations", () => {
  const ret = scanner.indexOf("if (opts?.isManagementOnly) {");
  assert(ret > -1);
  const block = scanner.slice(ret, ret + 3000);
  assert(/from\("scan_logs"\)\.insert\(/.test(block), "must write before returning");
  assert(/type: "management_cycle"/.test(block), "tagged so the two row kinds are separable");
  for (const f of ["thesisObservations", "touchChecks", "confirmationHunt"]) {
    assert(new RegExp(`\\b${f},`).test(block), `must carry ${f}`);
  }
  // Filtered to real actions, so a quiet cycle does not log 8 "no_change" rows.
  assert(/managementActions: activeActions,/.test(block), "must carry the filtered actions");
});

Deno.test("it writes only for pending-order diagnostics, not management actions", () => {
  // Management runs every minute, so an unguarded insert is 1,440 rows a day.
  //
  // `activeActions.length` was in this guard and it is the wrong trigger: with
  // trailing enabled and a position open the trail ratchets every cycle, so
  // every minute produced an action and therefore a row. Those rows surfaced in
  // the scan viewer as 60-second "scans" with 0 pairs and blank detail.
  const ret = scanner.indexOf("if (opts?.isManagementOnly) {");
  const block = scanner.slice(ret, ret + 3000);
  assert(
    /if \(thesisObservations\.length \|\| touchChecks\.length \|\| confirmationHunt\.length\)/
      .test(block),
    "guarded on the three pending-order collectors",
  );
  assert(
    !/confirmationHunt\.length \|\| activeActions\.length\)/.test(block),
    "management actions must NOT trigger a diagnostic row",
  );
});

Deno.test("the scan viewer does not render diagnostic rows as scans", () => {
  // THE GUARANTEE IS UNCHANGED; THE MECHANISM IS NOT.
  //
  // This used to pin a CLIENT-side filter: fetch 300 rows with details_json,
  // drop those whose `details_json[0].type === "management_cycle"`, slice to
  // 100. That was replaced because it could not survive its own cost — each
  // row's details_json is ~33 kB, so classifying 300 rows meant detoasting
  // ~28 MB of jsonb the list never renders, and Postgres started killing the
  // query with 57014. The panel then showed a stale cache forever.
  //
  // The filter is now SERVER-side on `pairs_scanned`, which is strictly
  // stronger: diagnostic rows have 0 and every real scan has 1-8, it cannot be
  // defeated by pagination, and it also excludes the game-plan rows the old
  // type check missed entirely (their details_json is an OBJECT, so
  // `details_json[0]?.type` was undefined and they rendered as blank scans).
  const api = Deno.readTextFileSync(
    new URL("../../../src/lib/api.ts", import.meta.url),
  );
  const i = api.indexOf("logs: async () => {");
  assert(i > -1, "the scan list fetch");
  const block = api.slice(i, i + 2600);

  assert(/\.gte\("pairs_scanned", 1\)/.test(block),
    "diagnostic rows are excluded server-side on pairs_scanned");

  // The payload fix is part of the same guarantee: a list that selects
  // details_json is a list that times out and stops updating, which is how
  // diagnostic rows became visible to the user in the first place.
  const select = /\.select\(([^)]*)\)/.exec(block)?.[1] ?? "";
  assert(select.length > 0, "the list still names its columns explicitly");
  assert(!/\*/.test(select), "never select(*) here — details_json comes back with it");
  assert(!/details_json/.test(select),
    "details_json must not be in the LIST query; scanDetail loads it per scan");

  // And the detail fetch that replaced it still exists, or the panel has
  // nothing to render when a scan is opened.
  assert(/scanDetail/.test(api), "per-scan detail fetch");
});

Deno.test("a failed write cannot break the management cycle", () => {
  const ret = scanner.indexOf("if (opts?.isManagementOnly) {");
  const block = scanner.slice(ret, ret + 3000);
  const ins = block.indexOf('from("scan_logs").insert(');
  assert(block.lastIndexOf("try {", ins) > -1, "wrapped in try");
  assert(/observation write failed \(non-fatal\)/.test(block), "and warns rather than throwing");
});

Deno.test("the shape matches a full scan so one query reads both", () => {
  // Existing queries reach details_json->0->'thesisObservations'. Meta must stay
  // at index 0 for a management row too, or they silently miss half the data.
  const ret = scanner.indexOf("if (opts?.isManagementOnly) {");
  const block = scanner.slice(ret, ret + 3000);
  assert(/details_json: \[\{/.test(block), "an array with meta at index 0");
  // And the full-scan meta must carry the new collector as well.
  assert(/^      confirmationHunt,$/m.test(scanner), "full scans record it too");
});
