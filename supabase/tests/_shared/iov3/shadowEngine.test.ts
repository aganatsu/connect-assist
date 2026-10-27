import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { advance, initShadowState, type Bar, type Pending, type ShadowParams, type ShadowState, type V3Leg } from "../../../functions/_shared/iov3/shadowEngine.ts";
import { computeV3State } from "../../../functions/_shared/structure/v32cState.ts";
import { fxOpenNY } from "../../../functions/_shared/structure/canonicalBars.ts";

/** Impulse-on-V3 shadow engine (step 3): resumability, lifecycle rules, gates. Research parity (183/183 trades) is proven on the
 *  research data outside the repo (~/strategy-v2/iov3-shadow/parity_research.ts); these are the synthetic invariants. */

const H = 3_600_000, M5 = 300_000;
const P: ShadowParams = { pair: "EUR/USD", pip: 0.0001, costPips: 1.5, minSlPips: 20, slBufferPips: 1, legBufferPct: 0.02, legCapMultiple: 1.2, capMultiplier: 1.5,
  tpRatio: 1.5, distanceAtrMult: 1.5, ttlMs: 8 * H, fibMaxRetracement: 1, enabledSessions: null, enabledDays: null, voidOnGap: true };

// 6 weeks of FX-open hours swinging every few hours (V3 builds structure, price retraces into zones), twelve 5m bars per hour
function series(weeks = 6) {
  const h1: Bar[] = [], m5: Bar[] = [];
  let s = 19, p = 1.1;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let t = Date.parse("2025-05-04T21:00:00Z"), i = 0; h1.length < weeks * 120; t += H) {
    if (!fxOpenNY(t)) continue;
    const drift = Math.sin(i++ / 5) * 0.003, o = p;
    let hi = o, lo = o, q = o;
    for (let k = 0; k < 12; k++) {
      const a = q, b = q + drift / 12 + (rnd() - 0.5) * 0.0008;
      const bh = Math.max(a, b) + rnd() * 0.0002, bl = Math.min(a, b) - rnd() * 0.0002;
      m5.push({ t: t + k * M5, o: +a.toFixed(5), h: +bh.toFixed(5), l: +bl.toFixed(5), c: +b.toFixed(5) });
      hi = Math.max(hi, bh); lo = Math.min(lo, bl); q = b;
    }
    h1.push({ t, o: +o.toFixed(5), h: +hi.toFixed(5), l: +lo.toFixed(5), c: +q.toFixed(5) });
    p = q;
  }
  return { h1, m5 };
}
const { h1: H1, m5: M5BARS } = series();
const V3 = computeV3State("EUR/USD", H1);
const v3Map = new Map(V3.snapshots["1H"].map((s) => [Date.parse(s.known_at), { trend: s.trend, pTime: s.p_time ? Date.parse(s.p_time) : null, pPrice: s.p_price, xTime: s.x_time ? Date.parse(s.x_time) : null, xPrice: s.x_price } as V3Leg]));
const ctx = (t: number) => { let r: string | null = null; for (const s of V3.snapshots["4H"]) { if (Date.parse(s.known_at) <= t) r = s.trend; else break; } return r; };
const START = H1[310].t + H, END = H1.at(-1)!.t + H;
const run = (state: ShadowState, until: number, over: Partial<ShadowParams> = {}, m5 = M5BARS, v3At = (T: number) => v3Map.get(T)) =>
  advance(state, { h1: H1, m5, v3At, ctx4hAt: ctx, params: { ...P, ...over }, until });

Deno.test("engine: the synthetic market produces real orders (the tests below are not vacuous)", () => {
  const r = run(initShadowState(START), END);
  const n = (t: string) => r.events.filter((e) => e.type === t).length;
  assert(n("placed") >= 5 && n("touched") >= 3 && n("filled") >= 2 && n("closed") >= 2 && n("cancelled") >= 2, JSON.stringify(r.events.map((e) => e.type)));
  assert(r.decisions.length > 300);
});

Deno.test("engine: resumable — any chunking gives identical decisions, events and final state; events are immutable snapshots", () => {
  const one = run(initShadowState(START), END);
  for (const step of [10 * 60_000, 6 * H, 3 * 86_400_000]) {
    let st = initShadowState(START); const ev: unknown[] = [], dec: unknown[] = [];
    for (let u = START + step; ; u += step) { const r = run(st, Math.min(u, END)); st = r.state; ev.push(...r.events); dec.push(...r.decisions); if (u >= END) break; }
    assertEquals(JSON.stringify(ev), JSON.stringify(one.events), `events, step ${step}`);
    assertEquals(JSON.stringify(dec), JSON.stringify(one.decisions), `decisions, step ${step}`);
    assertEquals(st, one.state);
  }
});

Deno.test("engine: waits at the first 1H close whose V3 state is missing — never decides or processes 5m past it", () => {
  const T = H1[400].t + H;
  const r = run(initShadowState(START), END, {}, M5BARS, (t) => (t >= T ? undefined : v3Map.get(t)));
  assertEquals(r.state.lastScanT, H1[399].t + H);
  assert(r.state.last5mT + M5 <= T - 1 + M5 && r.state.last5mT < T, "no 5m bar closing after the undecided hour was processed");
  assert(r.decisions.every((d) => d.t < T));
});

// hand-built lifecycle: a pending long at 1.1000, stop 1.0980, TP 1.1030; feed 5m bars between two 1H closes (no new decision)
function withPending(extra: Partial<Pending> = {}): ShadowState {
  const T0 = H1[500].t + H;
  const pend: Pending = { id: "EUR/USD|x", dir: "long", entry: 1.1, sl: 1.098, tp: 1.103, zl: 1.0995, zh: 1.1005, zoneType: "fvg", origin: 1.097, placed: T0, touchT: null, legBars: 40, stopSource: "impulse", ...extra };
  return { lastScanT: T0, last5mT: T0 - M5, pend, pos: null };
}
const bars = (t0: number, xs: [number, number, number, number][]): Bar[] => xs.map(([o, h, l, c], k) => ({ t: t0 + k * M5, o, h, l, c }));

Deno.test("lifecycle: a wick through the stop cancels; a close beyond P (leg origin) cancels; TTL expires", () => {
  const st = withPending(), t0 = st.lastScanT;
  const pre = M5BARS.filter((b) => b.t < t0);
  let r = advance(st, { h1: H1, m5: [...pre, ...bars(t0, [[1.101, 1.1012, 1.0979, 1.1]])], v3At: () => undefined, ctx4hAt: () => null, params: P, until: t0 + M5 });
  assertEquals(r.events.map((e) => [e.type, (e as { reason?: string }).reason]), [["cancelled", "sl_invalidation"]]);
  r = advance(withPending({ sl: 1.09, origin: 1.0995 }), { h1: H1, m5: [...pre, ...bars(t0, [[1.101, 1.1012, 1.0992, 1.0993]])], v3At: () => undefined, ctx4hAt: () => null, params: P, until: t0 + M5 });
  assertEquals(r.events.map((e) => (e as { reason?: string }).reason), ["leg_broken"]);
  const ttl = withPending({ placed: t0 - 8 * H });
  r = advance(ttl, { h1: H1, m5: [...pre, ...bars(t0, [[1.102, 1.1025, 1.1015, 1.102]])], v3At: () => undefined, ctx4hAt: () => null, params: P, until: t0 + M5 });
  assertEquals(r.events.map((e) => (e as { reason?: string }).reason), ["ttl_expiry"]);
});

Deno.test("lifecycle: an open position resolves stop-first when one bar hits both; net = gross − cost / risk", () => {
  const st: ShadowState = { ...withPending(), pend: null, pos: { id: "EUR/USD|p", dir: "long", entry: 1.1, fill: 1.1, fillT: 0, sl: 1.098, tp: 1.103, zl: 1.0995, zh: 1.1005, placed: 0, conf: "x", riskPips: 20, legBars: 40, ctx4h: null, ctx4hAgrees: null } };
  const t0 = st.lastScanT, pre = M5BARS.filter((b) => b.t < t0);
  const r = advance(st, { h1: H1, m5: [...pre, ...bars(t0, [[1.1, 1.1035, 1.0975, 1.1]])], v3At: () => undefined, ctx4hAt: () => null, params: P, until: t0 + M5 });
  const c = r.events[0] as { type: string; result: string; gross: number; net: number };
  assertEquals([c.type, c.result, c.gross], ["closed", "SL", -1]);
  assertEquals(c.net, +(-1 - (1.5 * 0.0001) / 0.002).toFixed(3));
  assertEquals(r.state.pos, null);
});

Deno.test("lifecycle: a missing 5m bar voids an active order / position (never guessed); research mode ignores gaps", () => {
  const st = withPending(), t0 = st.lastScanT, pre = M5BARS.filter((b) => b.t < t0);
  const gappy = [...pre, ...bars(t0, [[1.102, 1.1025, 1.1015, 1.102]]), ...bars(t0 + 2 * M5, [[1.102, 1.1025, 1.1015, 1.102]])]; // t0+M5 missing
  const r = advance(st, { h1: H1, m5: gappy, v3At: () => undefined, ctx4hAt: () => null, params: P, until: t0 + 3 * M5 });
  assertEquals(r.events.map((e) => e.type), ["voided"]);
  assert((r.events[0] as { reason: string }).reason.startsWith("data gap"));
  const research = advance(st, { h1: H1, m5: gappy, v3At: () => undefined, ctx4hAt: () => null, params: { ...P, voidOnGap: false }, until: t0 + 3 * M5 });
  assertEquals(research.events.length, 0);
});

Deno.test("gates: day and session filters (owner decision D2) are applied at the decision hour; null = no gate", () => {
  const noDays = run(initShadowState(START), START + 5 * H, { enabledDays: [] });
  assert(noDays.decisions.length > 0 && noDays.decisions.every((d) => d.reason === "day_not_enabled"));
  const noSess = run(initShadowState(START), START + 5 * H, { enabledSessions: ["london"] });
  assert(noSess.decisions.some((d) => d.reason.startsWith("session_not_enabled:")));
  const all = run(initShadowState(START), START + 5 * H, { enabledSessions: ["asian", "london", "newyork", "offhours"], enabledDays: [1, 2, 3, 4, 5] });
  assert(all.decisions.every((d) => !d.reason.startsWith("session_not_enabled") && d.reason !== "day_not_enabled"));
});

Deno.test("engine: arm B order ids carry |B| (arm A ids unchanged, so stored A rows and research parity are untouched)", () => {
  const a = run(initShadowState(START), END), b = run(initShadowState(START), END, { arm: "B" });
  const ids = (r: typeof a) => r.events.filter((e) => e.type === "placed").map((e) => (e as { order: { id: string } }).order.id);
  assert(ids(a).length > 0 && ids(a).every((id) => !id.includes("|B|")));
  assertEquals(ids(b), ids(a).map((id) => id.replace("|", "|B|")), "same market + same leg feed → same orders, only the id differs");
});
