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

Deno.test("cohort: deterministic id at the flip; params resolved per pair; reused; a change of the shadow's parameters starts a new one", async () => {
  const db = seed();
  const m = { user_id: USER, bot_id: "smc", mode: "SHADOW", set_at: SET_AT };
  const c1 = await ensureCohort(db.client(), m);
  assertEquals(c1.id, `${USER}|smc|${iso(Date.parse(SET_AT))}`);
  assertEquals(c1.first_decision_at, iso(Math.ceil(Date.parse(SET_AT) / H) * H));
  assert(!("reason" in c1.params["EUR/USD"]) && (c1.params["EUR/USD"] as { tpRatio: number }).tpRatio === 1.5);
  assertEquals((await ensureCohort(db.client(), m)).id, c1.id);
  assertEquals(db.rows("iov3_shadow_cohorts").length, 1);
  const cfg = db.rows("bot_configs")[0];
  cfg.config_version = "v-new"; cfg.updated_at = iso(Date.parse(SET_AT) + 5 * H); cfg.config_json = { ...config(), exit: { ...config().exit, tpRRRatio: 2 } };
  const c2 = await ensureCohort(db.client(), m);
  assertEquals(c2.started_at, iso(Date.parse(SET_AT) + 5 * H));
  assertEquals(db.rows("iov3_shadow_cohorts").length, 2);
});

Deno.test("cohort: a config save that leaves the shadow's parameters alone keeps the cohort (2026-11-02: 6 restarts, all identical params)", async () => {
  const db = seed();
  const m = { user_id: USER, bot_id: "smc", mode: "SHADOW", set_at: SET_AT };
  const c1 = await ensureCohort(db.client(), m);
  const cfg = db.rows("bot_configs")[0];
  cfg.config_version = "v-other"; cfg.updated_at = iso(Date.parse(SET_AT) + 5 * H);
  cfg.config_json = { ...config(), entry: { ...config().entry, confirmationTier3Enabled: false } };   // a Bot Config save the shadow does not read
  assertEquals((await ensureCohort(db.client(), m)).id, c1.id);
  assertEquals(db.rows("iov3_shadow_cohorts").length, 1);
});

Deno.test("cohort: entering ON is still its own cohort (owner decision Q1 = a), and leaving ON starts another", async () => {
  const db = seed();
  const m = { user_id: USER, bot_id: "smc", mode: "SHADOW", set_at: SET_AT };
  const c1 = await ensureCohort(db.client(), m);
  const cfg = db.rows("bot_configs")[0];
  cfg.config_json = { ...config(), structure: { owner: "v3", arm: "A" } }; cfg.config_version = "v-on"; cfg.updated_at = iso(Date.parse(SET_AT) + 5 * H);
  const on = await ensureCohort(db.client(), { ...m, mode: "ON" });
  assert(on.id !== c1.id);
  cfg.config_json = config(); cfg.config_version = "v-off"; cfg.updated_at = iso(Date.parse(SET_AT) + 9 * H);
  const off = await ensureCohort(db.client(), m);
  assert(off.id !== on.id && off.id !== c1.id);
  assertEquals(c1.params_hash, off.params_hash, "same parameters and no structure owner: the pre-2026-11-02 key");
});

Deno.test("restart: the old cohort's open order is cancelled at the restart and its open position runs to stop or target under the old id", async () => {
  const db = seed();
  const T1 = MK.hours[200].t + H;                       // the old cohort has run up to this 1H close
  await runShadowForPair(db.client(), "EUR/USD", T1 + 10 * 60_000);
  const c1 = db.rows("iov3_shadow_cohorts")[0].id as string;
  const latest = (cid: string, arm: string) => db.rows("iov3_shadow_state").filter((x) => x.cohort_id === cid && x.arm === arm).sort((a, b) => (b.seq as number) - (a.seq as number))[0];
  // plant an open position in arm A and a waiting order in arm B of the old cohort
  const px = MK.hours[200].c, pip = 0.0001;
  const pos = { id: "EUR/USD|planted", dir: "long", entry: px, fill: px, fillT: T1, sl: +(px - 30 * pip).toFixed(5), tp: +(px + 45 * pip).toFixed(5), zl: px - 5 * pip, zh: px,
    placed: T1 - H, conf: "bullish_choch", riskPips: 30, legBars: 10, ctx4h: null, ctx4hAgrees: null };
  const pend = { id: "EUR/USD|B|planted", dir: "short", entry: px + 200 * pip, sl: px + 230 * pip, tp: px + 155 * pip, zl: px + 195 * pip, zh: px + 205 * pip, zoneType: "ob",
    origin: px + 230 * pip, placed: T1, touchT: null, legBars: 10, stopSource: "impulse" };
  for (const [arm, patch] of [["A", { pos, pend: null }], ["B", { pend, pos: null }]] as const) {
    const r = latest(c1, arm);
    db.rows("iov3_shadow_state").push({ ...r, seq: (r.seq as number) + 1, state: { ...(r.state as object), ...patch } });
  }
  // a real restart two hours later: the shadow's target ratio changes
  const restartAt = T1 + 2 * H + 15 * 60_000;
  const cfg = db.rows("bot_configs")[0];
  cfg.config_json = { ...config(), exit: { ...config().exit, tpRRRatio: 2 } }; cfg.config_version = "v-tp2"; cfg.updated_at = iso(restartAt);
  await runShadowForPair(db.client(), "EUR/USD", END);
  assertEquals(db.rows("iov3_shadow_cohorts").length, 2);
  const old = db.rows("iov3_shadow_events").filter((e) => e.cohort_id === c1);
  // the position: closed at the first 5m bar after its fill that reaches the stop or the target
  const m5 = MK.m5.map((b) => ({ t: Date.parse(b.bar_time as string), h: b.high as number, l: b.low as number })).filter((b) => b.t >= T1);
  const hit = m5.find((b) => b.l <= pos.sl || b.h >= pos.tp)!;
  const closed = old.find((e) => e.order_id === pos.id && e.type === "closed");
  assert(closed, "the planted position was closed under the old cohort");
  assertEquals(closed!.t, iso(hit.t + M5));
  assertEquals((closed!.payload as { result: string }).result, hit.l <= pos.sl ? "SL" : "TP");
  // the order: cancelled at the restart
  const endB = old.filter((e) => e.order_id === pend.id && ["cancelled", "filled", "voided"].includes(e.type as string));
  assertEquals(endB.length, 1);
  assertEquals([endB[0].type, (endB[0].payload as { reason: string }).reason, endB[0].t], ["cancelled", "cohort_restart", iso(restartAt)]);
  assert(!old.some((e) => e.type === "placed" && Date.parse(e.t as string) > restartAt), "a retired cohort places no new orders after the restart");
  for (const arm of ["A", "B"]) { const st = latest(c1, arm).state as { pend: unknown; pos: unknown }; assertEquals([st.pend, st.pos], [null, null], arm); }
  // idempotent: another run writes nothing new for the old cohort
  const n = db.rows("iov3_shadow_events").filter((e) => e.cohort_id === c1).length;
  await runShadowForPair(db.client(), "EUR/USD", END);
  assertEquals(db.rows("iov3_shadow_events").filter((e) => e.cohort_id === c1).length, n);
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

Deno.test("arm B: both arms run with their own decisions, events and state; B order ids carry |B|; B equals a direct engine run on the internal leg", async () => {
  const db = seed();
  await runShadowForPair(db.client(), "EUR/USD", END);
  const dec = db.rows("iov3_shadow_decisions"), ev = db.rows("iov3_shadow_events"), st = db.rows("iov3_shadow_state");
  assert(dec.some((d) => d.arm === "A") && dec.some((d) => d.arm === "B"));
  assertEquals(new Set(st.map((x) => x.arm)), new Set(["A", "B"]));
  assert(ev.filter((e) => e.arm === "B").every((e) => String(e.order_id).includes("|B|")));
  assert(ev.filter((e) => e.arm === "A").every((e) => !String(e.order_id).includes("|B|")));
  // B decisions use the snapshot's internal leg, not the external one
  const snapAt = new Map(MK.snaps.filter((x) => x.tf === "1H").map((x) => [x.known_at, x]));
  for (const d of dec.filter((x) => x.arm === "B" && x.leg?.trend).slice(0, 50)) {
    const sn = snapAt.get(d.t)!;
    assertEquals([d.leg.swing_time, d.leg.swing_price, d.leg.extreme_price], [sn.il_time, sn.il_price, sn.il_x_price]);
  }
});
