/**
 * SMC_DISPLACEMENT_EXIT_HORIZON_V1 — fixed-horizon exit study.
 *
 * Entries are FROZEN at the Model A baseline: armed Route 1 + Zone Score gate,
 * NO confluence gate. Only the holding horizon varies.
 *
 * One 1m walk per trade produces every arm at once: the CONTROL resolution
 * (first TP or SL) plus the executable price at each pre-registered horizon.
 * An arm exits at its horizon only when CONTROL had not already resolved.
 *
 * Same-minute TP-and-SL is AMBIGUOUS and excluded from that trade's clean
 * metrics rather than settled by code precedence.
 *
 *   deno run --allow-read --allow-write --allow-env --allow-net \
 *     local-runner/smc-displacement-horizon.ts [SYMBOL]
 */

import { loadCorpus, PRODUCTION_UNIVERSE } from "./smc-corpus-fetch.ts";

/** Pre-registered. No other horizon is evaluated. */
export const HORIZONS_H = [2, 4, 6, 8, 12, 24] as const;
const WALK_CAP_MIN = 10_080;   // 7 days, then unresolved

export interface HorizonRow {
  symbol: string; t: string; session: string; direction: string;
  zoneTF: string | null; disp: number | null;
  costR: number;
  ctrlGross: number | null; ctrlOutcome: string; ctrlHoldMin: number | null;
  maeR: number; mfeR: number;
  t05: number | null; t1: number | null; t15: number | null; t2: number | null; tSL: number | null;
  /** gross R per horizon; null = ambiguous/unresolved. */
  hGross: Record<string, number | null>;
  hOutcome: Record<string, string>;
  hHoldMin: Record<string, number | null>;
}

if (import.meta.main) {
  const only = Deno.args[0];
  for (const sym of (only ? [only] : PRODUCTION_UNIVERSE)) {
    const out = new URL(`./.cache/hz_${sym.replace("/", "")}.json`, import.meta.url);
    try { Deno.readTextFileSync(out); console.log(`${sym}: cached`); continue; } catch { /* run */ }

    let src: Array<Record<string, unknown>>;
    try {
      src = JSON.parse(Deno.readTextFileSync(
        new URL(`./.cache/fs_${sym.replace("/", "")}.json`, import.meta.url)));
    } catch { console.log(`${sym}: no fs_ source`); continue; }

    // MODEL A entry population: armed + Zone Score gate, NO confluence gate.
    const setups = src.filter((r) =>
      r.armed === true && r.passZoneScore === true && r.entry !== null && r.cfNetR !== null);

    const m1 = loadCorpus(sym, "1m");
    if (!m1.length) { console.log(`${sym}: no 1m`); continue; }
    const times = m1.map((c) => Date.parse(c.datetime));
    const rows: HorizonRow[] = [];
    const t0 = Date.now();

    for (const s of setups) {
      const tMs = Date.parse(s.t as string);
      const long = s.direction === "long";
      const entry = s.entry as number, sl = s.sl as number, tp = s.tp as number;
      const risk = Math.abs(entry - sl);
      if (!(risk > 0)) continue;
      const costR = ((s.feat as Record<string, number>)?.costR) ?? 0;
      const R = (p: number) => (long ? p - entry : entry - p) / risk;

      let lo = 0, hi = times.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] <= tMs) lo = m + 1; else hi = m; }
      const start = lo;
      if (start >= m1.length) continue;

      let mae = 0, mfe = 0;
      let t05: number | null = null, t1: number | null = null, t15: number | null = null,
          t2: number | null = null, tSL: number | null = null;
      let ctrlGross: number | null = null, ctrlOutcome = "UNRESOLVED", ctrlHold: number | null = null;
      const hG: Record<string, number | null> = {}, hO: Record<string, string> = {},
            hH: Record<string, number | null> = {};
      for (const h of HORIZONS_H) { hG[`h${h}`] = null; hO[`h${h}`] = "UNRESOLVED"; hH[`h${h}`] = null; }

      for (let i = start; i < m1.length; i++) {
        const el = Math.round((times[i] - tMs) / 60_000);
        if (el > WALK_CAP_MIN) break;
        const b = m1[i];
        const hiR = R(long ? b.high : b.low);
        const loR = R(long ? b.low : b.high);
        if (loR < mae) mae = loR;
        if (hiR > mfe) mfe = hiR;
        if (t05 === null && hiR >= 0.5) t05 = el;
        if (t1 === null && hiR >= 1) t1 = el;
        if (t15 === null && hiR >= 1.5) t15 = el;
        const hitTP = hiR >= 2, hitSL = loR <= -1;
        if (t2 === null && hitTP) t2 = el;
        if (tSL === null && hitSL) tSL = el;

        // Each horizon arm: time-exit only if still open when the clock passes.
        for (const h of HORIZONS_H) {
          const k = `h${h}`;
          if (hO[k] !== "UNRESOLVED") continue;
          const limit = h * 60;
          if (el >= limit && !hitTP && !hitSL) {
            hG[k] = R(b.open); hO[k] = "TIME_EXIT"; hH[k] = el; continue;
          }
          if (hitTP && hitSL) { hG[k] = null; hO[k] = "AMBIGUOUS"; hH[k] = el; continue; }
          if (hitTP) { hG[k] = 2; hO[k] = "TP"; hH[k] = el; }
          else if (hitSL) { hG[k] = -1; hO[k] = "SL"; hH[k] = el; }
        }

        if (ctrlOutcome === "UNRESOLVED") {
          if (hitTP && hitSL) { ctrlGross = null; ctrlOutcome = "AMBIGUOUS"; ctrlHold = el; }
          else if (hitTP) { ctrlGross = 2; ctrlOutcome = "TP"; ctrlHold = el; }
          else if (hitSL) { ctrlGross = -1; ctrlOutcome = "SL"; ctrlHold = el; }
        }
        if (ctrlOutcome !== "UNRESOLVED" && HORIZONS_H.every((h) => hO[`h${h}`] !== "UNRESOLVED")) break;
      }

      rows.push({
        symbol: sym, t: s.t as string, session: s.session as string,
        direction: s.direction as string, zoneTF: (s.selectedTF as string) ?? null,
        disp: ((s.feat as Record<string, number>)?.displacementCandles) ?? null,
        costR, ctrlGross, ctrlOutcome, ctrlHoldMin: ctrlHold,
        maeR: mae, mfeR: mfe, t05, t1, t15, t2, tSL,
        hGross: hG, hOutcome: hO, hHoldMin: hH,
      });
    }

    Deno.writeTextFileSync(out, JSON.stringify(rows));
    console.log(`${sym}: ${rows.length} Model A entries x ${HORIZONS_H.length} horizons, ` +
      `${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
