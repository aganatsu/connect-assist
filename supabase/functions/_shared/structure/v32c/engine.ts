// V3.2c structure engine (comparison hypothesis, 2026-10-13): RESEARCH HARNESS ONLY. Based on V3.2b; the ONLY addition:
//   FLIP-ANCHOR PATH: a ≥ 50% correction of ANY leg in the stack, including one that is not yet active, records that leg's
//   extreme as a STRUCTURAL (a potential flip anchor) only. It creates no candidate, no reference leg and no frozen level.
//   At a flip, the existing rule picks the LATEST confirmed, untraded structural; the flip close is its validation.
//   The continuation path (candidates → BOS protection) still requires an ACTIVE reference leg (V3.2b).
// --- V3.2b header ---
// V3.2b structure engine (comparison hypothesis, 2026-10-13): RESEARCH HARNESS ONLY. Based on V3.1; the ONLY addition is
// REFERENCE-LEG ACTIVATION by the leg's own close-based continuation:
//   - a leg is ACTIVE once, after at least one bar that did not extend it (a pause), a candle CLOSES beyond the leg's extreme as it
//     stood before that pause (bearish: close below the pre-pause low);
//   - the external leg R0 created by a close-based BOS or flip is active from birth (that close IS its structural break);
//     a seeded R0 (given or automatic) is not a break and must earn activation like any other leg;
//   - corrections are measured against the TOP-MOST ACTIVE leg; inactive legs stay in the stack and pop as before.
// No ATR, size or N-bar thresholds (the pause is the minimal pullback: one non-extending bar).
// (V3.2a, "active = closed beyond the extreme its candidate corrected", failed charts 1/2-ext/4/5/6; see v3-suite/RESULTS_V3.2.md.)
// --- V3.1 header ---
// V3.1 structure engine (comparison, 2026-10-13): RESEARCH HARNESS ONLY. Based on V3.0.1; the ONLY change is how a candidate /
// structural swing is CONFIRMED (cfg.confirm):
//   "fractal"     = V3/V3.0.1 behaviour (the existing detectSwingPoints(5, 0.4) layer at index+5)  [identity check];
//   "right"       = V3.1 (b): the swing's extreme is not exceeded by any of the next `lookback` completed bars; no left-side window,
//                   no size filter. Confirmation bar = index + lookback;
//   "leftBounded" = V3.1 (a), telemetry: the same strict fractal tests and 0.4·ATR size filter as the swing layer, but the left window
//                   stops at the start of the correction (the bar after the leg extreme the swing corrects).
// Candidate creation (≥ 50%), LATEST, the reference-leg stack, close-based BOS/flip, pending and fallback are unchanged.
// --- V3.0.1 header ---
// V3.0.1 structure engine (correctness fix of frozen V3, 2026-10-13): RESEARCH HARNESS ONLY.
// The ONLY change from frozen V3: step() copies the pending object (and its pick) instead of sharing it with the previous state.
// Frozen V3 wrote the pending pick's confirmation status into an object still referenced by earlier stored states.
// No structure rule changes.
// --- frozen V3 header ---
// V3 structure engine: RESEARCH HARNESS ONLY. Not wired to production, the zone engine or any trading path.
// One pure engine, any timeframe: step(state, bar) → { state, events }. Each (pair, timeframe) owns one state; nothing is shared.
// Rules (user-approved 2026-10-13; hypotheses from charts 1–4):
//   - External structure (trend + protected swing P) controls bias. P flips only on a candle CLOSE beyond it.
//   - Depth uses wick extremes; exactly 50.0% counts. A correction ≥ 50% of the CURRENT reference leg (top of the stack) records a
//     qualifying correction swing (candidate) and the leg's extreme (structural). The first qualification since the last reset
//     freezes F (the continuation level = the external leg's extreme at that moment).
//   - Reference-leg stack (plain, no range gate): the LATEST valid candidate, once confirmed, opens a new reference leg. A wick
//     beyond a reference leg's origin pops it.
//   - A CLOSE beyond F is an external BOS: protect the LATEST valid qualifying candidate. A CLOSE beyond P flips the structure:
//     protect the LATEST valid qualifying structural. HIGHEST (the most extreme) is telemetry only.
//   - A swing is confirmed only by the existing causal swing layer at its normal confirmation bar (index + lookback), evaluated on
//     the bars up to that bar. If the chosen swing is not yet confirmed, it is PENDING_CONFIRMATION. If it fails, fall back to the
//     previous confirmed, still-valid swing of the same kind. If there is none, the old P stays (BOS) or the extreme since the
//     old P is used (flip).
//   - Valid = not traded through by any later wick. No state is ever applied retroactively: step() only sees bars ≤ t.
//   - Premium/discount: the external active leg only (100% = P, 0% = the extreme since P). Reference legs are never P/D ranges.
export type Bar = { t: number; closeTime: number; o: number; h: number; l: number; c: number };
export type Pt = { index: number; price: number };
export type Swing = { index: number; type: "high" | "low" };
export type Trend = "bull" | "bear";
export type Config = {
  tf: string;
  lookback: number; // the swing layer's confirmation lookback (bars to the right)
  depth: number; // 0.5
  swingsAsOf: (bars: Bar[]) => Swing[]; // causal swing layer; sees only the bars it is given
  seed?: { trend: Trend; pIndex: number; fromBar: number }; // research only: a given starting structure for short charts
  confirm?: "fractal" | "right" | "leftBounded"; // V3.1: default "fractal" (= V3.0.1)
  atr?: (bars: Bar[]) => number; // leftBounded only: ATR(14) of the bars given (the swing layer's own ATR)
  atrFilter?: number; // leftBounded only: 0.4 as in the swing layer
};
type Leg = { id: number; origin: Pt; born: "break" | "seed" | "push" };
type Q = Pt & { legId: number; extIndex: number; qualifiedAt: number; depth: number; conf: number | false | null; from: number }; // from = first bar of the correction (or leg) the swing ends // conf: bar | failed | not yet due
type Pending = { kind: "BOS" | "FLIP"; type: "high" | "low"; pick: Q; breakBar: number; prevP: Pt };
export type State = Readonly<{
  bars: readonly Bar[]; trend: Trend | null; P: Pt | null; F: Pt | null; stack: readonly Leg[]; nextLeg: number;
  cands: readonly Q[]; structs: readonly Q[]; pending: Pending | null; seedH: Pt | null; seedL: Pt | null;
}>;
export type Event = { tf: string; bar: number; knownAt: number; type: string; [k: string]: unknown };
export const initState = (): State => ({ bars: [], trend: null, P: null, F: null, stack: [], nextLeg: 0, cands: [], structs: [], pending: null, seedH: null, seedL: null });

export function step(cfg: Config, prev: State, bar: Bar): { state: State; events: Event[] } {
  const bars = [...prev.bars, bar], t = bars.length - 1;
  let { trend, P, F, nextLeg, seedH, seedL } = prev;
  // V3.0.1: never share (and later mutate) the previous state's pending object
  let pending: Pending | null = prev.pending ? { ...prev.pending, pick: { ...prev.pending.pick }, prevP: { ...prev.pending.prevP } } : null;
  let stack = [...prev.stack], cands = prev.cands.map((q) => ({ ...q })), structs = prev.structs.map((q) => ({ ...q }));
  const ev: Event[] = []; const emit = (type: string, x: Record<string, unknown> = {}) => ev.push({ tf: cfg.tf, bar: t, knownAt: bar.closeTime, type, ...x });
  const L = cfg.lookback;
  const hiB = (a: number, b: number): Pt => { let k = a; for (let i = a; i <= b; i++) if (bars[i].h > bars[k].h) k = i; return { index: k, price: bars[k].h }; };
  const loB = (a: number, b: number): Pt => { let k = a; for (let i = a; i <= b; i++) if (bars[i].l < bars[k].l) k = i; return { index: k, price: bars[k].l }; };
  // confirmation = the swing layer contains the swing at its normal confirmation bar (index + L), computed on bars [0..index+L]
  const confAt = (p: Pt & { from?: number }, type: "high" | "low"): number | false | null => {
    const due = p.index + L; if (due > t) return null;
    const mode = cfg.confirm ?? "fractal", i = p.index, hiSide = type === "high";
    const v = (k: number) => (hiSide ? bars[k].h : bars[k].l);
    if (mode === "right") { for (let d = 1; d <= L; d++) if (hiSide ? v(i + d) > p.price : v(i + d) < p.price) return false; return due; }
    if (mode === "leftBounded") {
      const left = Math.max(i - L, p.from ?? i - L);
      const win: number[] = []; for (let k = left; k <= i - 1; k++) win.push(k); for (let d = 1; d <= L; d++) win.push(i + d);
      for (const k of win) if (hiSide ? v(k) >= p.price : v(k) <= p.price) return false; // strict fractal tests, as the swing layer
      const atr = due + 1 >= 15 && cfg.atr ? cfg.atr(bars.slice(0, due + 1)) : 0, minSize = atr * (cfg.atrFilter ?? 0.4);
      if (minSize > 0) { const opp = win.map((k) => (hiSide ? bars[k].l : bars[k].h)); const size = hiSide ? p.price - Math.min(...opp) : Math.max(...opp) - p.price; if (size < minSize) return false; }
      return due;
    }
    return cfg.swingsAsOf(bars.slice(0, due + 1)).some((s) => s.index === p.index && s.type === type) ? due : false;
  };
  const sideOf = (tr: Trend) => ({ trendSide: (tr === "bull" ? "high" : "low") as "high" | "low", counterSide: (tr === "bull" ? "low" : "high") as "high" | "low" });
  const tradedThrough = (q: Pt, type: "high" | "low") => { for (let i = q.index + 1; i <= t; i++) if (type === "low" ? bars[i].l < q.price : bars[i].h > q.price) return true; return false; };
  const reset = (newP: Pt, why: string) => { P = newP; stack = [{ id: nextLeg++, origin: newP, born: why.startsWith("seed") ? "seed" : "break" }]; F = null; cands = []; structs = []; pending = null; emit("RESET", { why, P: newP }); };

  // ── seed ──
  if (trend === null) {
    const sw = cfg.swingsAsOf(bars);
    if (cfg.seed) {
      if (t === cfg.seed.fromBar) { trend = cfg.seed.trend; const p = cfg.seed.pIndex; reset({ index: p, price: trend === "bull" ? bars[p].l : bars[p].h }, "seed (given)"); emit("SEED", { trend, P }); }
    } else {
      seedH ??= (() => { const s = sw.find((s) => s.type === "high"); return s ? { index: s.index, price: bars[s.index].h } : null; })();
      seedL ??= (() => { const s = sw.find((s) => s.type === "low"); return s ? { index: s.index, price: bars[s.index].l } : null; })();
      if (seedH && seedL) {
        const from = Math.min(seedH.index, seedL.index);
        if (bar.c > seedH.price) { trend = "bull"; reset(loB(from, t), "seed: close above first swing high"); emit("SEED", { trend, P }); }
        else if (bar.c < seedL.price) { trend = "bear"; reset(hiB(from, t), "seed: close below first swing low"); emit("SEED", { trend, P }); }
      }
    }
    return { state: { bars, trend, P, F, stack, nextLeg, cands, structs, pending, seedH, seedL }, events: ev };
  }

  const dir = () => sideOf(trend!);
  const beyondTrend = (v: number, lvl: number) => (trend === "bull" ? v > lvl : v < lvl);
  const beyondCounter = (v: number, lvl: number) => (trend === "bull" ? v < lvl : v > lvl);
  const ext = (from: number) => (trend === "bull" ? hiB(from, t) : loB(from, t));
  const counterExt = (from: number) => (trend === "bull" ? loB(from, t) : hiB(from, t));
  const validC = (q: Q) => !tradedThrough(q, dir().counterSide);
  const validS = (q: Q) => !tradedThrough(q, dir().trendSide);
  const latest = (xs: Q[]) => xs.reduce<Q | null>((m, q) => (!m || q.index > m.index ? q : m), null);
  const mostExtreme = (xs: Q[], type: "high" | "low") => xs.reduce<Q | null>((m, q) => (!m || (type === "high" ? q.price > m.price : q.price < m.price) ? q : m), null);

  const flipTo = (pick: Q | null, oldP: Pt) => {
    const telemetry = mostExtreme(structs.filter(validS), dir().trendSide);
    const from = trend; trend = trend === "bull" ? "bear" : "bull";
    const chosen: Pt = pick ?? (from === "bull" ? hiB(oldP.index, t) : loB(oldP.index, t));
    emit("FLIP", { from, to: trend, close: bar.c, brokenP: oldP, protected: chosen, viaFallbackExtreme: !pick, highestTelemetry: telemetry });
    reset({ index: chosen.index, price: chosen.price }, "flip");
  };
  // LATEST valid swing → confirmed: protect it | not yet due: PENDING | failed: the previous confirmed valid swing (or none)
  type Pick = { protect: Q | null; pend: Q | null; failedLatest: Q | null };
  const choose = (xs: Q[], valid: (q: Q) => boolean): Pick => {
    const pool = xs.filter(valid).sort((a, b) => b.index - a.index); const top = pool[0];
    if (!top) return { protect: null, pend: null, failedLatest: null };
    if (top.conf === null) return { protect: null, pend: top, failedLatest: null };
    if (top.conf !== false) return { protect: top, pend: null, failedLatest: null };
    return { protect: pool.find((q) => q.conf !== null && q.conf !== false) ?? null, pend: null, failedLatest: top };
  };
  // ── 1. pending resolution ──
  if (pending) {
    const pd = pending; const type = pd.type;
    pd.pick.conf = pd.pick.conf ?? confAt(pd.pick, type);
    const through = tradedThrough(pd.pick, type);
    if (pd.pick.conf !== null && pd.pick.conf !== false && !through) {
      emit("PROMOTE", { kind: pd.kind, protected: { index: pd.pick.index, price: pd.pick.price }, confirmedAt: pd.pick.conf, breakBar: pd.breakBar });
      reset({ index: pd.pick.index, price: pd.pick.price }, `promote (${pd.kind})`);
    } else if (pd.pick.conf === false || through) {
      const pool = pd.kind === "BOS" ? cands : structs;
      const fb = pool.filter((q) => q.index < pd.pick.index && !tradedThrough(q, type) && q.conf !== null && q.conf !== false).sort((a, b) => b.index - a.index)[0];
      emit("INVALIDATE", { kind: pd.kind, pick: { index: pd.pick.index, price: pd.pick.price }, reason: through ? "traded through" : "not confirmed at index+lookback", fallback: fb ? { index: fb.index, price: fb.price } : null });
      if (fb) reset({ index: fb.index, price: fb.price }, `fallback (${pd.kind})`);
      else if (pd.kind === "BOS") reset(pd.prevP, "no confirmed fallback: old protected swing stays");
      else reset(trend === "bull" ? loB(pd.prevP.index, t) : hiB(pd.prevP.index, t), "no confirmed fallback: extreme since the old protected swing");
    } else {
      // still pending: only a close beyond the old protected swing can change anything
      if (pd.kind === "BOS" && beyondCounter(bar.c, pd.prevP.price)) { emit("PENDING_DROPPED_BY_FLIP", { pick: pd.pick.index }); pending = null; flipTo(choose(structs, validS).protect, pd.prevP); }
      return { state: { bars, trend, P, F, stack, nextLeg, cands, structs, pending, seedH, seedL }, events: ev };
    }
  }

  // ── 2. confirmations and pushes ──
  for (const q of cands) if (q.conf === null && q.index + L === t) { q.conf = confAt(q, dir().counterSide); emit(q.conf === false ? "CONFIRM_FAILED" : "CONFIRM", { side: dir().counterSide, swing: { index: q.index, price: q.price } }); }
  for (const q of structs) if (q.conf === null && q.index + L === t) q.conf = confAt(q, dir().trendSide);
  const top0 = stack[stack.length - 1];
  const lc = latest(cands.filter(validC));
  if (lc && lc.conf !== null && lc.conf !== false && lc.index > top0.origin.index && !stack.some((g) => g.origin.index === lc.index)) {
    stack.push({ id: nextLeg++, origin: { index: lc.index, price: lc.price }, born: "push" }); emit("PUSH", { origin: { index: lc.index, price: lc.price }, depthOfStack: stack.length });
  }

  // ── 3. wick updates: qualification against the top leg, then pops (qualifying again after each pop) ──
  const qualifyTop = () => {
    // a leg is active once it has continued on a closing basis through its own pre-pause extreme (breaks are active from birth)
    const activeLeg = (g: Leg) => {
      if (g.born === "break") return true;
      const bull = trend === "bull"; let m = NaN, pauseLvl = NaN;
      for (let i = g.origin.index + 1; i <= t; i++) {
        const x = bull ? bars[i].h : bars[i].l;
        if (!Number.isNaN(pauseLvl) && (bull ? bars[i].c > pauseLvl : bars[i].c < pauseLvl)) return true;
        if (Number.isNaN(m) || (bull ? x > m : x < m)) m = x; // extends the leg
        else if (Number.isNaN(pauseLvl) || (bull ? m < pauseLvl : m > pauseLvl)) pauseLvl = Number.isNaN(pauseLvl) ? m : (bull ? Math.min(pauseLvl, m) : Math.max(pauseLvl, m)); // a pause: remember the easiest pre-pause extreme to close through
      }
      return false;
    };
    let li = stack.length - 1; while (li > 0 && !activeLeg(stack[li])) li--;
    // V3.2c flip-anchor path: inactive legs above the top-most active one may still record their extreme as a structural
    for (let k = stack.length - 1; k > li; k--) {
      const g = stack[k]; if (g.origin.index + 1 > t) continue;
      const gx = ext(g.origin.index + 1); if (gx.index >= t) continue;
      const gce = counterExt(gx.index + 1), gsize = Math.abs(gx.price - g.origin.price); if (gsize <= 0) continue;
      const gd = Math.abs(gx.price - gce.price) / gsize;
      if (gd >= cfg.depth && !structs.some((q) => q.index === gx.index)) {
        const sq: Q = { ...gx, legId: g.id, extIndex: gx.index, qualifiedAt: t, depth: gd, conf: null, from: g.origin.index + 1 }; sq.conf = confAt(sq, dir().trendSide); structs.push(sq);
        emit("STRUCTURAL_ONLY", { structural: gx, depth: +gd.toFixed(4), leg: { origin: g.origin, ext: gx } });
      }
    }
    if (li === 0 && !activeLeg(stack[0])) return; // a seeded external leg that has not yet continued: nothing can qualify
    const leg = stack[li]; if (leg.origin.index + 1 > t) return;
    const x = ext(leg.origin.index + 1); // the leg's extreme comes after its origin bar
    if (x.index >= t) return; // a bar never corrects its own new extreme
    const ce = counterExt(x.index + 1); const size = Math.abs(x.price - leg.origin.price); if (size <= 0) return;
    const d = Math.abs(x.price - ce.price) / size; if (d < cfg.depth) return;
    if (!structs.some((q) => q.index === x.index)) { const s: Q = { ...x, legId: leg.id, extIndex: x.index, qualifiedAt: t, depth: d, conf: null, from: leg.origin.index + 1 }; s.conf = confAt(s, dir().trendSide); structs.push(s); }
    const same = cands.find((q) => q.legId === leg.id && q.extIndex === x.index && (validC(q) || q.conf === null || q.conf === false));
    if (same) {
      if (same.index !== ce.index && (trend === "bull" ? ce.price < same.price : ce.price > same.price)) { emit("DEEPEN", { from: { index: same.index, price: same.price }, to: ce, depth: d }); same.index = ce.index; same.price = ce.price; same.depth = d; same.conf = confAt(same, dir().counterSide); }
    } else if (!cands.some((q) => q.index === ce.index && validC(q))) {
      const q: Q = { ...ce, legId: leg.id, extIndex: x.index, qualifiedAt: t, depth: d, conf: null, from: x.index + 1 }; q.conf = confAt(q, dir().counterSide); cands.push(q);
      emit("QUALIFY", { candidate: ce, structural: x, depth: +d.toFixed(4), leg: { origin: leg.origin, ext: x }, stackDepth: stack.length });
    }
    if (!F) { F = ext(stack[0].origin.index + 1); emit("FREEZE", { F }); }
  };
  qualifyTop();
  while (stack.length > 1 && beyondCounter(trend === "bull" ? bar.l : bar.h, stack[stack.length - 1].origin.price)) {
    const popped = stack.pop()!; emit("POP", { origin: popped.origin, depthOfStack: stack.length }); qualifyTop();
  }

  // ── 4. closes: external BOS (beyond F), then flip (beyond P) ──
  if (F && beyondTrend(bar.c, F.price)) {
    const telemetry = mostExtreme(cands.filter(validC), dir().counterSide);
    const r = choose(cands, validC); const tel = telemetry && { index: telemetry.index, price: telemetry.price };
    if (r.pend) { emit("PENDING", { kind: "BOS", close: bar.c, F, pick: { index: r.pend.index, price: r.pend.price }, due: r.pend.index + L, highestTelemetry: tel }); pending = { kind: "BOS", type: dir().counterSide, pick: r.pend, breakBar: t, prevP: P! }; F = null; }
    else {
      if (r.failedLatest) emit("LATEST_FAILED_CONFIRMATION", { latest: { index: r.failedLatest.index, price: r.failedLatest.price }, fallback: r.protect && { index: r.protect.index, price: r.protect.price } });
      if (r.protect) { emit("BOS", { close: bar.c, F, protected: { index: r.protect.index, price: r.protect.price }, highestTelemetry: tel }); reset({ index: r.protect.index, price: r.protect.price }, "BOS"); }
      else { emit("BOS_NO_CONFIRMED_CANDIDATE", { close: bar.c, F }); reset(P!, "BOS without a confirmed candidate: old protected swing stays"); }
    }
  } else if (beyondCounter(bar.c, P!.price)) {
    const oldP = P!; const r = choose(structs, validS);
    if (r.pend) {
      emit("PENDING", { kind: "FLIP", close: bar.c, brokenP: oldP, pick: { index: r.pend.index, price: r.pend.price }, due: r.pend.index + L });
      const type = dir().trendSide, from = trend; trend = trend === "bull" ? "bear" : "bull"; emit("FLIP_BIAS", { from, to: trend });
      pending = { kind: "FLIP", type, pick: r.pend, breakBar: t, prevP: oldP }; P = null; F = null;
    } else {
      if (r.failedLatest) emit("LATEST_FAILED_CONFIRMATION", { latest: { index: r.failedLatest.index, price: r.failedLatest.price }, fallback: r.protect && { index: r.protect.index, price: r.protect.price } });
      flipTo(r.protect, oldP);
    }
  }
  return { state: { bars, trend, P, F, stack, nextLeg, cands, structs, pending, seedH, seedL }, events: ev };
}

// premium/discount of the external active leg (never of internal reference legs)
export function premiumDiscount(s: State) {
  if (!s.P || !s.trend) return null;
  const t = s.bars.length - 1; let k = Math.min(s.P.index + 1, t);
  for (let i = k; i <= t; i++) if (s.trend === "bull" ? s.bars[i].h > s.bars[k].h : s.bars[i].l < s.bars[k].l) k = i;
  const x = s.trend === "bull" ? s.bars[k].h : s.bars[k].l, p = s.P.price, close = s.bars[t].c;
  return { p100: p, p50: (p + x) / 2, p0: x, extIndex: k, closePct: ((close - x) / (p - x)) * 100 };
}
// deep-frozen, read-only snapshot for cross-timeframe readers
export function freezeDeep<T>(o: T): T { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o as object)) freezeDeep(v); } return o; }
