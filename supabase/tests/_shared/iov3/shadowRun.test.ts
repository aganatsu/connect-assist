import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FakeDb } from "../scannerHarness.ts";
import { canonical5m, ensureCohort, M5_MISSING_AFTER_MS, M5_WRITE_GRACE_MS, runShadowForPair } from "../../../functions/_shared/iov3/shadowRun.ts";
import { computeV3State, V32C_ENGINE_VERSION } from "../../../functions/_shared/structure/v32cState.ts";
import { fxOpenNY } from "../../../functions/_shared/structure/canonicalBars.ts";

/** The shadow's run against an in-memory store: cohorts, switch, determinism of stored rows, refusals, the 5m presence rule. */

const H = 3_600_000, M5 = 300_000, USER = "00000000-0000-0000-0000-000000000001";
const SNAP = JSON.parse(Deno.readTextFileSync(new URL("../../../../docs/step16/step16e_config_before.json", import.meta.url)));
const config = () => { const r = structuredClone(SNAP.config_json ?? SNAP); r.exit.tpRRRatio = 1.5; return r; };
const iso = (t: number) => new Date(t).toISOString();

// 3 weeks of FX hours swinging every few hours (orders happen), EUR/USD only
function market() {
  const h1: Record<string, unknown>[] = [], m5: Record<string, unknown>[] = [], hours: { t: number; o: number; h: number; l: number; c: number }[] = [];
  let s = 19, p = 1.1; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let t = Date.parse("2026-11-01T22:00:00Z"), i = 0; hours.length < 3 * 120; t += H) {
    if (!fxOpenNY(t)) continue;
    const drift = Math.sin(i++ / 5) * 0.003, o = p; let hi = o, lo = o, q = o;
    for (let k = 0; k < 12; k++) {
      const a = q, b = q + drift / 12 + (rnd() - 0.5) * 0.0008, bh = Math.max(a, b) + rnd() * 0.0002, bl = Math.min(a, b) - rnd() * 0.0002, bt = t + k * M5;
      m5.push({ symbol: "EUR/USD", bar_time: iso(bt), open: +a.toFixed(5), high: +bh.toFixed(5), low: +bl.toFixed(5), close: +b.toFixed(5), observed_at: iso(bt + M5 + 20 * 60_000) });
      hi = Math.max(hi, bh); lo = Math.min(lo, bl); q = b;
    }
    hours.push({ t, o: +o.toFixed(5), h: +hi.toFixed(5), l: +lo.toFixed(5), c: +q.toFixed(5) });
    h1.push({ symbol: "EUR/USD", bar_time: iso(t), open: +o.toFixed(5), high: +hi.toFixed(5), low: +lo.toFixed(5), close: +q.toFixed(5) });
    p = q;
  }
  const v3 = computeV3State("EUR/USD", hours);
  const snaps = [...v3.snapshots["1H"], ...v3.snapshots["4H"]].map((x) => ({ ...x }));
  return { h1, m5, snaps, hours };
}
const MK = market();
const SET_AT = iso(MK.hours[150].t + 30 * 60_000);
function seed(mode = "SHADOW", cfg = config()) {
  return new FakeDb({
    structure_mode: [{ user_id: USER, bot_id: "smc", mode, set_at: SET_AT }],
    bot_configs: [{ user_id: USER, connection_id: null, config_json: cfg, config_version: "v-ef06", updated_at: "2026-10-22T04:02:00.000Z" }],
    structure_bars_1h: MK.h1, structure_bars_5m: MK.m5, structure_v3_snapshots: MK.snaps,
  });
}
const END = MK.hours.at(-1)!.t + H + 2 * H; // "now" two hours after the last bar
const strip = (rows: Record<string, unknown>[]) => rows.map(({ id: _i, ...r }) => r).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

Deno.test("cohort: deterministic id at the flip; params resolved per pair; reused; a live config change starts a new one", async () => {
  const db = seed();
  const m = { user_id: USER, bot_id: "smc", mode: "SHADOW", set_at: SET_AT };
  const c1 = await ensureCohort(db.client(), m);
  assertEquals(c1.id, `${USER}|smc|${iso(Date.parse(SET_AT))}`);
  assertEquals(c1.first_decision_at, iso(Math.ceil(Date.parse(SET_AT) / H) * H));
  assert(!("reason" in c1.params["EUR/USD"]) && (c1.params["EUR/USD"] as { tpRatio: number }).tpRatio === 1.5);
  assertEquals((await ensureCohort(db.client(), m)).id, c1.id);
  assertEquals(db.rows("iov3_shadow_cohorts").length, 1);
  db.rows("bot_configs")[0].config_version = "v-new"; db.rows("bot_configs")[0].updated_at = iso(Date.parse(SET_AT) + 5 * H);
  const c2 = await ensureCohort(db.client(), m);
  assertEquals(c2.started_at, iso(Date.parse(SET_AT) + 5 * H));
  assertEquals(db.rows("iov3_shadow_cohorts").length, 2);
});

Deno.test("run: OFF accounts are untouched (no cohort, no rows)", async () => {
  const db = seed("OFF");
  assertEquals(await runShadowForPair(db.client(), "EUR/USD", END), []);
  assertEquals(db.writes.length, 0);
});

Deno.test("run: 10-minute runs store exactly the rows one late run stores; a repeat run adds nothing; orders really happen", async () => {
  const late = seed();
  await runShadowForPair(late.client(), "EUR/USD", END);
  const stepped = seed();
  for (let now = Date.parse(SET_AT) + 10 * 60_000; now <= END; now += 10 * 60_000) await runShadowForPair(stepped.client(), "EUR/USD", now);
  for (const t of ["iov3_shadow_decisions", "iov3_shadow_events"]) assertEquals(strip(stepped.rows(t)), strip(late.rows(t)), t);
  const ev = late.rows("iov3_shadow_events");
  assert(ev.filter((e) => e.type === "placed").length >= 2 && ev.some((e) => e.type === "touched"), JSON.stringify(ev.map((e) => e.type)));
  assert(late.rows("iov3_shadow_decisions").length > 100);
  const n = late.rows("iov3_shadow_events").length;
  await runShadowForPair(late.client(), "EUR/USD", END);
  assertEquals(late.rows("iov3_shadow_events").length, n);
  assert(!late.writes.some((w) => ["pending_orders", "positions", "paper_accounts", "trade_history", "bot_configs"].includes(w.table)), "no trading table is ever written");
});

Deno.test("run: a style the shadow does not mirror is refused and audited, never guessed", async () => {
  const cfg = config(); cfg.tradingStyle = { mode: "day_trader" };
  const db = seed("SHADOW", cfg);
  const r = await runShadowForPair(db.client(), "EUR/USD", END);
  assert(r[0].skipped?.includes("scalper only"));
  assertEquals(db.rows("iov3_shadow_audit").map((a) => a.kind), ["refused"]);
  assertEquals(db.rows("iov3_shadow_decisions").length, 0);
});

Deno.test("5m presence: observed within 60 min of close counts; younger absent bars are waited for; older absent bars are gaps", () => {
  const t0 = Date.parse("2026-11-04T10:00:00Z");
  const row = (t: number, obsAfterClose: number) => ({ bar_time: iso(t), open: 1, high: 1, low: 1, close: 1, observed_at: iso(t + M5 + obsAfterClose) });
  const rows = [row(t0, 20 * 60_000), row(t0 + M5, 61 * 60_000), row(t0 + 3 * M5, 20 * 60_000)];      // t0+2M5 never observed
  const now = t0 + 3 * M5 + M5 + 30 * 60_000;
  const a = canonical5m(rows, now, t0);
  assertEquals(a.bars.map((b) => b.t), [t0, t0 + 3 * M5], "the bar first observed 61 min after close is a gap");
  assertEquals(a.processUntil, t0 + M5 + M5 - 1, "t0+M5 is absent but may still arrive: stop before it");
  const later = canonical5m(rows, t0 + M5 + M5 + M5_MISSING_AFTER_MS + M5_WRITE_GRACE_MS + 3 * M5, t0);
  assert(later.processUntil > t0 + 3 * M5, "once the window has passed, the absent bars are gaps and processing continues");
});
