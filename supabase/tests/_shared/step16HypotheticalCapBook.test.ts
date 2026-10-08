/**
 * STEP 16-B — cap-adjusted dry-run reporting (hypotheticalCapBook.ts).
 *
 * Synthetic: overlapping symbols, global-cap saturation, resolved positions
 * freeing slots, simultaneous timestamps, blocked fills holding no slot,
 * totals, raw input untouched, correlation (placement time), config classes.
 * Production fixtures: the 3 attributed GBP/USD fills and the 7-fill dry-run
 * sample from the Step 16 audit. Source pins: the live rules this mirrors.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCapBook, type CapBookFill, configClassOf, CONFIG_EQUIVALENCE_CLASSES, correlationVerdict, sortFills,
} from "../../functions/_shared/hypotheticalCapBook.ts";

const CFG = "3d5b8fb0d756b3596ed46d133e873a88";
const T = (iso: string) => Date.parse(iso);
let seq = 0;
function fill(over: Partial<CapBookFill> & { symbol: string; filled: string }): CapBookFill {
  seq++;
  const { filled, ...rest } = over as any;
  return {
    signalId: `sig-${String(seq).padStart(3, "0")}`, orderId: `ord${seq}`, direction: "long",
    placedAtMs: T(filled) - 600_000, filledAtMs: T(filled), closedAtMs: null, exitReason: null,
    rGross: null, rNet: null, pnlUsd: null, riskUsd: 500, configVersion: CFG, ...rest,
  };
}
const closed = (f: CapBookFill, iso: string, rGross: number, rNet: number) =>
  ({ ...f, closedAtMs: T(iso), exitReason: rGross < 0 ? "hypothetical_stop" : "hypothetical_target", rGross, rNet, pnlUsd: rGross * 500 });
const NOW = T("2026-10-08T01:00:00Z");
const byId = (rep: ReturnType<typeof buildCapBook>) => Object.fromEntries(rep.rows.map((r) => [r.fill.signalId, r]));

Deno.test("overlapping symbol: a second fill while the first is open is blocked_by_symbol_cap, naming the blocker", () => {
  const a = fill({ symbol: "GBP/USD", filled: "2026-10-07T10:00:00Z" });
  const b = fill({ symbol: "GBP/USD", filled: "2026-10-07T11:00:00Z" });
  const c = fill({ symbol: "EUR/USD", filled: "2026-10-07T11:30:00Z" });
  const r = byId(buildCapBook([b, c, a], { nowMs: NOW }));
  assertEquals(r[a.signalId].caps.status, "admissible");
  assertEquals(r[b.signalId].caps, { status: "blocked", reason: "blocked_by_symbol_cap", blockedBy: [{ signalId: a.signalId, orderId: a.orderId }] });
  assertEquals(r[c.signalId].caps.status, "admissible", "another symbol is unaffected");
});

Deno.test("global-cap saturation: a 4th concurrent symbol is blocked_by_global_cap, listing all 3 open fills; global is checked before symbol", () => {
  const f1 = fill({ symbol: "EUR/USD", filled: "2026-10-07T10:00:00Z" });
  const f2 = fill({ symbol: "USD/JPY", filled: "2026-10-07T10:05:00Z" });
  const f3 = fill({ symbol: "CHF/JPY", filled: "2026-10-07T10:10:00Z" });
  const f4 = fill({ symbol: "NZD/CAD", filled: "2026-10-07T10:15:00Z" });
  const f5 = fill({ symbol: "EUR/USD", filled: "2026-10-07T10:20:00Z" }); // both caps full → global reported
  const r = byId(buildCapBook([f1, f2, f3, f4, f5], { nowMs: NOW }));
  assertEquals(r[f4.signalId].caps.reason, "blocked_by_global_cap");
  assertEquals(r[f4.signalId].caps.blockedBy.map((b) => b.signalId), [f1.signalId, f2.signalId, f3.signalId]);
  assertEquals(r[f5.signalId].caps.reason, "blocked_by_global_cap");
});

Deno.test("a resolved position frees its slot at closed_at (closed exactly at the next fill counts as free)", () => {
  const a = closed(fill({ symbol: "GBP/USD", filled: "2026-10-07T10:00:00Z" }), "2026-10-07T11:00:00Z", -1, -1.06);
  const atClose = fill({ symbol: "GBP/USD", filled: "2026-10-07T11:00:00Z" });
  const r1 = byId(buildCapBook([a, atClose], { nowMs: NOW }));
  assertEquals(r1[atClose.signalId].caps.status, "admissible");
  const b = closed(fill({ symbol: "GBP/USD", filled: "2026-10-07T12:00:00Z" }), "2026-10-07T13:00:00Z", 1.1, 1.04);
  const during = fill({ symbol: "GBP/USD", filled: "2026-10-07T12:59:59Z" });
  const r2 = byId(buildCapBook([b, during], { nowMs: NOW }));
  assertEquals(r2[during.signalId].caps.reason, "blocked_by_symbol_cap");
  // global slots free the same way
  const g = [0, 1, 2].map((i) => closed(fill({ symbol: ["EUR/USD", "USD/JPY", "CHF/JPY"][i], filled: `2026-10-07T0${i}:00:00Z` }), "2026-10-07T05:00:00Z", -1, -1));
  const after = fill({ symbol: "NZD/CHF", filled: "2026-10-07T05:00:00Z" });
  assertEquals(byId(buildCapBook([...g, after], { nowMs: NOW }))[after.signalId].caps.status, "admissible");
});

Deno.test("an unresolved fill holds its slot through now", () => {
  const a = fill({ symbol: "USD/JPY", filled: "2026-10-07T10:00:00Z" });
  const later = fill({ symbol: "USD/JPY", filled: "2026-10-08T00:59:00Z" });
  const rep = buildCapBook([a, later], { nowMs: NOW });
  assertEquals(byId(rep)[later.signalId].caps.reason, "blocked_by_symbol_cap");
  assertEquals(rep.raw.open, 2);
});

Deno.test("simultaneous fills: earlier placement wins, then signal id; the result does not depend on input order", () => {
  const t = "2026-10-07T10:00:02Z";
  const lateOrder = fill({ symbol: "GBP/USD", filled: t, placedAtMs: T("2026-10-07T09:50:00Z"), signalId: "sig-aaa" });
  const earlyOrder = fill({ symbol: "GBP/USD", filled: t, placedAtMs: T("2026-10-07T09:40:00Z"), signalId: "sig-zzz" });
  for (const input of [[lateOrder, earlyOrder], [earlyOrder, lateOrder]]) {
    const r = byId(buildCapBook(input, { nowMs: NOW }));
    assertEquals(r["sig-zzz"].caps.status, "admissible", "placed first (the live hunt processes by placed_at)");
    assertEquals(r["sig-aaa"].caps.blockedBy[0].signalId, "sig-zzz");
  }
  const x = fill({ symbol: "EUR/USD", filled: t, placedAtMs: T("2026-10-07T09:40:00Z"), signalId: "sig-b" });
  const y = fill({ symbol: "EUR/USD", filled: t, placedAtMs: T("2026-10-07T09:40:00Z"), signalId: "sig-a" });
  assertEquals(sortFills([x, y]).map((f) => f.signalId), ["sig-a", "sig-b"], "full tie → signal id");
});

Deno.test("a blocked fill holds no slot (per symbol and globally)", () => {
  const a = closed(fill({ symbol: "GBP/USD", filled: "2026-10-07T10:00:00Z" }), "2026-10-07T12:00:00Z", -1, -1);
  const blocked = closed(fill({ symbol: "GBP/USD", filled: "2026-10-07T11:00:00Z" }), "2026-10-07T15:00:00Z", 1.1, 1.0);
  const c = fill({ symbol: "GBP/USD", filled: "2026-10-07T13:00:00Z" }); // A closed; the blocked fill would still be "open" if it held a slot
  const r = byId(buildCapBook([a, blocked, c], { nowMs: NOW }));
  assertEquals(r[blocked.signalId].caps.reason, "blocked_by_symbol_cap");
  assertEquals(r[c.signalId].caps.status, "admissible");
  // global: two admitted + one symbol-blocked → a third symbol still fits
  const g1 = fill({ symbol: "EUR/USD", filled: "2026-10-07T10:00:00Z" });
  const g2 = fill({ symbol: "USD/JPY", filled: "2026-10-07T10:01:00Z" });
  const gb = fill({ symbol: "USD/JPY", filled: "2026-10-07T10:02:00Z" });
  const g3 = fill({ symbol: "CHF/JPY", filled: "2026-10-07T10:03:00Z" });
  const rg = byId(buildCapBook([g1, g2, gb, g3], { nowMs: NOW }));
  assertEquals([rg[gb.signalId].caps.reason, rg[g3.signalId].caps.status], ["blocked_by_symbol_cap", "admissible"]);
});

Deno.test("totals: raw vs cap-adjusted sums over resolved fills; net P/L = R net × risk dollars; open and missing values reported", () => {
  const a = closed(fill({ symbol: "CHF/JPY", filled: "2026-10-07T01:00:00Z" }), "2026-10-07T08:00:00Z", -1, -1.06);
  const b = closed(fill({ symbol: "CHF/JPY", filled: "2026-10-07T02:00:00Z" }), "2026-10-07T08:00:00Z", -1, -1.06); // blocked by a
  const c = { ...closed(fill({ symbol: "USD/JPY", filled: "2026-10-07T03:00:00Z" }), "2026-10-07T04:00:00Z", 1.1, 0), rNet: null };
  const d = fill({ symbol: "EUR/USD", filled: "2026-10-07T05:00:00Z" }); // open
  const rep = buildCapBook([a, b, c, d], { nowMs: NOW });
  assertEquals([rep.raw.fills, rep.raw.resolved, rep.raw.open], [4, 3, 1]);
  assertEquals(Math.round(rep.raw.grossR * 1e9) / 1e9, -0.9);
  assertEquals(Math.round(rep.raw.netR * 1e9) / 1e9, -2.12);
  assertEquals(rep.raw.missingNet, 1);
  assertEquals(Math.round(rep.raw.pnlUsd * 100) / 100, -450);
  assertEquals(Math.round(rep.raw.pnlNetUsd * 100) / 100, -1060);
  assertEquals([rep.capAdjusted.fills, rep.capAdjusted.blocked, rep.capAdjusted.resolved], [3, 1, 2]);
  assertEquals(Math.round(rep.capAdjusted.grossR * 1e9) / 1e9, 0.1);
  assertEquals(Math.round(rep.capAdjusted.pnlNetUsd * 100) / 100, -530);
});

Deno.test("raw input is never modified", () => {
  const input = [
    closed(fill({ symbol: "GBP/USD", filled: "2026-10-07T10:00:00Z" }), "2026-10-07T11:00:00Z", -1, -1.06),
    fill({ symbol: "GBP/USD", filled: "2026-10-07T10:30:00Z" }),
  ];
  const before = JSON.stringify(input);
  const rep = buildCapBook(input, { nowMs: NOW });
  assertEquals(JSON.stringify(input), before);
  assertEquals(rep.rows[0].fill, input[0], "rows carry the raw fill unchanged");
});

Deno.test("correlation (caps+correlation model only): EUR/USD↔GBP/USD opposite directions open at PLACEMENT → hedge block; same direction allowed; a later partner fill is not re-checked", () => {
  const eur = fill({ symbol: "EUR/USD", filled: "2026-10-07T10:00:00Z", direction: "long" });
  const gbpShort = fill({ symbol: "GBP/USD", filled: "2026-10-07T11:00:00Z", placedAtMs: T("2026-10-07T10:30:00Z"), direction: "short" });
  const r = byId(buildCapBook([eur, gbpShort], { nowMs: NOW }));
  assertEquals(r[gbpShort.signalId].caps.status, "admissible", "caps alone do not see correlation");
  assertEquals(r[gbpShort.signalId].limits.reason, "blocked_by_correlation_hedge");
  assertEquals(r[gbpShort.signalId].limits.blockedBy[0].signalId, eur.signalId);

  const gbpLong = fill({ symbol: "GBP/USD", filled: "2026-10-07T11:00:00Z", placedAtMs: T("2026-10-07T10:30:00Z"), direction: "long" });
  assertEquals(byId(buildCapBook([eur, gbpLong], { nowMs: NOW }))[gbpLong.signalId].limits.status, "admissible", "1 doubling < max 2");

  const placedBefore = fill({ symbol: "GBP/USD", filled: "2026-10-07T11:00:00Z", placedAtMs: T("2026-10-07T09:00:00Z"), direction: "short" });
  assertEquals(byId(buildCapBook([eur, placedBefore], { nowMs: NOW }))[placedBefore.signalId].limits.status, "admissible", "placement-time only");

  const noPlacement = fill({ symbol: "GBP/USD", filled: "2026-10-07T11:00:00Z", placedAtMs: null, direction: "short" });
  const rn = byId(buildCapBook([eur, noPlacement], { nowMs: NOW }))[noPlacement.signalId];
  assertEquals([rn.limits.status, rn.limits.correlation], ["admissible", "correlation_not_evaluable"]);

  // the six live pairs: only EUR/USD↔GBP/USD reaches 0.8 in the static matrix
  const P = ["EUR/USD", "GBP/USD", "USD/JPY", "CHF/JPY", "NZD/CAD", "NZD/CHF"];
  const blocking: string[] = [];
  for (const a of P) for (const b of P) {
    if (a === b) continue;
    for (const da of ["long", "short"] as const) for (const dbn of ["long", "short"] as const) {
      const v = correlationVerdict(fill({ symbol: a, filled: "2026-10-07T12:00:00Z", direction: da }), [fill({ symbol: b, filled: "2026-10-07T11:00:00Z", direction: dbn })], 0.8, 2);
      if (v.status === "blocked") blocking.push(`${a} ${da} vs ${b} ${dbn}`);
    }
  }
  assertEquals(blocking.sort(), ["EUR/USD long vs GBP/USD short", "EUR/USD short vs GBP/USD long", "GBP/USD long vs EUR/USD short", "GBP/USD short vs EUR/USD long"]);
});

Deno.test("config classes: totals pool only registered behaviour-equivalent versions; others stay separate", () => {
  assertEquals(configClassOf(CFG), "frozen_impulse_route2_v1");
  assertEquals(Object.values(CONFIG_EQUIVALENCE_CLASSES).flat(), [CFG, "1037e6170289f865e4d6618dcf28b94d"],
    "Step 16-E registered its behaviour-equivalent hash, with its proof (step16eExplicitDefaults.test.ts)");
  assertEquals(configClassOf("1037e6170289f865e4d6618dcf28b94d"), "frozen_impulse_route2_v1");
  const a = fill({ symbol: "GBP/USD", filled: "2026-10-07T10:00:00Z" });
  const b = fill({ symbol: "EUR/USD", filled: "2026-10-07T10:05:00Z", configVersion: "ffffffffffffffffffffffffffffffff" });
  const rep = buildCapBook([a, b], { nowMs: NOW });
  assertEquals(rep.singleClass, false);
  assertEquals(Object.keys(rep.byClass).sort(), ["frozen_impulse_route2_v1", "unregistered:ffffffffffffffffffffffffffffffff"]);
});

// ── production fixtures ─────────────────────────────────────────────────────

Deno.test("production: the 3 attributed GBP/USD dry-run fills → 1 admissible, 2 blocked by 088f22f7/4d8eab45", () => {
  const mk = (signalId: string, orderId: string, placed: string, filled: string, riskUsd: number): CapBookFill => ({
    signalId, orderId, symbol: "GBP/USD", direction: "long", placedAtMs: T(placed), filledAtMs: T(filled), closedAtMs: null,
    exitReason: null, rGross: null, rNet: null, pnlUsd: null, riskUsd, configVersion: CFG,
  });
  const rows = [
    mk("088f22f7-af69-488d-af0f-f427cbab3a5b", "4d8eab45", "2026-10-07T18:10:05.416Z", "2026-10-07T18:22:01.916Z", 499.245),
    mk("4be9b5c9-b2d8-4b9f-b276-13654450d5e9", "896572f4", "2026-10-07T18:50:06.118Z", "2026-10-07T18:52:03.851Z", 497.725),
    mk("fff2ae4e-d32c-4ab4-acae-9243c50f12f5", "3758fd3a", "2026-10-07T19:00:05.730Z", "2026-10-07T22:42:02.646Z", 498.995),
  ];
  const rep = buildCapBook(rows, { nowMs: T("2026-10-08T01:30:00Z") });
  assertEquals(rep.rows.map((r) => r.caps.status), ["admissible", "blocked", "blocked"]);
  for (const r of rep.rows.slice(1)) {
    assertEquals(r.caps.reason, "blocked_by_symbol_cap");
    assertEquals(r.caps.blockedBy, [{ signalId: "088f22f7-af69-488d-af0f-f427cbab3a5b", orderId: "4d8eab45" }]);
    assertEquals(r.limits.reason, "blocked_by_symbol_cap", "correlation adds nothing: no EUR/USD fill");
  }
  assertEquals([rep.raw.fills, rep.capAdjusted.fills, rep.capAdjusted.blocked, rep.raw.resolved], [3, 1, 2, 0]);
});

Deno.test("production: the audit's 7-fill dry-run sample → raw −1.85R, cap-adjusted −0.85R, 3 blocked", () => {
  const S = [
    ["2dee2910", "USD/JPY", "short", "2026-10-06T23:10:07.614Z", "2026-10-06T23:20:03.039Z", "2026-10-07T00:20:00Z", -1],
    ["77134ab8", "CHF/JPY", "long", "2026-10-07T00:10:06.696Z", "2026-10-07T01:33:02.565Z", "2026-10-07T08:00:00Z", -1],
    ["02eb7948", "CHF/JPY", "long", "2026-10-07T01:40:05.921Z", "2026-10-07T07:34:02.134Z", "2026-10-07T08:00:00Z", -1],
    ["bcf0216f", "CHF/JPY", "short", "2026-10-07T13:10:13.257Z", "2026-10-07T14:52:02.112Z", "2026-10-07T15:45:00Z", 1.1520508769742777],
    ["4d8eab45", "GBP/USD", "long", "2026-10-07T18:10:05.416Z", "2026-10-07T18:22:01.916Z", null, null],
    ["896572f4", "GBP/USD", "long", "2026-10-07T18:50:06.118Z", "2026-10-07T18:52:03.851Z", null, null],
    ["3758fd3a", "GBP/USD", "long", "2026-10-07T19:00:05.730Z", "2026-10-07T22:42:02.646Z", null, null],
  ] as const;
  const fills: CapBookFill[] = S.map(([o, s, d, p, f, c, g]) => ({
    signalId: `pre-${o}`, orderId: o, symbol: s, direction: d, placedAtMs: T(p), filledAtMs: T(f), closedAtMs: c ? T(c) : null,
    exitReason: c ? (g as number) < 0 ? "hypothetical_stop" : "hypothetical_target" : null,
    rGross: g as number | null, rNet: null, pnlUsd: null, riskUsd: null, configVersion: null,
  }));
  const rep = buildCapBook(fills, { nowMs: T("2026-10-08T01:30:00Z") });
  const status = Object.fromEntries(rep.rows.map((r) => [r.fill.orderId, r.caps.reason ?? "admissible"]));
  assertEquals(status, {
    "2dee2910": "admissible", "77134ab8": "admissible", "02eb7948": "blocked_by_symbol_cap", "bcf0216f": "admissible",
    "4d8eab45": "admissible", "896572f4": "blocked_by_symbol_cap", "3758fd3a": "blocked_by_symbol_cap",
  });
  assertEquals(rep.rows.find((r) => r.fill.orderId === "02eb7948")!.caps.blockedBy[0].orderId, "77134ab8");
  assertEquals([rep.raw.fills, rep.raw.resolved, rep.capAdjusted.fills, rep.capAdjusted.resolved, rep.capAdjusted.blocked], [7, 4, 4, 3, 3]);
  assertEquals(Math.round(rep.raw.grossR * 1e4) / 1e4, -1.8479);
  assertEquals(Math.round(rep.capAdjusted.grossR * 1e4) / 1e4, -0.8479);
  assertEquals(rep.limitsAdjusted.fills, rep.capAdjusted.fills, "no EUR/USD↔GBP/USD pair in the sample: correlation changes nothing");
});

// ── source pins: the live rules this mirrors ────────────────────────────────

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url));
const scanner = read("../../functions/bot-scanner/index.ts");

Deno.test("pin: Gate 22 uses the STATIC matrix (no dynamic argument) and the same block rule; it runs at placement, the hunt checks caps only", () => {
  assert(/const rawCorr = getCorrelation\(symbol, pos\.symbol\);/.test(scanner), "Gate 22 must call getCorrelation without a dynamic matrix");
  assert(/getDirectionalCorrelation\(\s*\{ symbol, direction \},\s*\{ symbol: pos\.symbol, direction: posDir \},\s*\);/.test(scanner));
  assert(scanner.includes("if (hedgeHits.length > 0) {") && scanner.includes("} else if (doublingHits.length >= maxCorrelatedPos) {"));
  assert(/if \(!matched && smtPair && pos\.symbol === smtPair\)/.test(scanner), "SMT fallback");
  assert(scanner.includes("if (newBuying === posSelling && newSelling === posBuying) {"), "currency-decomposition fallback");
  const hunt = scanner.slice(scanner.indexOf('resolvePositionCaps((config as any).__rawConfigJson, "hunt_fill"'), scanner.indexOf("// ── ATOMIC FILL (route2_claim_and_fill)"));
  assert(hunt.length > 0 && !hunt.includes("getCorrelation"), "the hunt fill does not re-check correlation");
});

Deno.test("pin: the live hunt processes active orders by placed_at (the tie-break used here)", () => {
  assert(/\.in\("status", \["pending", "awaiting_confirmation"\]\)\s*\.order\("placed_at", \{ ascending: true \}\)/.test(scanner));
});

Deno.test("reporting only: no Edge Function imports the cap book", () => {
  for (const e of Deno.readDirSync(new URL("../../functions/", import.meta.url))) {
    if (!e.isDirectory || e.name === "_shared") continue;
    try {
      const src = read(`../../functions/${e.name}/index.ts`);
      assert(!src.includes("hypotheticalCapBook"), `${e.name} must not import the cap book`);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
});
