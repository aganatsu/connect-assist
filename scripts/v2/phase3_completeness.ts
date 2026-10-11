// Phase 3 completeness report (spec §12.1e): per series first/last bar, expected vs present intervals, MISSING list,
// provider-wide gaps, bars dropped as stamped in closed time, and the complete eligible NY trading days of the window.
//   deno run --allow-read scripts/v2/phase3_completeness.ts --dataset <dir>/dataset.json --measured-start 2026-09-27T21:00:00Z
import { buildStore, type Dataset } from "../../supabase/functions/_shared/v2/barStore.ts";
import { isExpected, nyParts, tradingDayOf, tradingDayStart } from "../../supabase/functions/_shared/v2/calendar.ts";
import { PAIRS, STEP_MS, type TF } from "../../supabase/functions/_shared/v2/spec.ts";

export interface Completeness {
  series: { pair: string; tf: TF; first: string | null; last: string | null; expected: number; present: number; missing: string[]; droppedClosedTime: number }[];
  providerWide: Record<TF, string[]>;
  days: { day: string; coverage: boolean; noMissingInLookback: boolean }[];
  completeDays: number;
}

/** Lookback per §12.1e at a day's start: 200 1H (≥ 15 for ATR), 96 15m, 1,440 5m expected intervals. */
const NEED: Record<TF, number> = { "1h": 200, "15m": 96, "5m": 1440 };

export function completeness(ds: Dataset, measuredStart: number): Completeness {
  const store = buildStore(ds);
  const iso = (t: number) => new Date(t).toISOString();
  const series: Completeness["series"] = [];
  const providerWide = { "5m": [], "15m": [], "1h": [] } as Record<TF, string[]>;
  for (const tf of ["1h", "15m", "5m"] as TF[]) {
    const g = store.grids[tf];
    for (let i = 0; i < g.length; i++) if (PAIRS.every((p) => store.series[p][tf].bars[i] === null)) providerWide[tf].push(iso(g[i]));
    for (const p of PAIRS) {
      const s = store.series[p][tf];
      const present = s.bars.filter(Boolean) as { t: number }[];
      const raw = ds.bars[p]?.[tf] ?? [];
      series.push({
        pair: p, tf, first: present.length ? iso(present[0].t) : null, last: present.length ? iso(present[present.length - 1].t) : null,
        expected: g.length, present: present.length, missing: s.grid.filter((_, i) => !s.bars[i]).map(iso),
        droppedClosedTime: raw.filter((b) => b.t >= ds.start && b.t < ds.end && !isExpected(b.t)).length,
      });
    }
  }
  // eligible Monday–Friday NY trading days inside the window [M, end)
  const days: Completeness["days"] = [];
  const seen = new Set<string>();
  for (let t = measuredStart; t < ds.end; t += STEP_MS["5m"]) {
    if (!isExpected(t)) continue;
    const d = tradingDayOf(t);
    if (seen.has(d)) continue;
    seen.add(d);
    const [y, m, dd] = d.split("-").map(Number);
    const dow = nyParts(Date.UTC(y, m - 1, dd, 16)).dow;
    if (dow < 1 || dow > 5) continue;
    const start = tradingDayStart(d);
    // the full measured day must lie inside the dataset (and inside the measured window)
    const [ey, em, ed] = d.split("-").map(Number);
    const dayEnd = tradingDayStart(new Date(Date.UTC(ey, em - 1, ed + 1)).toISOString().slice(0, 10));
    let coverage = start >= measuredStart && dayEnd <= ds.end, clean = true;
    for (const tf of ["1h", "15m", "5m"] as TF[]) {
      const g = store.grids[tf];
      const before = g.filter((x) => x + STEP_MS[tf] <= start);
      const need = before.slice(-NEED[tf]);
      if (need.length < NEED[tf]) { coverage = false; continue; }
      const from = g.indexOf(need[0]);
      for (const p of PAIRS) for (let i = from; i < from + need.length; i++) if (!store.series[p][tf].bars[i]) clean = false;
    }
    days.push({ day: d, coverage, noMissingInLookback: clean });
  }
  return { series, providerWide, days, completeDays: days.filter((d) => d.coverage).length };
}

if (import.meta.main) {
  const arg = (k: string) => { const i = Deno.args.indexOf(k); return i >= 0 ? Deno.args[i + 1] : undefined; };
  const ds: Dataset = JSON.parse(await Deno.readTextFile(arg("--dataset")!));
  const r = completeness(ds, Date.parse(arg("--measured-start") ?? "2026-09-27T21:00:00Z"));
  for (const s of r.series) console.log(`${s.pair} ${s.tf.padEnd(3)} ${s.first} → ${s.last}  present ${s.present}/${s.expected}  MISSING ${s.missing.length}  dropped(closed-time) ${s.droppedClosedTime}${s.missing.length ? "  " + s.missing.slice(0, 6).join(",") + (s.missing.length > 6 ? "…" : "") : ""}`);
  for (const tf of ["1h", "15m", "5m"] as TF[]) console.log(`provider-wide MISSING ${tf}: ${r.providerWide[tf].length}`);
  for (const d of r.days) console.log(`${d.day}  coverage ${d.coverage ? "yes" : "NO"}  lookback without MISSING ${d.noMissingInLookback ? "yes" : "no"}`);
  console.log(`complete eligible days: ${r.completeDays} (need ≥ 10) → ${r.completeDays >= 10 ? "PASS" : "INSUFFICIENT — no Phase 3 verdict"}`);
  if (r.completeDays < 10) Deno.exit(2);
}
