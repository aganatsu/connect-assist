/**
 * STEP 13 — equity-based daily loss and overall floor (FTMO 2-Step-style profile).
 *
 *  - one trading-day boundary: midnight Europe/Prague (CE(S)T), DST-correct;
 *  - day-start balance from the settlement ledger at that boundary;
 *  - equity = balance + floating P/L converted to USD − commissions + swaps;
 *  - entry stop 3% / flatten 4% of initial; equity floors $92k / $91k; FTMO
 *    hard limits (5%, $90k) are profile values, not engine constants;
 *  - missing data blocks entries and fills and never flattens;
 *  - the gate runs before the Route 2 hunt and decides fills and placement;
 *  - no size reduction, no profit-target shutdown;
 *  - prop-firm-daily-reset no longer owns the day.
 */
import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeEquity, dayStartBalanceFromLedger, evaluateAccountRisk, tradingDayAt, validateProfile,
  type OpenPositionInput,
} from "../../functions/_shared/accountRiskLimits.ts";
import { runPropFirmGate } from "../../functions/_shared/propFirmGate.ts";
import { getCESTTradingDay, getResetHourUTC } from "../../functions/_shared/propFirmRisk.ts";
import { PGlite } from "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist/index.js";

export const PROFILE = {
  id: "cfg-1", user_id: "u", bot_id: "smc", is_active: true, firm_type: "ftmo_2step",
  initial_balance: 100000, max_daily_loss_pct: 0.05, max_overall_loss_pct: 0.10,
  daily_entry_stop_pct: 0.03, daily_flatten_pct: 0.04,
  overall_entry_stop_equity: 92000, overall_flatten_equity: 91000,
  day_boundary_tz: "Europe/Prague", equity_source: "paper",
  close_on_breach: true, reduce_size_near_limit: false, profit_target_pct: null,
};

// Rates at valuation (USD/JPY doubles as the JPY→USD rate).
export const RATES = { "USD/JPY": 158.41184, "USD/CAD": 1.3950, "USD/CHF": 0.7980, "NZD/USD": 0.5780 };

export const EXAMPLES: OpenPositionInput[] = [
  { position_id: "uj", symbol: "USD/JPY", direction: "short", size: 3.25, entry_price: 158.21184, current_price: 158.41184 },
  { position_id: "cj", symbol: "CHF/JPY", direction: "long", size: 2.00, entry_price: 198.500, current_price: 198.300 },
  { position_id: "nc", symbol: "NZD/CAD", direction: "long", size: 4.00, entry_price: 0.80500, current_price: 0.80300 },
  { position_id: "nf", symbol: "NZD/CHF", direction: "short", size: 4.00, entry_price: 0.46100, current_price: 0.46300 },
];

// ─── trading day ────────────────────────────────────────────────────────────

Deno.test("trading day = midnight Europe/Prague: 22:00 UTC in summer, 23:00 UTC in winter", () => {
  assertEquals(tradingDayAt(new Date("2026-10-07T21:59:59Z")).tradingDay, "2026-10-07");
  const s = tradingDayAt(new Date("2026-10-07T22:00:00Z"));
  assertEquals(s.tradingDay, "2026-10-08");
  assertEquals(s.startsAt.toISOString(), "2026-10-07T22:00:00.000Z");
  assertEquals(tradingDayAt(new Date("2026-11-10T22:59:59Z")).tradingDay, "2026-11-10");
  const w = tradingDayAt(new Date("2026-11-10T23:00:00Z"));
  assertEquals(w.tradingDay, "2026-11-11");
  assertEquals(w.startsAt.toISOString(), "2026-11-10T23:00:00.000Z");
});

Deno.test("DST change days: 25-hour day in October, 23-hour day in March", () => {
  const oct = tradingDayAt(new Date("2026-10-25T12:00:00Z"));
  assertEquals([oct.startsAt.toISOString(), oct.endsAt.toISOString()], ["2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z"]);
  const mar = tradingDayAt(new Date("2027-03-28T12:00:00Z"));
  assertEquals([mar.startsAt.toISOString(), mar.endsAt.toISOString()], ["2027-03-27T23:00:00.000Z", "2027-03-28T22:00:00.000Z"]);
});

Deno.test("the old DST rule agrees with the new boundary on every day of a year (no second definition drifts)", () => {
  // every day of a year, at noon and one second either side of 22:00 and 23:00 UTC
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 86400_000) {
    for (const off of [12, 22, 23].flatMap((h) => h === 12 ? [h * 3600_000] : [h * 3600_000 - 1000, h * 3600_000])) {
      const d = new Date(t + off);
      assertEquals(tradingDayAt(d).tradingDay, getCESTTradingDay(d, getResetHourUTC(d)), d.toISOString());
    }
  }
});

// ─── day start from the ledger ──────────────────────────────────────────────

Deno.test("day start = last ledger balance before the boundary; a reset during the day starts the day at the reset", () => {
  assertEquals(dayStartBalanceFromLedger({ balance_after: "100500", created_at: "x" }, { balance_after: 100000, created_at: "y" }), { ok: true, balance: 100500, source: "ledger_before_boundary" });
  assertEquals(dayStartBalanceFromLedger(null, { balance_after: 100000, created_at: "y", kind: "reset" }), { ok: true, balance: 100000, source: "epoch_start" });
  assertEquals(dayStartBalanceFromLedger(null, null).ok, false);
});

// ─── equity: USD conversion ─────────────────────────────────────────────────

Deno.test("floating P/L is converted to USD for USD/JPY, CHF/JPY, NZD/CAD and NZD/CHF", () => {
  const e = computeEquity({ balance: 100000, positions: EXAMPLES, rateMap: RATES });
  assert(e.ok);
  const by = Object.fromEntries(e.positions.map((p) => [p.position_id, p]));
  // price move × 100,000 × lots = quote-currency P/L, then × quote→USD
  assertAlmostEquals(by.uj.floatingUsd, -0.20 * 100000 * 3.25 / 158.41184, 1e-6); // −65,000 JPY → −$410.32
  assertAlmostEquals(by.cj.floatingUsd, -0.20 * 100000 * 2.00 / 158.41184, 1e-6); // −40,000 JPY → −$252.51
  assertAlmostEquals(by.nc.floatingUsd, -0.00200 * 100000 * 4 / 1.3950, 1e-6);    // −800 CAD → −$573.48
  assertAlmostEquals(by.nf.floatingUsd, -0.00200 * 100000 * 4 / 0.7980, 1e-6);    // −800 CHF → −$1,002.51
  assertAlmostEquals(by.uj.floatingUsd, -410.32, 0.005);
  assertAlmostEquals(by.cj.floatingUsd, -252.51, 0.005);
  assertAlmostEquals(by.nc.floatingUsd, -573.48, 0.005);
  assertAlmostEquals(by.nf.floatingUsd, -1002.51, 0.005);
  assertAlmostEquals(e.equity, 100000 - 410.32 - 252.51 - 573.48 - 1002.51, 0.02);
  // the old gate's ×100,000 reading would have been −$65,000 / −$40,000 / −$800 / −$800
});

Deno.test("commissions and swaps are part of equity", () => {
  const e = computeEquity({
    balance: 100000,
    positions: [{ ...EXAMPLES[2], commission: 14, swap: -3.5 }],
    rateMap: RATES, commissionPerLotRoundTrip: 7,
  });
  assert(e.ok);
  assertAlmostEquals(e.commissionsUsd, 14 + 7 * 4, 1e-9);
  assertEquals(e.swapsUsd, -3.5);
  assertAlmostEquals(e.equity, 100000 + e.floatingUsd - 42 - 3.5, 1e-9);
});

Deno.test("missing conversion rate, price or spec → equity unavailable", () => {
  const { "USD/CHF": _drop, ...noChf } = RATES;
  const a = computeEquity({ balance: 100000, positions: EXAMPLES, rateMap: noChf });
  assert(!a.ok && a.reason.includes("USD/CHF"));
  const b = computeEquity({ balance: 100000, positions: [{ ...EXAMPLES[0], current_price: null }], rateMap: RATES });
  assert(!b.ok && b.reason.includes("current price"));
  const c = computeEquity({ balance: 100000, positions: [{ ...EXAMPLES[0], symbol: "XXX/YYY" }], rateMap: RATES });
  assert(!c.ok);
});

// ─── decision ───────────────────────────────────────────────────────────────

const START = dayStartBalanceFromLedger({ balance_after: 100000, created_at: "x" }, null);
const flatEquity = (equity: number) => computeEquity({ balance: equity, positions: [], rateMap: RATES });

Deno.test("daily: entry stop at exactly $3,000, flatten at exactly $4,000 (of initial)", () => {
  assertEquals(evaluateAccountRisk(PROFILE, START, flatEquity(97000.01)).severity, "ok");
  const stop = evaluateAccountRisk(PROFILE, START, flatEquity(97000));
  assertEquals([stop.severity, stop.allowEntries, stop.flatten], ["entry_stop", false, false]);
  assertEquals(evaluateAccountRisk(PROFILE, START, flatEquity(96000.01)).severity, "entry_stop");
  const flat = evaluateAccountRisk(PROFILE, START, flatEquity(96000));
  assertEquals([flat.severity, flat.allowEntries, flat.flatten], ["flatten", false, true]);
  assertEquals(flat.thresholds!.dailyHardLimitUsd, 5000);
});

Deno.test("overall: entry stop at equity $92,000, flatten at $91,000, hard floor $90,000 from the profile", () => {
  // a day that started at 92,500 so the daily rule is not what fires
  const s = dayStartBalanceFromLedger({ balance_after: 92500, created_at: "x" }, null);
  assertEquals(evaluateAccountRisk(PROFILE, s, flatEquity(92000.01)).severity, "ok");
  assertEquals(evaluateAccountRisk(PROFILE, s, flatEquity(92000)).severity, "entry_stop");
  const f = evaluateAccountRisk(PROFILE, s, flatEquity(91000));
  assertEquals([f.severity, f.flatten], ["flatten", true]);
  assertEquals(f.thresholds!.overallHardFloor, 90000);
});

Deno.test("the hard limits are profile values, not constants", () => {
  const other = { ...PROFILE, initial_balance: 200000, max_daily_loss_pct: 0.04, daily_entry_stop_pct: 0.02, daily_flatten_pct: 0.03, overall_entry_stop_equity: 185000, overall_flatten_equity: 182000 };
  const v = validateProfile(other);
  assert(v.ok);
  assertEquals([v.hardDailyLimitUsd, v.hardOverallFloor], [8000, 180000]);
  const s = dayStartBalanceFromLedger({ balance_after: 200000, created_at: "x" }, null);
  assertEquals(evaluateAccountRisk(other, s, flatEquity(196000)).severity, "entry_stop");
});

Deno.test("data errors block entries and NEVER flatten — even when the (unknown) loss could be huge", () => {
  const { "USD/JPY": _drop, ...noJpy } = RATES;
  const deep = [{ ...EXAMPLES[0], current_price: 170 }]; // would be a −$22k loss if it could be valued
  for (const d of [
    evaluateAccountRisk(PROFILE, START, computeEquity({ balance: 100000, positions: deep, rateMap: noJpy })),
    evaluateAccountRisk(PROFILE, dayStartBalanceFromLedger(null, null), flatEquity(50000)),
    evaluateAccountRisk({ ...PROFILE, daily_flatten_pct: null }, START, flatEquity(50000)),
    evaluateAccountRisk(null, START, flatEquity(50000)),
  ]) {
    assertEquals([d.severity, d.allowEntries, d.flatten], ["data_error", false, false], d.reason);
  }
});

Deno.test("invalid profiles are refused (ordering, missing buffers, bad zone)", () => {
  for (const bad of [
    { daily_entry_stop_pct: 0.04, daily_flatten_pct: 0.03 },
    { daily_flatten_pct: 0.05 },
    { overall_flatten_equity: 90000 },
    { overall_entry_stop_equity: 90500 },
    { overall_entry_stop_equity: null },
    { day_boundary_tz: "Mars/Olympus" },
  ]) assertEquals(validateProfile({ ...PROFILE, ...bad }).ok, false, JSON.stringify(bad));
});

// ─── the gate (I/O) ─────────────────────────────────────────────────────────

type Row = Record<string, any>;
export function fakeDb(tables: Record<string, Row[]>, failOn: Set<string> = new Set()) {
  const q = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let order: { col: string; asc: boolean } | null = null;
    let lim: number | null = null;
    let op: "select" | "insert" | "update" = "select";
    let payload: Row | null = null;
    const run = () => {
      if (failOn.has(table)) return { data: null, error: { message: `${table} unavailable` } };
      const rows = (tables[table] ??= []);
      if (op === "insert") { const r = { id: `${table}-${rows.length + 1}`, is_locked: false, ...payload }; rows.push(r); return { data: r, error: null }; }
      let out = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "update") { out.forEach((r) => Object.assign(r, payload)); return { data: out, error: null }; }
      if (order) out = [...out].sort((a, b) => (a[order!.col] < b[order!.col] ? -1 : a[order!.col] > b[order!.col] ? 1 : 0) * (order!.asc ? 1 : -1));
      if (lim != null) out = out.slice(0, lim);
      return { data: out, error: null };
    };
    const b: any = {
      select: () => b,
      insert: (p: Row) => { op = "insert"; payload = p; return b; },
      update: (p: Row) => { op = "update"; payload = p; return b; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
      lt: (c: string, v: string) => { filters.push((r) => r[c] < v); return b; },
      order: (c: string, o: { ascending: boolean }) => { order = { col: c, asc: o.ascending }; return b; },
      limit: (n: number) => { lim = n; return b; },
      maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
      single: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  };
  return { from: q };
}

export const ACCOUNT = { id: "acct", ledger_epoch_id: "ep", balance: 100000 };
export const ledger = (rows: [number, string, string?][]) => rows.map(([bal, at, kind], i) => ({ seq: i + 1, account_id: "acct", epoch_id: "ep", balance_after: bal, created_at: at, kind: kind ?? "close" }));

Deno.test("gate: no active profile → disabled (today's state: is_active false)", async () => {
  const r = await runPropFirmGate(fakeDb({ prop_firm_config: [{ ...PROFILE, is_active: false }] }), "u", "smc", ACCOUNT, [], "c", { rateMap: RATES });
  assertEquals([r.enabled, r.allowed, r.shouldCloseAll], [false, true, false]);
});

Deno.test("gate: profile read error, ledger error, missing epoch or broker equity source → blocked, no flatten", async () => {
  const base = () => ({ prop_firm_config: [PROFILE], paper_account_ledger: ledger([[100000, "2026-10-06T20:46:33Z", "reset"]]) });
  const now = new Date("2026-10-07T12:00:00Z");
  const cases = [
    await runPropFirmGate(fakeDb(base(), new Set(["prop_firm_config"])), "u", "smc", ACCOUNT, [], "c", { rateMap: RATES, now }),
    await runPropFirmGate(fakeDb(base(), new Set(["paper_account_ledger"])), "u", "smc", ACCOUNT, [], "c", { rateMap: RATES, now }),
    await runPropFirmGate(fakeDb(base()), "u", "smc", { ...ACCOUNT, ledger_epoch_id: null }, [], "c", { rateMap: RATES, now }),
    await runPropFirmGate(fakeDb({ ...base(), prop_firm_config: [{ ...PROFILE, equity_source: "broker" }] }), "u", "smc", ACCOUNT, [], "c", { rateMap: RATES, now }),
    await runPropFirmGate(fakeDb(base()), "u", "smc", { ...ACCOUNT, balance: 90000 }, [{ ...EXAMPLES[0], current_price: 175 }], "c", { rateMap: {}, now }),
  ];
  for (const r of cases) assertEquals([r.enabled, r.allowed, r.shouldCloseAll, r.decision?.severity], [true, false, false, "data_error"], r.reason);
});

Deno.test("gate: size multiplier is always 1 and there is no profit-target shutdown", async () => {
  const now = new Date("2026-10-07T12:00:00Z");
  const db = fakeDb({ prop_firm_config: [{ ...PROFILE, reduce_size_near_limit: true, profit_target_pct: 0.10 }], paper_account_ledger: ledger([[100000, "2026-10-06T20:46:33Z", "reset"]]) });
  // 2.9% daily loss (would be size-reduced by the old gate) and +15% balance (old target)
  const nearLimit = await runPropFirmGate(db, "u", "smc", { ...ACCOUNT, balance: 97100 }, [], "c", { rateMap: RATES, now });
  assertEquals([nearLimit.allowed, nearLimit.maxPositionSizeMultiplier], [true, 1]);
  const db2 = fakeDb({ prop_firm_config: [{ ...PROFILE, profit_target_pct: 0.10 }], paper_account_ledger: ledger([[115000, "2026-10-06T20:46:33Z"]]) });
  const target = await runPropFirmGate(db2, "u", "smc", { ...ACCOUNT, balance: 115000 }, [], "c", { rateMap: RATES, now });
  assertEquals([target.allowed, target.maxPositionSizeMultiplier], [true, 1]);
});

Deno.test("gate: an entry stop locks the day; a further fall to the flatten level still flattens; the lock ends at midnight", async () => {
  const tables: Record<string, Row[]> = { prop_firm_config: [PROFILE], paper_account_ledger: ledger([[100000, "2026-10-06T20:46:33Z", "reset"]]) };
  const db = fakeDb(tables);
  const t1 = new Date("2026-10-07T12:00:00Z");
  const a = await runPropFirmGate(db, "u", "smc", { ...ACCOUNT, balance: 96900 }, [], "c", { rateMap: RATES, now: t1 });
  assertEquals([a.allowed, a.shouldCloseAll], [false, false]);
  // equity recovers — still locked for the trading day
  const b = await runPropFirmGate(db, "u", "smc", { ...ACCOUNT, balance: 99000 }, [], "c", { rateMap: RATES, now: new Date("2026-10-07T13:00:00Z") });
  assertEquals(b.allowed, false);
  assert(b.reason.startsWith("locked for the trading day"));
  // falls through the flatten level while locked → flatten
  const c = await runPropFirmGate(db, "u", "smc", { ...ACCOUNT, balance: 95900 }, [], "c", { rateMap: RATES, now: new Date("2026-10-07T14:00:00Z") });
  assertEquals([c.allowed, c.shouldCloseAll], [false, true]);
  // next trading day (after 22:00 UTC): new row, unlocked; day start from the ledger (still 100,000 → equity 99,000 is a 1% loss)
  const d = await runPropFirmGate(db, "u", "smc", { ...ACCOUNT, balance: 99000 }, [], "c", { rateMap: RATES, now: new Date("2026-10-07T22:00:01Z") });
  assertEquals([d.tradingDay, d.allowed], ["2026-10-08", true]);
  assertEquals(tables.prop_firm_daily_state?.length, 2);
});

// Requirement 11: an overnight position across midnight CE(S)T.
//   ledger: reset 100,000 (10-06 20:46Z); a close +500 at 10-07 10:00Z → 100,500
//   open: USD/JPY short 3.25 lots @158.21184 since 10-07 15:00Z
export const OVERNIGHT = {
  ledger: ledger([[100000, "2026-10-06T20:46:33Z", "reset"], [100500, "2026-10-07T10:00:00Z"]]),
  balance: 100500,
  position: (current: number): OpenPositionInput => ({ position_id: "uj", symbol: "USD/JPY", direction: "short", size: 3.25, entry_price: 158.21184, current_price: current }),
  // USD/JPY rate moves with the position price
  rates: (current: number) => ({ ...RATES, "USD/JPY": current }),
};

Deno.test("overnight: the same floating loss is measured against yesterday's start before midnight and today's after", async () => {
  const run = async (iso: string, current: number) => {
    const db = fakeDb({ prop_firm_config: [PROFILE], paper_account_ledger: OVERNIGHT.ledger });
    return await runPropFirmGate(db, "u", "smc", { ...ACCOUNT, balance: OVERNIGHT.balance }, [OVERNIGHT.position(current)], "c", { rateMap: OVERNIGHT.rates(current), now: new Date(iso) });
  };
  // 20 pips against: floating −$410.32 either side of midnight
  const before = await run("2026-10-07T21:59:59Z", 158.41184);
  const after = await run("2026-10-07T22:00:00Z", 158.41184);
  assertEquals([before.tradingDay, before.decision!.dayStartBalance], ["2026-10-07", 100000]);
  assertEquals([after.tradingDay, after.decision!.dayStartBalance], ["2026-10-08", 100500]);
  assertAlmostEquals(before.decision!.equity!, 100500 - 410.32, 0.01);
  assertAlmostEquals(before.decision!.dailyLossUsd!, -89.68, 0.01); // still up on the day
  assertAlmostEquals(after.decision!.dailyLossUsd!, 410.32, 0.01);   // the carried floating loss counts against the new day
  // 160 pips against (floating ≈ −$3,253.83): a $2,753.83 daily loss before
  // midnight (under the $3,000 entry stop), $3,253.83 after (over it)
  const b2 = await run("2026-10-07T21:59:59Z", 159.81184);
  const a2 = await run("2026-10-07T22:00:00Z", 159.81184);
  assertAlmostEquals(b2.decision!.dailyLossUsd!, 1.60 * 325000 / 159.81184 - 500, 0.01);
  assertAlmostEquals(a2.decision!.dailyLossUsd!, 1.60 * 325000 / 159.81184, 0.01);
  assertEquals([b2.decision!.severity, b2.allowed], ["ok", true]);
  assertEquals([a2.decision!.severity, a2.allowed, a2.shouldCloseAll], ["entry_stop", false, false]);
});

// ─── wiring (source) ────────────────────────────────────────────────────────

const scanner = Deno.readTextFileSync(new URL("../../functions/bot-scanner/index.ts", import.meta.url));
const gate = Deno.readTextFileSync(new URL("../../functions/_shared/propFirmGate.ts", import.meta.url));
const reset = Deno.readTextFileSync(new URL("../../functions/prop-firm-daily-reset/index.ts", import.meta.url));
const status = Deno.readTextFileSync(new URL("../../functions/prop-firm/index.ts", import.meta.url));
const cron = Deno.readTextFileSync(new URL("../../cron/setup_cron.sql", import.meta.url));

Deno.test("the gate is evaluated once, before the Route 2 hunt, and flattening happens there", () => {
  const g = scanner.indexOf("const propFirmGateResult: PropFirmGateResult = await runPropFirmGate(");
  const hunt = scanner.indexOf("// ── Limit Orders: Monitor active pending orders for fills/expiry ──");
  assert(g > 0 && hunt > g, "gate before hunt");
  assertEquals(scanner.split("await runPropFirmGate(").length - 1, 1, "evaluated once per cycle");
  const close = scanner.indexOf("const closedCount = await propFirmEmergencyClose(");
  assert(close > g && close < hunt, "flatten before the hunt");
  assert(/\{ rateMap, commissionPerLotRoundTrip: avgCommissionPerLot \}/.test(scanner));
});

Deno.test("the hunt checks the gate before BOTH the dry-run and the real fill", () => {
  const chk = scanner.indexOf("if (propFirmGateResult.enabled && !propFirmGateResult.allowed) {\n            console.warn(`[pending]");
  const dry = scanner.indexOf("if ((pending as any).dry_run === true) {");
  const claim = scanner.indexOf("const claim = await claimRoute2Fill(supabase, {");
  assert(chk > 0 && chk < dry && dry < claim);
  assert(/outcome: "PROP_FIRM_LOCKED"/.test(scanner.slice(chk, chk + 800)) && /continue;/.test(scanner.slice(chk, chk + 800)));
});

Deno.test("placement is blocked for the cycle when entries are not allowed; Gates 7/8 delegate", () => {
  assert(/if \(!propFirmGateResult\.allowed\) \{\n\s+console\.log\(`\[prop-firm-gate\] ⛔ New entries BLOCKED/.test(scanner));
  assert(scanner.includes("propFirmGateResult?.enabled || false,"));
});

Deno.test("no broker equity is fetched and no fail-open path remains", () => {
  assert(!/Broker equity fetch|brokerEquity/.test(scanner), "bot-scanner no longer fetches broker equity for the gate");
  assert(!/NON-BLOCKING/.test(gate) && !/sanity check/i.test(gate.split("export async function propFirmEmergencyClose")[0]));
  assert(!/allowed: true,\s*\n\s*reason: "Broker equity unavailable/.test(gate));
  assert(/shouldCloseAll: d\.flatten && d\.severity === "flatten"/.test(gate), "only a computed flatten can liquidate");
});

Deno.test("one day boundary: the reset function writes nothing, its cron jobs are retired, the status API uses tradingDayAt", () => {
  assert(!/\.insert\(|\.update\(|\.from\(/.test(reset), "prop-firm-daily-reset writes nothing");
  assert(reset.includes("tradingDayAt(new Date())"));
  assert(!/cron\.schedule\('prop-firm-daily-reset/.test(cron));
  assert(!/getCESTTradingDay|getResetHourUTC/.test(status) && status.includes("tradingDayAt("));
  assert(!/getCESTTradingDay|getResetHourUTC/.test(gate));
});

// ─── migration (real Postgres) ──────────────────────────────────────────────


const PGLITE_DIST = "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist";
async function newPglite(): Promise<InstanceType<typeof PGlite>> {
  const a = {
    wasmModule: await WebAssembly.compile(await (await fetch(`${PGLITE_DIST}/postgres.wasm`)).arrayBuffer()),
    fsBundle: await (await fetch(`${PGLITE_DIST}/postgres.data`)).blob(),
  };
  // See route2AtomicFill.test.ts: hide Deno's `process` while PGlite boots.
  const g = globalThis as Record<string, unknown>;
  const desc = Object.getOwnPropertyDescriptor(g, "process");
  Object.defineProperty(g, "process", { value: undefined, configurable: true, writable: true });
  try {
    const db = new PGlite(a);
    await db.waitReady;
    return db;
  } finally {
    if (desc) Object.defineProperty(g, "process", desc); else delete g.process;
  }
}

Deno.test({
  name: "migration: explicit profile columns, defaults and ordering constraints (real Postgres)",
  sanitizeResources: false, sanitizeOps: false,
  fn: async () => {
    const baseline = Deno.readTextFileSync(new URL("../../migrations/20260914000000_baseline_schema.sql", import.meta.url));
    const start = baseline.indexOf("CREATE TABLE IF NOT EXISTS public.prop_firm_config (");
    const ddl = baseline.slice(start, baseline.indexOf("\n);", start) + 3);
    const migration = Deno.readTextFileSync(new URL("../../migrations/20261007010000_step13_risk_profile.sql", import.meta.url));
    const db = await newPglite();
    await db.exec(ddl);
    await db.exec(`insert into public.prop_firm_config (user_id, bot_id, is_active) values ('57c79dee-db6b-4fae-b34a-4b64ce33ca34', 'smc', false)`);
    await db.exec(migration);
    await db.exec(migration); // idempotent
    const r: { rows: Row[] } = await db.query(`select day_boundary_tz, equity_source, daily_entry_stop_pct, is_active from public.prop_firm_config`);
    assertEquals(r.rows[0], { day_boundary_tz: "Europe/Prague", equity_source: "paper", daily_entry_stop_pct: null, is_active: false }, "existing row: defaults, buffers unset, still inactive");
    // the approved profile values satisfy the constraints
    await db.exec(`update public.prop_firm_config set daily_entry_stop_pct = 0.03, daily_flatten_pct = 0.04,
      overall_entry_stop_equity = 92000, overall_flatten_equity = 91000, profit_target_pct = null, reduce_size_near_limit = false`);
    for (const bad of [
      "daily_entry_stop_pct = 0.05", "daily_flatten_pct = 0.06", "daily_entry_stop_pct = 0",
      "overall_flatten_equity = 90000", "overall_entry_stop_equity = 100000", "overall_entry_stop_equity = 90500",
      "equity_source = 'mt5'",
    ]) {
      let refused = false;
      try { await db.exec(`update public.prop_firm_config set ${bad}`); } catch { refused = true; }
      assert(refused, `constraint refuses: ${bad}`);
    }
    await db.close();
  },
});
