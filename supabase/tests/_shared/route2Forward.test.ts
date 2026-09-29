/**
 * ROUTE 2 FORWARD VALIDATION — regression suite.
 *
 * WHAT THIS GUARDS. Two structural corrections and the causal record that
 * makes the forward run measurable. The write-path guards matter as much as
 * the unit tests here: the max-hold rule was configured and unreachable for
 * months, and the confirmation-hunt telemetry existed as columns that nothing
 * ever wrote. Unit-testing helpers alone would reproduce exactly that.
 */

import { assertEquals, assertThrows, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ROUTE2_MAX_PENDING_DISTANCE_ATR, ROUTE2_TTL_MINUTES, ROUTE2_MAX_LIFETIME_MINUTES,
  pendingDistanceAtr, passesDistanceGuard, route2ExpiresAt,
  TERMINAL_REASONS, expiryReason, configHash, canonicalJson,
  buildRoute2OrderTelemetry, zoneId, locatePoiFormation, buildPollRecord,
} from "../../functions/_shared/route2Forward.ts";
import { calculateATR } from "../../functions/_shared/smcAnalysis.ts";

const SCANNER = Deno.readTextFileSync(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url));
const ZCS = Deno.readTextFileSync(
  new URL("../../functions/zone-confirmation-scanner/index.ts", import.meta.url));
const MIGRATION = Deno.readTextFileSync(
  new URL("../../migrations/20260929120000_route2_forward_validation.sql", import.meta.url));

// ─── 1-2. the distance guard boundary ───────────────────────────────────────

Deno.test("1 · exactly 1.5 ATR is ACCEPTED (inclusive cap)", () => {
  // The research population was built with `distAtrH1 <= 1.5`. An exclusive
  // cap here would silently measure a different population than the one the
  // 8h TTL was selected on.
  // Exact on values that divide cleanly in binary. Real prices do NOT land
  // exactly on the boundary — see the float-noise test below — but the cap is
  // a research threshold, not a physical constant, so that is acceptable.
  assertEquals(pendingDistanceAtr(2, 5, 2), 1.5);
  assertEquals(passesDistanceGuard(1.5), true);
  assertEquals(passesDistanceGuard(ROUTE2_MAX_PENDING_DISTANCE_ATR), true);
  assertEquals(passesDistanceGuard(1.4999), true);
});

Deno.test("the boundary is not float-exact on real prices, and that is known", () => {
  // 1.1000 -> 1.1015 against an ATR of 0.0010 computes to 1.5000000000000568,
  // which the inclusive cap REJECTS. A setup sitting on the cap to 13 decimal
  // places can fall either side. Documented rather than papered over with an
  // epsilon: the threshold is a research cutoff, not a measured constant.
  const d = pendingDistanceAtr(1.1000, 1.1015, 0.0010)!;
  assert(Math.abs(d - 1.5) < 1e-12, `expected ~1.5, got ${d}`);
  assert(d !== 1.5, "real prices do not land exactly on the boundary");
});

Deno.test("2 · above 1.5 ATR is REJECTED", () => {
  assertEquals(passesDistanceGuard(1.5001), false);
  assertEquals(passesDistanceGuard(2.4), false);   // the measured median
  assertEquals(passesDistanceGuard(5.64), false);  // the measured p90
});

Deno.test("an unmeasurable distance FAILS, never passes by default", () => {
  // Admitting an order whose distance could not be computed would restore the
  // unbounded tail the guard exists to remove, and do it silently.
  assertEquals(pendingDistanceAtr(1.1, 1.2, null), null);
  assertEquals(pendingDistanceAtr(1.1, 1.2, 0), null);
  assertEquals(pendingDistanceAtr(1.1, 1.2, -1), null);
  assertEquals(pendingDistanceAtr(NaN, 1.2, 0.001), null);
  assertEquals(passesDistanceGuard(null), false);
  assertEquals(passesDistanceGuard(NaN), false);
});

Deno.test("the guard rejects — it never moves the entry price", () => {
  // Static guard: a fix that "pulled the entry closer" would silently change
  // the strategy's geometry, which this task forbids.
  const block = SCANNER.slice(SCANNER.indexOf("ROUTE 2 DISTANCE GUARD"),
    SCANNER.indexOf("Place a pending limit order instead"));
  assert(/passesDistanceGuard\(r2DistanceAtr\)/.test(block), "guard must be called");
  assert(/continue;/.test(block), "failing the guard must skip the setup");
  assert(!/limitEntry\.price\s*=/.test(block), "guard must not reassign the entry price");
  assert(!/limitEntry\s*=\s*\{/.test(block), "guard must not substitute a zone");
});

// ─── 3-4. ATR, both asset classes ───────────────────────────────────────────

/** Production's own calculateATR — the guard must use the same definition. */
const bars = (n: number, hi: number, lo: number, close: number) =>
  Array.from({ length: n }, (_, i) => ({
    datetime: new Date(Date.UTC(2026, 8, 1, i)).toISOString(),
    open: close, high: hi, low: lo, close, volume: 0,
  }));

Deno.test("3 · FX ATR feeds the guard in price units, not pips", () => {
  // 20 bars of a constant 10-pip range → ATR = 0.0010 on a 5-dp pair.
  const fx = bars(20, 1.1010, 1.1000, 1.1005);
  const atr = calculateATR(fx, 14);
  assertEquals(Math.round(atr * 1e6) / 1e6, 0.001);
  // 14 pips away is 1.4 ATR — accepted.
  assertEquals(passesDistanceGuard(pendingDistanceAtr(1.1005, 1.1019, atr)), true);
  // 30 pips away is 3.0 ATR — rejected.
  assertEquals(passesDistanceGuard(pendingDistanceAtr(1.1005, 1.1035, atr)), false);
});

Deno.test("4 · crypto ATR works on a price scale three orders larger", () => {
  // The whole point of an ATR cap rather than a pip cap: BTC pip = 1,
  // ETH pip = 0.01, FX pip = 0.0001. Pips are not comparable; ATR is.
  const btc = bars(20, 84500, 84100, 84300);
  const atr = calculateATR(btc, 14);
  assertEquals(Math.round(atr), 400);
  assertEquals(passesDistanceGuard(pendingDistanceAtr(84300, 84860, atr)), true);   // 1.4
  assertEquals(passesDistanceGuard(pendingDistanceAtr(84300, 85100, atr)), false);  // 2.0
  // Same ratio, wildly different absolute distances — FX 14 pips vs BTC 560 pts.
  assertEquals(pendingDistanceAtr(84300, 84860, atr), 1.4);
});

// ─── 5-6. TTL and the refresh leak ──────────────────────────────────────────

Deno.test("5 · expiry is exactly 8 hours from creation", () => {
  assertEquals(ROUTE2_TTL_MINUTES, 480);
  assertEquals(route2ExpiresAt("2026-09-29T10:00:00.000Z"), "2026-09-29T18:00:00.000Z");
  // Crossing a day boundary must not wrap.
  assertEquals(route2ExpiresAt("2026-09-29T20:30:00.000Z"), "2026-09-30T04:30:00.000Z");
  assertThrows(() => route2ExpiresAt("not-a-time"));
});

Deno.test("6 · refresh-in-place does NOT extend expires_at", () => {
  // The old refresh reset expires_at to now+TTL on every re-detection, so a
  // persistently re-detected zone never expired. Tolerable at 60 minutes;
  // unbounded at 8 hours. Guarded statically because the leak lives in the
  // scanner's UPDATE, not in a helper.
  const start = SCANNER.indexOf("expires_at is DELIBERATELY NOT REFRESHED");
  assert(start > -1, "the refresh block must document the fixed-window policy");
  const block = SCANNER.slice(start, start + 1200);
  const update = block.slice(block.indexOf('from("pending_orders").update('),
    block.indexOf(".in(\"order_id\""));
  assert(!/expires_at/.test(update),
    "refresh must not write expires_at — that is the infinite-TTL leak");
  assert(/signal_score|stop_loss|take_profit/.test(update),
    "refresh should still update the mutable risk levels");
});

Deno.test("max practical lifetime equals the TTL — refresh cannot exceed it", () => {
  assertEquals(ROUTE2_MAX_LIFETIME_MINUTES, ROUTE2_TTL_MINUTES);
  assertEquals(ROUTE2_MAX_LIFETIME_MINUTES / 60, 8);
});

Deno.test("the scalper 60-minute cap is bypassed for Route 2, deliberately", () => {
  // stylePendingExpiryMinutes clamps a scalper to min(configured, 60), so the
  // configured value cannot express an 8h Route 2 TTL.
  const block = SCANNER.slice(SCANNER.indexOf("TTL: 8h, FIXED FROM CREATION"),
    SCANNER.indexOf("Recalculate SL/TP relative to the limit entry"));
  assert(/ROUTE2_TTL_MINUTES/.test(block), "Route 2 must use the registered TTL constant");
  assert(/route2ExpiresAt\(r2PlacedAt\)/.test(block), "expiry must derive from the creation instant");
  // Check for a CALL, not a mention — the comment above names the function.
  assert(!/stylePendingExpiryMinutes\s*\(/.test(block), "the style cap must not clamp Route 2's TTL");
});

// ─── 7. Zone Story is observational ─────────────────────────────────────────

Deno.test("7 · Zone Story cannot gate Route 2", () => {
  // It is persisted at four lifecycle points and consulted at none.
  for (const col of ["zone_story_at_creation", "zone_story_at_touch",
    "zone_story_at_confirmation", "zone_story_at_fill"]) {
    assert(MIGRATION.includes(col), `${col} must exist`);
  }
  assert(/OBSERVATIONAL ONLY/.test(MIGRATION), "the column must be documented as observational");
  // No control flow anywhere may branch on a zone-story value.
  for (const [name, src] of [["bot-scanner", SCANNER], ["zone-confirm", ZCS]] as const) {
    assert(!/if\s*\([^)]*zone_story/.test(src), `${name}: zone story must not appear in a condition`);
    assert(!/zoneStory[^:,)\s]*\s*(>|<|>=|<=|===|!==)/.test(src),
      `${name}: zone story must not be compared against a threshold`);
  }
});

// ─── 8. the poll log ────────────────────────────────────────────────────────

Deno.test("8 · a skipped poll is RECORDED, not silent", () => {
  // candles_available = 0 is the whole point: a refused fetch that leaves no
  // trace is indistinguishable from "nothing happened", and that ambiguity is
  // why the historical lifecycle cannot be replayed.
  const r = buildPollRecord({
    pendingId: "abc", pollTimestamp: "2026-09-29T10:00:00.000Z",
    pollerName: "bot-scanner", candlesAvailable: 0, currentPrice: null,
    statusBefore: "pending", branchTaken: "no_candles_skipped", statusAfter: "pending",
  });
  assertEquals(r.candles_available, 0);
  assertEquals(r.branch_taken, "no_candles_skipped");
  assertEquals(r.zone_touch_detected, false);
  assertEquals(r.confirmation_checked, false);
});

Deno.test("8b · both pollers write the log, on every lifecycle branch", () => {
  for (const [name, src, min] of [["bot-scanner", SCANNER, 6], ["zone-confirm", ZCS, 7]] as const) {
    const n = (src.match(/buildPollRecord\(/g) ?? []).length;
    assert(n >= min, `${name}: expected >= ${min} poll-log call sites, found ${n}`);
    assert(/from\("route2_poll_log"\)\.insert\(/.test(src), `${name}: must flush the poll log`);
    assert(/branchTaken: `error:/.test(src), `${name}: a throwing order must still be recorded`);
  }
  // Two pollers with different check-sets — the record must say which acted.
  assert(/pollerName: "bot-scanner"/.test(SCANNER));
  assert(/pollerName: "zone-confirmation-scanner"/.test(ZCS));
});

Deno.test("8c · EVERY poll emits a row, enforced by finally", () => {
  // The interesting branches are wired individually, but the commonest
  // outcome — still pending, price has not reached the zone — emitted
  // nothing, so an order under active watch was indistinguishable from one
  // nothing looked at. Verified live: one pending order, 0 poll rows.
  //
  // `finally` is what makes it airtight: a `continue` runs it on the way out,
  // so a branch added later cannot silently escape the log.
  for (const [name, src] of [["bot-scanner", SCANNER], ["zone-confirm", ZCS]] as const) {
    assert(/const pollMark = \w+\.length;/.test(src), `${name}: must mark the row count per order`);
    assert(/\} finally \{[\s\S]{0,400}?length === pollMark[\s\S]{0,400}?buildPollRecord\(/.test(src),
      `${name}: finally must emit a fallback row when no branch did`);
  }
});

Deno.test("the poll log is append-only at the database level", () => {
  assert(/route2_poll_log is append-only/.test(MIGRATION), "trigger must raise on mutation");
  assert(/before update or delete on public\.route2_poll_log/.test(MIGRATION));
});

// ─── 9. terminal reasons ────────────────────────────────────────────────────

Deno.test("9 · terminal reasons are typed and classified, not free text", () => {
  assertEquals(expiryReason(false), "EXPIRED_NEVER_TOUCHED");
  assertEquals(expiryReason(true), "EXPIRED_AFTER_TOUCH_NO_CONFIRMATION");
  // Every enum member must be permitted by the database constraint.
  const check = MIGRATION.slice(MIGRATION.indexOf("pending_orders_terminal_reason_valid"),
    MIGRATION.indexOf("pending_orders_entry_source_valid"));
  for (const r of TERMINAL_REASONS) {
    assert(check.includes(`'${r}'`), `${r} missing from the CHECK constraint`);
  }
});

Deno.test("every terminal write sets a typed reason", () => {
  // cancel_reason is free text for humans; the analysis reads terminal_reason.
  const both = SCANNER + ZCS;
  for (const r of ["CANCELLED_SL_INVALIDATION", "CANCELLED_IMPULSE_BROKEN",
    "CANCELLED_POSITION_CAP", "CANCELLED_SUPERSEDED", "CANCELLED_REFINED_ZONE_FAILURE",
    "CANCELLED_DIRECTION_FLIP", "FILLED"]) {
    assert(both.includes(`"${r}"`), `no write path sets ${r}`);
  }
  assert(/terminal_reason: expiryReason\(/.test(SCANNER), "expiry must classify touched vs never-touched");
});

// ─── 10. config versioning ──────────────────────────────────────────────────

Deno.test("10 · config_hash is stable under key order and sensitive to value change", () => {
  // A mutable bot_configs row with only updated_at could not attribute 11 of
  // 35 live orders to a config. The hash is the fix; it must be deterministic.
  assertEquals(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assertEquals(configHash({ a: 1, b: { c: [1, 2] } }), configHash({ b: { c: [1, 2] }, a: 1 }));
  assert(configHash({ minConfluence: 40 }) !== configHash({ minConfluence: 41 }));
  assertEquals(configHash({ a: 1 }).length, 16);
  // Nested key order too, not just the top level.
  assertEquals(configHash({ x: { p: 1, q: 2 } }), configHash({ x: { q: 2, p: 1 } }));
});

Deno.test("config_hash is persisted on the order and its body is archived", () => {
  assert(/const _configHash = configHash\(config\)/.test(SCANNER), "hash must be computed per scan");
  assert(/from\("bot_config_history"\)\.upsert\(/.test(SCANNER), "the body must be archived");
  assert(/configHash: _configHash/.test(SCANNER), "the order must carry the hash");
  assert(/unique \(bot_id, config_hash\)/.test(MIGRATION), "one row per distinct config");
});

// ─── 11. order telemetry ────────────────────────────────────────────────────

Deno.test("11 · the creation record carries every required field", () => {
  const t = buildRoute2OrderTelemetry({
    zoneId: "EUR/USD|1H|long|1.1|1.102", zoneTimeframe: "1H",
    zoneCreatedAt: "2026-09-29T00:00:00.000Z", pendingCreatedAt: "2026-09-29T08:00:00.000Z",
    entrySource: "refinedEntry", pendingEntryPrice: 1.1010, currentPriceAtCreation: 1.1000,
    h1Atr: 0.0010, distanceAtr: 1.0, initialStopLoss: 1.0990, initialTakeProfit: 1.1050,
    configHash: "deadbeefdeadbeef", zoneStory: { state: "triggered" },
    wouldHaveBeenRoute1: false,
  });
  assertEquals(t.zone_age_minutes, 480);          // 8h old at creation
  assertEquals(t.entry_source, "refinedEntry");
  assertEquals(t.pending_distance_atr, 1.0);
  assertEquals(t.expiry_policy, "fixed_from_creation");
  assertEquals(t.strategy_version, "smc-zone-impulse-control-v1");
  assertEquals(t.initial_stop_loss, 1.0990);
  assert(t.zone_story_at_creation !== null);
  // An unlocatable zone yields a null age, never a guessed one.
  const u = buildRoute2OrderTelemetry({
    zoneId: null, zoneTimeframe: null, zoneCreatedAt: null,
    pendingCreatedAt: "2026-09-29T08:00:00.000Z", entrySource: "zoneMid",
    pendingEntryPrice: 1, currentPriceAtCreation: 1, h1Atr: null, distanceAtr: null,
    initialStopLoss: null, initialTakeProfit: null, configHash: "x", zoneStory: null,
    wouldHaveBeenRoute1: true,
  });
  assertEquals(u.zone_age_minutes, null);
  assertEquals(u.would_have_been_route1, true);
});

Deno.test("the two strata stay separable once Route 1 is switched off", () => {
  // Disabling marketFillAtZone does not delete Route 1's setups; it reroutes
  // them into Route 2, where they sit at ~0 ATR and arrive almost at once.
  // Measured over 180 days they are ~45% of the forward-eligible population,
  // so without this flag they would silently inflate the fill rate relative
  // to what the TTL research predicts.
  assert(/wouldHaveBeenRoute1: priceIsAtValidatedZone && priceOnCorrectSide/.test(SCANNER),
    "the Route 1 arming condition must be recorded at creation");
  assert(/would_have_been_route1/.test(MIGRATION), "and persisted");
});

Deno.test("zone id is stable across re-detection of the same zone", () => {
  // Float noise across scans must not mint a new id, or every refresh looks
  // like a new zone and zone age resets.
  const a = zoneId("EUR/USD", "1H", "long", 1.10234567, 1.10012345);
  const b = zoneId("EUR/USD", "1H", "long", 1.102345671, 1.100123451);
  assertEquals(a, b);
  assert(a !== zoneId("EUR/USD", "1H", "short", 1.10234567, 1.10012345));
  assert(a !== zoneId("GBP/USD", "1H", "long", 1.10234567, 1.10012345));
});

Deno.test("POI formation is located exactly, or reported null", () => {
  // OB bounds are wick-halved (obZoneWithWicks), not the raw candle range —
  // matching on high/low would find nothing.
  const c = { datetime: "2026-09-29T03:00:00.000Z", open: 1.1000, close: 1.1020, high: 1.1040, low: 1.0990, volume: 0 };
  const series = [
    { datetime: "2026-09-29T01:00:00.000Z", open: 1, close: 1, high: 1, low: 1, volume: 0 },
    { datetime: "2026-09-29T02:00:00.000Z", open: 1, close: 1, high: 1, low: 1, volume: 0 },
    c,
  ];
  const obHigh = 1.1020 + (1.1040 - 1.1020) * 0.5;   // 1.1030
  const obLow = 1.1000 - (1.1000 - 1.0990) * 0.5;    // 1.0995
  assertEquals(locatePoiFormation(series, "ob", obHigh, obLow), c.datetime);
  // A bullish FVG is recorded on the MIDDLE candle.
  const f = [
    { datetime: "2026-09-29T01:00:00.000Z", open: 1, close: 1, high: 1.1000, low: 0.9, volume: 0 },
    { datetime: "2026-09-29T02:00:00.000Z", open: 1, close: 1.1, high: 1.2, low: 1, volume: 0 },
    { datetime: "2026-09-29T03:00:00.000Z", open: 1, close: 1, high: 1.3, low: 1.1050, volume: 0 },
  ];
  assertEquals(locatePoiFormation(f, "fvg", 1.1050, 1.1000), "2026-09-29T02:00:00.000Z");
  assertEquals(locatePoiFormation(series, "ob", 9.9, 9.8), null);
  assertEquals(locatePoiFormation([], "ob", 1, 0.9), null);
});

// ─── 12. route2_pending telemetry survives to history ───────────────────────

Deno.test("12 · both Route 2 fill paths still stamp route2_pending", () => {
  // The immutable entry block is what makes realized R computable at all;
  // this task must not have disturbed it.
  assert(/route:\s*"route2_pending"/.test(SCANNER), "bot-scanner pending fill");
  assert(/route:\s*"route2_pending"/.test(ZCS), "zone-confirmation fill");
  assert(/\.\.\.r2Telemetry/.test(SCANNER), "bot-scanner must spread the entry telemetry");
  assert(/\.\.\.zcTelemetry/.test(ZCS), "zone-confirm must spread the entry telemetry");
  assert(/\.\.\.carryToHistory\(/.test(SCANNER), "the archive must carry it to history");
  // ...and the new Route 2 record must reach the insert, not just be built.
  assert(/\.\.\.r2Telem,/.test(SCANNER), "the pending insert must spread the Route 2 record");
});

// ─── 13. paper / live isolation ─────────────────────────────────────────────

Deno.test("13 · nothing added here can reach broker execution", () => {
  // Every broker mirror stays gated on execution_mode === "live", and the
  // Route 2 module neither reads nor writes that field.
  const modRaw = Deno.readTextFileSync(
    new URL("../../functions/_shared/route2Forward.ts", import.meta.url));
  // Strip comments: the module's own header explains that execution mode is
  // gated elsewhere, and a naive match would flag that prose as code.
  const mod = modRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert(!/execution_mode/.test(mod), "the Route 2 module must not touch execution mode");
  assert(!/broker|metaapi|oanda|mirror/i.test(mod), "the Route 2 module must not reach a broker");
  assert(!/fetch\s*\(/.test(mod), "the Route 2 module must make no network calls");
  // Same treatment for the migration: its header documents where execution
  // mode IS gated, and that prose is not a code path.
  const migSql = MIGRATION.replace(/^\s*--.*$/gm, "");
  assert(!/execution_mode/.test(migSql), "the migration must not touch execution mode");
  assert(!/broker_connections|paper_accounts/.test(migSql),
    "the migration must not touch the account or broker tables");
  // The fill-path mirror gate is unchanged in both functions.
  assert(/account\.execution_mode === "live"/.test(SCANNER));
  assert(/account\.execution_mode === "live" && brokerConnections\.length > 0/.test(ZCS));
});

Deno.test("Route 1 is untouched by this change", () => {
  // Route 1 is retired by research verdict. It must be neither altered nor
  // enabled here. Its market-fill path keeps its own telemetry and gate.
  assert(/route:\s*"route1_market"/.test(SCANNER), "Route 1 entry telemetry intact");
  assert(/const useMarketFillAtZone = priceIsAtValidatedZone && config\.marketFillAtZone/.test(SCANNER),
    "the Route 1 gate expression must be unchanged");
  // The distance guard lives strictly inside the Route 2 branch.
  const guardIdx = SCANNER.indexOf("ROUTE 2 DISTANCE GUARD");
  const branchIdx = SCANNER.indexOf("if (effectiveLimitEnabled && limitEntry) {");
  assert(guardIdx > branchIdx && guardIdx - branchIdx < 400,
    "the guard must sit inside the Route 2 branch, not on the shared path");
});
