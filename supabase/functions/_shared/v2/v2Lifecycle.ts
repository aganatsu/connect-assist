// v2Lifecycle — the ONLY component that changes POI, setup or trade state (§16), in the §15 order.
// Covers §1.5–1.7, §1.9, §2.2–2.3, §3.8–3.12, §4, §5, §6, §9, §10, §11.6 (TRADABLE), §15, §16.
import { inTradingWindow, isExpected } from "./calendar.ts";
import { buildStore, type Dataset, firstOpenAtOrAfter, isProviderWide, lastClosed, type Store } from "./barStore.ts";
import { atrSum } from "./atr.ts";
import { PAIRS, type Pair, POI_LOOKBACK_1H, SPREAD_PTS, STEP_MS } from "./spec.ts";
import { type Dir, direction } from "./v2Direction.ts";
import { type Leg, type Poi, legsAt, poisOf } from "./v2Poi.ts";
import { chochOrigin, stopLoss, stopTooTight, stopTooWide } from "./v2Stop.ts";
import { selectTarget, type TargetResult } from "./v2Target.ts";
import { grossR, netR, rrAtLeastMin } from "./v2NetRR.ts";
import { size } from "./v2Sizing.ts";
import { feedAt, type Feed, newsBlock, type NewsFetch } from "./v2News.ts";
import { buildStructure, protectedSwing, type StructureIndex } from "./v2Structure.ts";

export type Entity = "POI" | "SETUP" | "TRADE" | "DIR";
export interface V2Event {
  t: number;                 // decision time
  pair: Pair;
  entity: Entity;
  id: string;
  event: string;             // QUALIFIED | <terminal reason> | ARMED | ENTERED | EXIT_SL | EXIT_TP | <direction>
  data?: Record<string, number | string | boolean | null>;
}

export interface Schedule {
  /** §11.6 TRADABLE for (pair, decision time). Default: true. */
  tradable(pair: Pair, t: number): boolean;
  /** Decision time of the run that evaluates (pair, t); ≥ t; equals t when TRADABLE. Default: t. */
  runTime(pair: Pair, t: number): number;
}

export interface EngineInput {
  dataset: Dataset;
  /** "REPLAY" → §8.4 (news not evaluated, feed AVAILABLE, no events). Otherwise fetches + evaluation run wall-clock times. */
  news: "REPLAY" | { fetches: NewsFetch[]; runClock(pair: Pair, t: number): number };
  schedule?: Schedule;
  /** §0.12 (W1) measured start M: decision times whose 5m bar opens before M are warm-up. Default: the dataset start (no warm-up). */
  measuredStart?: number;
}

interface PoiRec extends Poi { alive: boolean; reason?: string; endedAt?: number }
interface LegRec { leg: Leg; invalidSeen: boolean }
interface Setup { poi: PoiRec; dir: Dir; armIdx: number; scopeFrom: number; reaction: number }
interface Trade {
  id: string; poiId: string; dir: Dir; entry: number; sl: number; tp: number; lots: number;
  entryIdx: number; entryT: number; gapDuring: boolean;
}
interface PairState {
  pois: Map<string, PoiRec>;
  legs: Map<string, LegRec>;
  setup: Setup | null;
  trade: Trade | null;
  lastDir: string;
}

export interface EngineResult {
  events: V2Event[];
  trades: ClosedTrade[];
  store: Store;
  structure: Record<Pair, { "5m": StructureIndex; "15m": StructureIndex; "1h": StructureIndex }>;
  targets: Map<string, TargetResult>;    // per setup id at its CONFIRMED bar (debug/chart)
}
export interface ClosedTrade {
  id: string; pair: Pair; dir: Dir; entryT: number; exitT: number | null; entry: number; sl: number; tp: number;
  lots: number; exitPrice: number | null; exit: "EXIT_SL" | "EXIT_TP" | null; grossR: number | null; netR: number | null;
  gapDuring: boolean;
}

const M5 = STEP_MS["5m"], H1 = STEP_MS["1h"];

export function runEngine(input: EngineInput): EngineResult {
  const store = buildStore(input.dataset);
  const structure = {} as EngineResult["structure"];
  for (const p of PAIRS) {
    structure[p] = {
      "5m": buildStructure(store.series[p]["5m"]),
      "15m": buildStructure(store.series[p]["15m"]),
      "1h": buildStructure(store.series[p]["1h"]),
    };
  }
  const st = Object.fromEntries(PAIRS.map((p) => [p, { pois: new Map(), legs: new Map(), setup: null, trade: null, lastDir: "" }])) as Record<Pair, PairState>;
  const events: V2Event[] = [];
  const trades: ClosedTrade[] = [];
  const targets = new Map<string, TargetResult>();
  const sched: Schedule = input.schedule ?? { tradable: () => true, runTime: (_p, t) => t };
  const grid5 = store.grids["5m"];

  const emit = (t: number, pair: Pair, entity: Entity, id: string, event: string, data?: V2Event["data"]) =>
    events.push({ t, pair, entity, id, event, ...(data ? { data } : {}) });
  const liveCount = () => PAIRS.filter((p) => st[p].setup || st[p].trade).length;

  // Group (pair, decision time) by (run time, decision time); late decision times sort before a run's own time.
  const groups = new Map<string, { run: number; t: number; pairs: Pair[] }>();
  const lastRun = new Map<Pair, number>();
  for (let k = 0; k < grid5.length; k++) {
    const t = grid5[k] + M5;
    for (const p of PAIRS) {
      const run = sched.runTime(p, t);
      if (run < t) throw new Error("runTime earlier than decision time");
      if (run < (lastRun.get(p) ?? -Infinity)) throw new Error("§11.6: decision times of a pair must be processed in order");
      lastRun.set(p, run);
      if (sched.tradable(p, t) && run !== t) throw new Error("a TRADABLE decision time must run at its own time");
      const key = `${run}|${t}`;
      const g = groups.get(key) ?? { run, t, pairs: [] };
      g.pairs.push(p);
      groups.set(key, g);
    }
  }
  const ordered = [...groups.values()].sort((a, b) => a.run - b.run || a.t - b.t);

  for (const g of ordered) processDecision(g.t, g.pairs);

  // trades still open at the end of the data
  for (const p of PAIRS) {
    const tr = st[p].trade;
    if (tr) trades.push({ id: tr.id, pair: p, dir: tr.dir, entryT: tr.entryT, exitT: null, entry: tr.entry, sl: tr.sl, tp: tr.tp, lots: tr.lots, exitPrice: null, exit: null, grossR: null, netR: null, gapDuring: tr.gapDuring });
  }
  return { events, trades, store, structure, targets };

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  function feedFor(p: Pair, t: number): Feed {
    if (input.news === "REPLAY") return { available: true, events: [] };
    return feedAt(input.news.fetches, t, input.news.runClock(p, t));
  }

  function endPoi(t: number, p: Pair, poi: PoiRec, reason: string) {
    poi.alive = false; poi.reason = reason; poi.endedAt = t;
    emit(t, p, "POI", poi.id, reason);
  }
  function endSetup(t: number, p: Pair, reason: string, data?: V2Event["data"]) {
    const s = st[p].setup!;
    st[p].setup = null;
    emit(t, p, "SETUP", s.poi.id, reason, data);
  }

  function processDecision(t: number, pairs: Pair[]) {
    const k = store.index["5m"].get(t - M5)!;
    const h1 = store.index["1h"].get(t - H1);            // 1H slot closing at t, if expected
    const ctx = new Map<Pair, { tradable: boolean; feed: Feed; preTouch: PoiRec[] }>();

    for (const p of PAIRS) {
      if (!pairs.includes(p)) continue;
      const S = store.series[p], ix = structure[p];
      const tradable = sched.tradable(p, t);
      const raw = direction(S["1h"], ix["1h"], S["15m"], ix["15m"], t);
      const dirKey = `${raw.dir}:${raw.status}`;
      if (dirKey !== st[p].lastDir) { st[p].lastDir = dirKey; emit(t, p, "DIR", p, raw.dir, { status: raw.status, bias: raw.bias }); }
      // V2.1 (TP1, Q1 = a): D1′ is telemetry only — logged above, consumed by no trading decision
      const feed = feedFor(p, t);
      const bar = S["5m"].bars[k];

      // ── Step 1: data checks (1.3a, 1.5, 1.6, 1.9)
      if (!bar) {
        const reason = isProviderWide(store, "5m", k) ? "DATA_GAP_PROVIDER_WIDE" : "DATA_GAP_FRESHNESS_UNKNOWN";
        for (const poi of st[p].pois.values()) if (poi.alive && poi.bClose <= grid5[k]) endPoi(t, p, poi, reason);
        if (st[p].setup) endSetup(t, p, "DATA_GAP_ARMED");
        if (st[p].trade) st[p].trade!.gapDuring = true;
      }
      if (h1 !== undefined && !S["1h"].bars[h1]) {
        const start = store.grids["1h"][h1];
        const reason = isProviderWide(store, "1h", h1) ? "DATA_GAP_PROVIDER_WIDE" : "DATA_GAP_FRESHNESS_UNKNOWN";
        for (const poi of st[p].pois.values()) if (poi.alive && poi.bClose <= start) endPoi(t, p, poi, reason);
        if (st[p].setup && st[p].setup!.poi.bClose <= start) endSetup(t, p, "DATA_GAP_ARMED");
      }

      // ── Step 2: 1H updates — new legs/POIs, leg invalidation, lookback expiry
      if (h1 !== undefined) {
        const b1 = S["1h"].bars[h1];
        if (b1) {
          for (const leg of legsAt(p, S["1h"], ix["1h"], h1)) {
            st[p].legs.set(leg.id, { leg, invalidSeen: false });
            for (const poi of poisOf(leg, S["1h"])) {
              if (st[p].pois.has(poi.id)) continue;
              st[p].pois.set(poi.id, { ...poi, alive: true });
              emit(t, p, "POI", poi.id, "QUALIFIED", { type: poi.type, low: poi.low, high: poi.high, legId: leg.id });
            }
          }
          for (const lr of st[p].legs.values()) {
            if (lr.invalidSeen || h1 <= lr.leg.b) continue;
            const broke = lr.leg.dir === "LONG" ? b1.c < lr.leg.originLevel : b1.c > lr.leg.originLevel;
            if (!broke) continue;
            lr.invalidSeen = true;
            for (const poi of st[p].pois.values()) if (poi.alive && poi.legId === lr.leg.id) endPoi(t, p, poi, "LEG_INVALIDATED");
            if (st[p].setup && st[p].setup!.poi.legId === lr.leg.id) endSetup(t, p, "LEG_INVALIDATED");
          }
        }
        for (const poi of st[p].pois.values()) {
          if (poi.alive && poi.b < h1 - POI_LOOKBACK_1H + 1) endPoi(t, p, poi, "LOOKBACK_EXPIRED");
        }
      }

      // AM1: pre-touch state of bar k (after steps 1–2, before any touch/spend of bar k)
      const preTouch = [...st[p].pois.values()].filter((x) => x.alive).map((x) => ({ ...x }));
      ctx.set(p, { tradable, feed, preTouch });

      if (!bar) continue;
      // ── Step 3: open-trade exits
      exitStep(t, p, k);
      // ── Step 4: armed setups (armed before this decision time)
      if (st[p].setup) setupStep(t, p, k, ctx.get(p)!);
    }

    // ── Step 5 (joint across the pairs evaluated at t): touches, spending, arming, ranking
    const candidates: { p: Pair; poi: PoiRec }[] = [];
    if (grid5[k] < (input.measuredStart ?? input.dataset.start)) {
      // §0.12 warm-up: every touched fresh POI ends SPENT_WARMUP; nothing arms
      for (const p of PAIRS) {
        if (!ctx.has(p)) continue;
        const bar = store.series[p]["5m"].bars[k];
        if (!bar) continue;
        for (const x of [...st[p].pois.values()]) {
          if (x.alive && x.bClose <= grid5[k] && (x.dir === "LONG" ? bar.l <= x.high : bar.h >= x.low)) endPoi(t, p, x, "SPENT_WARMUP");
        }
      }
      return;
    }
    for (const p of PAIRS) {
      if (!ctx.has(p)) continue;
      const bar = store.series[p]["5m"].bars[k];
      if (!bar) continue;
      const c = ctx.get(p)!;
      const touched = [...st[p].pois.values()].filter((x) =>
        x.alive && x.bClose <= grid5[k] && (x.dir === "LONG" ? bar.l <= x.high : bar.h >= x.low)
      );
      for (const dir of ["LONG", "SHORT"] as Dir[]) {
        const group = touched.filter((x) => x.dir === dir);
        if (group.length === 0) continue;
        group.sort((a, b) =>
          (dir === "LONG" ? b.high - a.high : a.low - b.low) ||
          a.formationTime - b.formationTime ||
          (a.type === b.type ? 0 : a.type === "OB" ? -1 : 1) ||
          a.originTime - b.originTime
        );
        const [sel, ...rest] = group;
        for (const r of rest) endPoi(t, p, r, "SPENT_SAME_BAR");
        const reason =
          !inTradingWindow(t) ? "SPENT_OUTSIDE_WINDOW" :
          !c.tradable ? "SPENT_DATA_PENDING" :
          (c.feed.available && newsBlock(p, c.feed.events, t)) ? "SPENT_NEWS_BLOCK" :
          !c.feed.available ? "SPENT_FEED_UNAVAILABLE" :
          (st[p].setup || st[p].trade) ? "SPENT_PAIR_BUSY" : null;
        if (reason) endPoi(t, p, sel, reason);
        else candidates.push({ p, poi: sel });
      }
    }
    // §3.13 (CF1): both directions of one pair individually eligible on this bar → neither arms (no tie-break of any kind)
    for (const p of PAIRS) {
      const both = candidates.filter((c) => c.p === p);
      if (both.length < 2) continue;
      for (const c of both) endPoi(t, p, c.poi, "SPENT_CONFLICT");
      for (const c of both) candidates.splice(candidates.indexOf(c), 1);
    }
    const free = 3 - liveCount();
    let armed = candidates;
    if (candidates.length > free) {
      const L1 = lastClosed(store.grids["1h"], H1, t);
      const keyed = candidates.map((c) => ({ ...c, sum: L1 >= 0 ? atrSum(store.series[c.p]["1h"], L1) : null }));
      keyed.sort((a, b) => {
        if ((a.sum === null) !== (b.sum === null)) return a.sum === null ? 1 : -1;
        if (a.sum !== null && b.sum !== null) {
          const d = SPREAD_PTS[a.p] * b.sum - SPREAD_PTS[b.p] * a.sum;  // spreadA/atrA vs spreadB/atrB
          if (d !== 0) return d;
        }
        return PAIRS.indexOf(a.p) - PAIRS.indexOf(b.p);
      });
      armed = keyed.slice(0, Math.max(0, free));
      for (const c of keyed.slice(Math.max(0, free))) endPoi(t, c.p, c.poi, "SPENT_CAP");
    }
    const newly: Pair[] = [];
    for (const c of armed) {
      endPoi(t, c.p, c.poi, "ARMED");
      const s5 = store.series[c.p]["5m"];
      st[c.p].setup = {
        poi: c.poi, dir: c.poi.dir, armIdx: k,
        scopeFrom: firstOpenAtOrAfter(s5.grid, c.poi.bClose),
        reaction: c.poi.dir === "LONG" ? Infinity : -Infinity,
      };
      emit(t, c.p, "SETUP", c.poi.id, "ARMED");
      newly.push(c.p);
    }
    for (const p of PAIRS) if (newly.includes(p)) setupStep(t, p, k, ctx.get(p)!);
  }

  function setupStep(t: number, p: Pair, k: number, c: { tradable: boolean; feed: Feed; preTouch: PoiRec[] }) {
    const s = st[p].setup!;
    const s5 = store.series[p]["5m"];
    const bar = s5.bars[k]!;
    s.reaction = s.dir === "LONG" ? Math.min(s.reaction, bar.l) : Math.max(s.reaction, bar.h);
    // V2.1: no POI-far-edge invalidation (LO1, §4.2/§5.4) and no DIRECTION_FLIP (TP1, §2.3); LEG_INVALIDATED (step 2) is the only
    // price-based setup end
    if (!c.feed.available) return endSetup(t, p, "NEWS_FEED_UNAVAILABLE");
    const ps = protectedSwing(structure[p]["5m"], s.dir === "LONG" ? "H" : "L", s.scopeFrom, k);
    if (ps && ps.breakIdx === k) {
      if (!c.tradable) return endSetup(t, p, "DATA_PENDING_CONFIRMATION");
      if (newsBlock(p, c.feed.events, t)) return endSetup(t, p, "NEWS_BLOCKED_CONFIRMATION");
      emit(t, p, "SETUP", s.poi.id, "CONFIRMED", { protectedSwing: s5.grid[ps.i], level: ps.level });
      return entryStep(t, p, k, c, ps.i);
    }
    if (inTradingWindow(t) && !(isExpected(t) && inTradingWindow(t + M5))) return endSetup(t, p, "EXPIRED");
  }

  function entryStep(t: number, p: Pair, k: number, c: { preTouch: PoiRec[] }, psIdx: number) {
    const s = st[p].setup!;
    const S = store.series[p];
    const entry = S["5m"].bars[k]!.c;
    const origin = chochOrigin(s.dir, S["5m"], psIdx, k);                 // §5.3 (SA1)
    const L1 = lastClosed(S["1h"].grid, H1, t);
    const sum = L1 >= 0 ? atrSum(S["1h"], L1) : null;
    const opp: Dir = s.dir === "LONG" ? "SHORT" : "LONG";
    if (origin === null) return endSetup(t, p, "DATA_GAP_ENTRY", { entry, why: "choch-origin" });
    const sl = stopLoss(s.dir, origin);                                     // §6.2 (SA1)
    const dist = Math.abs(entry - sl);
    const base = { entry, sl, reaction: s.reaction };
    if (sum === null) return endSetup(t, p, "DATA_GAP_ENTRY", { ...base, why: "atr" });
    if (stopTooWide(dist, sum)) return endSetup(t, p, "STOP_TOO_WIDE", base);
    if (stopTooTight(p, dist)) return endSetup(t, p, "STOP_TOO_TIGHT", base);
    const oppAlive = c.preTouch.filter((x) => x.dir === opp);
    const inside = oppAlive.find((x) => x.low <= entry && entry <= x.high);
    if (inside) return endSetup(t, p, "OPPOSING_POI_CONTAINS_ENTRY", { ...base, opposing: inside.id });
    const oppUnknown = [...st[p].pois.values()].filter((x) =>
      x.dir === opp && !x.alive && (x.reason === "DATA_GAP_FRESHNESS_UNKNOWN" || x.reason === "DATA_GAP_PROVIDER_WIDE") &&
      x.endedAt! <= t && x.b >= L1 - POI_LOOKBACK_1H + 1 && !st[p].legs.get(x.legId)!.invalidSeen
    );
    const tr = selectTarget({ dir: s.dir, entry, t, k, s5: S["5m"], s1h: S["1h"], ix1h: structure[p]["1h"], opposingAlive: oppAlive, opposingUnknown: oppUnknown });
    targets.set(`${s.poi.id}@${t}`, tr);
    if (tr.observabilityFail) return endSetup(t, p, "DATA_GAP_ENTRY", { ...base, why: tr.observabilityFail });
    if (tr.selected === null) return endSetup(t, p, "NO_TARGET", base);
    const tp = tr.selected;
    if (!rrAtLeastMin(p, entry, sl, tp)) return endSetup(t, p, "RR_BELOW_MIN", { ...base, tp });
    const sz = size(p, entry, sl);
    if (!sz.ok) return endSetup(t, p, "SIZING_FAILED", { ...base, tp });
    endSetup(t, p, "ENTERED", { ...base, tp, lots: sz.lots, limitedBy: tr.limitedBy });
    st[p].trade = { id: `${s.poi.id}@${t}`, poiId: s.poi.id, dir: s.dir, entry, sl, tp, lots: sz.lots, entryIdx: k, entryT: t, gapDuring: false };
  }

  function exitStep(t: number, p: Pair, k: number) {
    const tr = st[p].trade;
    if (!tr || tr.entryIdx >= k) return;
    const s5 = store.series[p]["5m"];
    const bar = s5.bars[k]!;
    const gapBefore = k === 0 || s5.bars[k - 1] === null || s5.grid[k - 1] + M5 !== s5.grid[k];
    let exit: "EXIT_SL" | "EXIT_TP" | null = null;
    if (gapBefore) {
      if (tr.dir === "LONG" ? bar.o <= tr.sl : bar.o >= tr.sl) exit = "EXIT_SL";
      else if (tr.dir === "LONG" ? bar.o >= tr.tp : bar.o <= tr.tp) exit = "EXIT_TP";
    }
    if (!exit) {
      if (tr.dir === "LONG" ? bar.l <= tr.sl : bar.h >= tr.sl) exit = "EXIT_SL";
      else if (tr.dir === "LONG" ? bar.h >= tr.tp : bar.l <= tr.tp) exit = "EXIT_TP";
    }
    if (!exit) return;
    const px = exit === "EXIT_SL" ? tr.sl : tr.tp;
    const g = grossR(tr.dir, tr.entry, tr.sl, px), n = netR(p, tr.dir, tr.entry, tr.sl, px);
    emit(t, p, "TRADE", tr.id, exit, { exitPrice: px, gapDuring: tr.gapDuring });
    trades.push({ id: tr.id, pair: p, dir: tr.dir, entryT: tr.entryT, exitT: t, entry: tr.entry, sl: tr.sl, tp: tr.tp, lots: tr.lots, exitPrice: px, exit, grossR: g, netR: n, gapDuring: tr.gapDuring });
    st[p].trade = null;
  }
}
