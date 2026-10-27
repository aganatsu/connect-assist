import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FakeDb } from "../scannerHarness.ts";
import { fxOpenNY } from "../../../functions/_shared/structure/canonicalBars.ts";
import { CHECKPOINT_LAG_MS, computeV3State, planV3Writes, staleness, stateHash, V3_TFS } from "../../../functions/_shared/structure/v32cState.ts";
import { AUDIT_WINDOW_MS, runV3StateForPair } from "../../../functions/_shared/structure/v32cStateRun.ts";
import { initState, step } from "../../../functions/_shared/structure/v32c/engine.ts";
import { aggregate } from "../../../functions/_shared/structure/v32c/timeframes.ts";
import { frozenV32cConfig } from "../../../functions/_shared/structure/v32c/config.ts";

/** The V3.2c state service (PR3): causality, windowing, repaint audit, staleness, and the run against an in-memory store. */

const H = 3_600_000;
// ~5 weeks of FX-open hours from Sunday 2025-05-04 21:00Z, a deterministic random walk with alternating drift so V3.2c builds
// real structure (trend, P, F, flips). Under 1,000 rows per table, which the in-memory store's paging needs.
function hours(weeks = 5) {
  const out: { t: number; o: number; h: number; l: number; c: number }[] = [];
  let s = 20261026, p = 1.1;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let t = Date.parse("2025-05-04T21:00:00Z"), i = 0; out.length < weeks * 120; t += H) {
    if (!fxOpenNY(t)) continue;
    const drift = Math.sin(i++ / 40) * 0.0004, o = p, c = o + drift + (rnd() - 0.5) * 0.002;
    out.push({ t, o: +o.toFixed(5), h: +(Math.max(o, c) + rnd() * 0.0008).toFixed(5), l: +(Math.min(o, c) - rnd() * 0.0008).toFixed(5), c: +c.toFixed(5) });
    p = c;
  }
  return out;
}
const HOURS = hours();
const FULL = computeV3State("EUR/USD", HOURS);

Deno.test("state: the synthetic series builds real structure (the tests below are not vacuous)", () => {
  for (const tf of V3_TFS) assert(FULL.snapshots[tf].length > 10, tf);
  assert(FULL.snapshots["1H"].some((s) => s.trend === "bull") && FULL.snapshots["1H"].some((s) => s.trend === "bear"), "both trends occur");
  assert(FULL.snapshots["1H"].filter((s) => s.p_time).length > 100);
  assert(new Set(FULL.snapshots["1H"].map((s) => s.state_hash)).size > 50, "states change over time");
  assertEquals(FULL.snapshots.D.length, FULL.checkpoints.length);
});

Deno.test("state: causal — a snapshot computed from bars up to its close equals the one in the full replay (no repaint)", () => {
  for (const cut of [130, 241, 377, 480, HOURS.length - 1]) {
    const prefix = computeV3State("EUR/USD", HOURS.slice(0, cut));
    for (const tf of V3_TFS) {
      const last = prefix.snapshots[tf].at(-1);
      if (!last) continue;
      assertEquals(FULL.snapshots[tf].find((s) => s.known_at === last.known_at), last, `${tf} at cut ${cut}`);
    }
  }
});

Deno.test("state: equals a direct frozen-engine replay; bars are named by time; hashing is deterministic", () => {
  const { bars } = aggregate("1H", HOURS);
  const cfg = frozenV32cConfig("1H");
  let s = initState();
  for (const b of bars) s = step(cfg, s, b).state;
  const last = FULL.snapshots["1H"].at(-1)!;
  assertEquals(last.trend, s.trend);
  assertEquals(last.p_time, s.P ? new Date(bars[s.P.index].t).toISOString() : null);
  assertEquals(last.p_price, s.P?.price ?? null);
  assertEquals(last.state_hash, stateHash(s));
  assertEquals(stateHash(structuredClone(s)), stateHash(s));
});

Deno.test("state: materializeFrom only limits what is returned — the snapshots are identical to the full replay's", () => {
  const from = Date.parse(FULL.snapshots["1H"][400].known_at);
  const w = computeV3State("EUR/USD", HOURS, from);
  for (const tf of V3_TFS) {
    assert(w.snapshots[tf].every((x) => Date.parse(x.known_at) >= from));
    assertEquals(w.snapshots[tf], FULL.snapshots[tf].filter((x) => Date.parse(x.known_at) >= from));
  }
  assert(w.checkpoints.length > 0 && w.checkpoints.every((c) => Date.parse(c.known_at) >= from + CHECKPOINT_LAG_MS));
  assertEquals(w.checkpoints, FULL.checkpoints.filter((c) => Date.parse(c.known_at) >= from + CHECKPOINT_LAG_MS));
});

Deno.test("plan: new → insert; equal → verified; different → repaint; vanished → repaint; outside the window → not judged", () => {
  const first = planV3Writes(FULL, new Map(), new Map());
  const n = V3_TFS.reduce((a, tf) => a + FULL.snapshots[tf].length, 0);
  assertEquals(first.inserts.length, n);
  assertEquals(first.checkpointInserts.length, FULL.checkpoints.length);
  const stored = new Map(first.inserts.map((s) => [`${s.tf}|${s.known_at}`, s.state_hash]));
  const cps = new Map(first.checkpointInserts.map((c) => [c.known_at, c]));
  const again = planV3Writes(FULL, stored, cps);
  assertEquals([again.inserts.length, again.repaints.length, again.checkpointInserts.length, again.checkpointMismatches.length], [0, 0, 0, 0]);
  const k = `4H|${FULL.snapshots["4H"][5].known_at}`;
  stored.set(k, "0000000000000000");
  stored.set("1H|2030-01-01T00:00:00.000Z", "ffffffffffffffff");
  const cp = FULL.checkpoints[3];
  cps.set(cp.known_at, { ...cp, h1_state_hash: "tampered" });
  const bad = planV3Writes(FULL, stored, cps);
  assertEquals(bad.repaints.map((r) => [r.tf, r.replay_hash === "missing"]).sort(), [["1H", true], ["4H", false]]);
  assertEquals(bad.inserts.length, 0, "a repaint is reported, never re-inserted or overwritten");
  assertEquals(bad.checkpointMismatches.map((m) => m.field), ["h1_state_hash"]);
  const windowed = planV3Writes(computeV3State("EUR/USD", HOURS, Date.parse("2031-01-01T00:00:00Z")), stored, new Map(), Date.parse("2031-01-01T00:00:00Z"));
  assertEquals(windowed.repaints.length, 0, "stored rows before the window are not judged");
});

Deno.test("staleness: the newest settled FX hour must be stored; a closed market is walked back over", () => {
  const wed = Date.parse("2026-10-28T14:40:00Z");                                 // expects the 13:00 bar (settled 14:15)
  const h = [{ t: Date.parse("2026-10-28T13:00:00Z"), o: 1, h: 1, l: 1, c: 1 }];
  assertEquals(staleness(h, wed, fxOpenNY), { stale: false, expected: "2026-10-28T13:00:00.000Z", latest: "2026-10-28T13:00:00.000Z" });
  assert(staleness([{ ...h[0], t: Date.parse("2026-10-28T12:00:00Z") }], wed, fxOpenNY).stale);
  const sat = Date.parse("2026-10-31T12:00:00Z");                                 // Friday close 17:00 NY = 21:00Z → last bar 20:00Z
  assertEquals(staleness([{ ...h[0], t: Date.parse("2026-10-30T20:00:00Z") }], sat, fxOpenNY).stale, false);
  assertEquals(staleness([{ ...h[0], t: Date.parse("2026-10-30T20:00:00Z") }], sat, fxOpenNY).expected, "2026-10-30T20:00:00.000Z");
});

Deno.test("run: appends, verifies on re-run, logs a repaint without overwriting, dry run writes nothing", async () => {
  // PostgREST returns timestamps as +00:00; keys must still match the ISO .000Z the replay produces
  const bars = HOURS.map((b) => ({ symbol: "EUR/USD", bar_time: new Date(b.t).toISOString().replace(".000Z", "+00:00"), open: b.o, high: b.h, low: b.l, close: b.c }));
  const db = new FakeDb({ structure_bars_1h: bars });
  const now = HOURS.at(-1)!.t + 2 * H + 40 * 60_000;                                // the cron runs at minute 40
  const dry = await runV3StateForPair(db.client(), "EUR/USD", { nowMs: now, materializeFrom: -Infinity, dryRun: true });
  assertEquals(db.writes.length, 0);
  assert(dry.plan.inserts.length > 0);
  const r1 = await runV3StateForPair(db.client(), "EUR/USD", { nowMs: now, materializeFrom: -Infinity });
  assert(r1.ok, JSON.stringify(r1.counts));
  assertEquals(db.rows("structure_v3_snapshots").length, dry.plan.inserts.length);
  assertEquals(r1.stale.stale, false);
  // stored rows come back from a real database with +00:00 timestamps
  for (const r of db.rows("structure_v3_snapshots")) r.known_at = r.known_at.replace(".000Z", "+00:00");
  const r2 = await runV3StateForPair(db.client(), "EUR/USD", { nowMs: now, materializeFrom: now - AUDIT_WINDOW_MS });
  assert(r2.ok, JSON.stringify(r2.counts));
  assertEquals(r2.plan.inserts.length, 0);
  assert((r2.counts["verified:1H"] ?? 0) > 100, "the recent window is re-verified");
  const victim = db.rows("structure_v3_snapshots").find((r) => r.tf === "1H" && Date.parse(r.known_at) > now - 86_400_000)!;
  victim.state_hash = "0000000000000000";
  const r3 = await runV3StateForPair(db.client(), "EUR/USD", { nowMs: now, materializeFrom: now - AUDIT_WINDOW_MS });
  assertEquals([r3.ok, r3.repaints], [false, 1]);
  assertEquals(victim.state_hash, "0000000000000000", "never overwritten");
  assertEquals(db.rows("structure_v3_audit").map((a) => a.kind), ["repaint"]);
  db.rows("structure_bars_1h").pop();                                              // the newest settled hour goes missing
  const stale = await runV3StateForPair(db.client(), "EUR/USD", { nowMs: now, materializeFrom: now - AUDIT_WINDOW_MS });
  assert(stale.stale.stale && db.rows("structure_v3_audit").some((a) => a.kind === "stale"), JSON.stringify(stale.stale));
  await assertRejects(() => runV3StateForPair(db.client(), "BTC/USD", { nowMs: now, materializeFrom: 0 }), Error, "not a structure pair");
});

Deno.test("state: the outer internal leg (Shadow B) is the stack's second leg (or the only one), with its extreme since the origin", () => {
  const { bars } = aggregate("1H", HOURS);
  const cfg = frozenV32cConfig("1H");
  let s = initState(), checked = 0, nested = 0;
  const snaps = new Map(FULL.snapshots["1H"].map((x) => [x.known_at, x]));
  for (const b of bars) {
    s = step(cfg, s, b).state;
    const snap = snaps.get(new Date(b.closeTime).toISOString())!;
    if (!s.trend || !s.stack.length) { assertEquals(snap.il_time, null); continue; }
    const leg = s.stack.length > 1 ? s.stack[1] : s.stack[0];
    const bull = s.trend === "bull";
    const seg = s.bars.slice(leg.origin.index), ext = bull ? Math.max(...seg.map((x) => x.h)) : Math.min(...seg.map((x) => x.l));
    assertEquals([snap.il_time, snap.il_price, snap.il_x_price], [new Date(s.bars[leg.origin.index].t).toISOString(), leg.origin.price, ext]);
    checked++; if (s.stack.length > 1) nested++;
  }
  assert(checked > 300 && nested >= 5, `${checked} checked, ${nested} with a nested internal leg`);
});
