/**
 * SMC_ROUTE1_EXIT_MANAGEMENT_V1 — fixed entries, seven exit arms.
 *
 * Entries are FROZEN: same 35,187 Route 1 setups, same instant, entry price,
 * initial stop, 2R target, direction and cost model. Only the exit changes.
 *
 * Every management event is resolved on the 1m tape. Within a single minute
 * the order of two opposing touches is unknowable, so any arm whose outcome
 * depends on that order is marked AMBIGUOUS for that trade and excluded from
 * its clean metrics — never settled by code precedence.
 *
 *   deno run --allow-read --allow-write --allow-env --allow-net \
 *     local-runner/smc-route1-exits.ts [SYMBOL]
 */

import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { loadCorpus, PRODUCTION_UNIVERSE } from "./smc-corpus-fetch.ts";

const MAX_HOLD_MIN = 4 * 60;      // production maxHoldHours = 4
const WALK_CAP_MIN = 10_080;      // 7 days, then OPEN
const ARMS = ["CONTROL", "A_4H", "B_BE", "C_TRAIL", "D_PARTIAL", "E_PART_BE", "F_4H_BE", "G_ALL"] as const;
type Arm = typeof ARMS[number];

export interface ExitRow {
  symbol: string; t: string; session: string; direction: string;
  disp: number | null; zoneScore: number | null; confluence: number | null;
  costR: number;
  maeR: number; mfeR: number;
  t05: number | null; t1: number | null; t15: number | null; t2: number | null;
  tSL: number | null; openAt4h: boolean;
  /** gross R per arm; null = ambiguous or unresolved. */
  g: Record<string, number | null>;
  /** exit label per arm. */
  o: Record<string, string>;
  holdMin: Record<string, number | null>;
}

if (import.meta.main) {
  const only = Deno.args[0];
  for (const sym of (only ? [only] : PRODUCTION_UNIVERSE)) {
    const out = new URL(`./.cache/ex_${sym.replace("/", "")}.json`, import.meta.url);
    try { Deno.readTextFileSync(out); console.log(`${sym}: cached`); continue; } catch { /* run */ }

    let src: Array<Record<string, unknown>>;
    try {
      src = JSON.parse(Deno.readTextFileSync(
        new URL(`./.cache/fs_${sym.replace("/", "")}.json`, import.meta.url)));
    } catch { console.log(`${sym}: no fs_ source`); continue; }
    const setups = src.filter((r) => r.cfNetR !== null && r.entry !== null);
    const m1 = loadCorpus(sym, "1m");
    if (!m1.length) { console.log(`${sym}: no 1m`); continue; }
    const times = m1.map((c) => Date.parse(c.datetime));

    const rows: ExitRow[] = [];
    const t0 = Date.now();

    for (const s of setups) {
      const tMs = Date.parse(s.t as string);
      const long = s.direction === "long";
      const entry = s.entry as number, sl = s.sl as number, tp = s.tp as number;
      const risk = Math.abs(entry - sl);
      if (!(risk > 0)) continue;
      const costR = (s.costR ?? ((s.feat as Record<string, number>)?.costR)) as number ?? 0;
      const R = (p: number) => (long ? p - entry : entry - p) / risk;

      // binary search for the first 1m bar strictly after the scan instant
      let lo = 0, hi = times.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] <= tMs) lo = m + 1; else hi = m; }
      const start = lo;
      if (start >= m1.length) continue;

      let mae = 0, mfe = 0;
      let t05: number | null = null, t1: number | null = null,
          t15: number | null = null, t2: number | null = null, tSL: number | null = null;
      let openAt4h = false;
      const g: Record<string, number | null> = {}; const o: Record<string, string> = {};
      const hold: Record<string, number | null> = {};
      for (const a of ARMS) { g[a] = null; o[a] = "OPEN"; hold[a] = null; }

      // per-arm live state
      let beArmed = false;                 // B, E, F, G
      let partialDone = false;             // D, E, G
      let trailStop: number | null = null; // C
      let bestFav = 0;                     // running MFE in R, for the trail

      const settle = (arm: Arm, gross: number, label: string, i: number) => {
        if (o[arm] !== "OPEN") return;
        g[arm] = gross; o[arm] = label;
        hold[arm] = Math.round((times[i] - tMs) / 60_000);
      };
      const amb = (arm: Arm, i: number) => {
        if (o[arm] !== "OPEN") return;
        g[arm] = null; o[arm] = "AMBIGUOUS"; hold[arm] = Math.round((times[i] - tMs) / 60_000);
      };

      for (let i = start; i < m1.length; i++) {
        const el = Math.round((times[i] - tMs) / 60_000);
        if (el > WALK_CAP_MIN) break;
        const b = m1[i];
        const hiR = R(long ? b.high : b.low);     // favourable extreme of this minute
        const loR = R(long ? b.low : b.high);     // adverse extreme
        if (loR < mae) mae = loR;
        if (hiR > mfe) mfe = hiR;
        if (t05 === null && hiR >= 0.5) t05 = el;
        if (t1 === null && hiR >= 1) t1 = el;
        if (t15 === null && hiR >= 1.5) t15 = el;

        const hitTP = hiR >= 2;
        const hitSL = loR <= -1;
        if (t2 === null && hitTP) t2 = el;
        if (tSL === null && hitSL) tSL = el;
        const bothTPSL = hitTP && hitSL;

        // ── CONTROL, and the two arms that share its stop until 4h ──
        for (const arm of ["CONTROL", "A_4H"] as Arm[]) {
          if (o[arm] !== "OPEN") continue;
          if (arm === "A_4H" && el >= MAX_HOLD_MIN && !hitTP && !hitSL) {
            settle(arm, R(b.open), "TIME_4H", i); continue;
          }
          if (bothTPSL) { amb(arm, i); continue; }
          if (hitTP) settle(arm, 2, "TP", i);
          else if (hitSL) settle(arm, -1, "SL", i);
        }

        // ── B: breakeven at +1R ──
        for (const arm of ["B_BE", "F_4H_BE"] as Arm[]) {
          if (o[arm] !== "OPEN") continue;
          if (arm === "F_4H_BE" && el >= MAX_HOLD_MIN && !hitTP && !(beArmed ? loR <= 0 : hitSL)) {
            settle(arm, R(b.open), "TIME_4H", i); continue;
          }
          const stopHit = beArmed ? loR <= 0 : hitSL;
          if (hitTP && stopHit) { amb(arm, i); continue; }
          // arming and the stop firing inside one minute is also unorderable
          if (!beArmed && hiR >= 1 && hitSL) { amb(arm, i); continue; }
          if (hitTP) settle(arm, 2, "TP", i);
          else if (stopHit) settle(arm, beArmed ? 0 : -1, beArmed ? "BE" : "SL", i);
        }

        // ── C: trail 1R behind the best favourable price, armed at +1R ──
        if (o["C_TRAIL"] === "OPEN") {
          if (trailStop === null && hiR >= 1 && hitSL) amb("C_TRAIL", i);
          else {
            const stopR = trailStop;
            const stopHit = stopR !== null ? loR <= stopR : hitSL;
            if (hitTP && stopHit) amb("C_TRAIL", i);
            else if (hitTP) settle("C_TRAIL", 2, "TP", i);
            else if (stopHit) settle("C_TRAIL", stopR !== null ? stopR : -1,
              stopR !== null ? "TRAIL" : "SL", i);
          }
        }

        // ── D / E / G: 50% partial at +1R ──
        for (const arm of ["D_PARTIAL", "E_PART_BE", "G_ALL"] as Arm[]) {
          if (o[arm] !== "OPEN") continue;
          const beThis = (arm === "E_PART_BE" || arm === "G_ALL") && partialDone;
          if (arm === "G_ALL" && el >= MAX_HOLD_MIN && !hitTP && !(beThis ? loR <= 0 : hitSL)) {
            const rem = R(b.open);
            settle(arm, partialDone ? 0.5 * 1 + 0.5 * rem : rem, "TIME_4H", i); continue;
          }
          const stopHit = beThis ? loR <= 0 : hitSL;
          if (!partialDone && hiR >= 1 && hitSL) { amb(arm, i); continue; }
          if (hitTP && stopHit) { amb(arm, i); continue; }
          if (hitTP) settle(arm, partialDone ? 0.5 * 1 + 0.5 * 2 : 2, "TP", i);
          else if (stopHit) {
            const remR = beThis ? 0 : -1;
            settle(arm, partialDone ? 0.5 * 1 + 0.5 * remR : remR,
              partialDone ? (beThis ? "PARTIAL_BE" : "PARTIAL_SL") : "SL", i);
          }
        }

        // state updates happen AFTER this minute is evaluated
        if (!beArmed && hiR >= 1) beArmed = true;
        if (!partialDone && hiR >= 1) partialDone = true;
        if (hiR >= 1) {
          bestFav = Math.max(bestFav, hiR);
          trailStop = bestFav - 1;
        }
        if (el >= MAX_HOLD_MIN && !openAt4h) {
          openAt4h = o["CONTROL"] === "OPEN";
        }
        if (ARMS.every((a) => o[a] !== "OPEN")) break;
      }

      rows.push({
        symbol: sym, t: s.t as string, session: s.session as string,
        direction: s.direction as string,
        disp: ((s.feat as Record<string, number>)?.displacementCandles) ?? null,
        zoneScore: (s.zoneScore as number) ?? null, confluence: (s.confluence as number) ?? null,
        costR, maeR: mae, mfeR: mfe, t05, t1, t15, t2, tSL, openAt4h,
        g, o, holdMin: hold,
      });
    }

    Deno.writeTextFileSync(out, JSON.stringify(rows));
    console.log(`${sym}: ${rows.length} trades simulated across ${ARMS.length} arms, ` +
      `${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
