// Fill of canonical 1H structure bars from smc_scan_bars (D26). PURE — no database, no file IO.
// The runnable tool is local-runner/structure-bars-fill.ts; this module holds the rules so CI can test them.
//
//   - Span: 2026-10-09 21:00Z ≤ bar < the live writer's release time (STRUCTURE_BARS_RELEASE_AT); provenance smc_scan_bars_fill.
//   - smc_scan_bars keeps one row per DISTINCT value with the time that value was FIRST seen, so a row's first_seen_at is not
//     an observation time: a value first seen 5 min after close and re-seen at +40 min has only the +5 row. Observations are
//     therefore taken from the scan manifests: each 1H manifest is one observation of every closed bar in its array, with the
//     values that scan actually scored (latest stored value first seen at or before scanned_at), proven by the manifest's
//     content_hash via the snapshot module's own reconstruct(). A manifest that does not reconstruct is skipped, never trusted.
//   - Observation time = manifest fetched_at − FILL_OBSERVATION_SLACK_MS. fetched_at is stamped when the snapshot is built,
//     after the candles were fetched (and candleSource may serve them up to 90 s from cache), so one full 10-minute scan
//     period is subtracted: a scanned candle can never look more settled than it was.
//   - D9 then applies unchanged (evaluateObservation): the canonical bar is the first valid observation ≥ 15 min after close;
//     later differing observations become revision rows and never rewrite the canonical one.
import { reconstruct, type FormingBar } from "../smcScanSnapshot.ts";
import type { Candle } from "../smcAnalysis.ts";
import { evaluateObservation, H1_MS, planWrites, RESEARCH_IMPORT_END_MS, type Evaluation, type WritePlan } from "./canonicalBars.ts";

export const FILL_START_MS = RESEARCH_IMPORT_END_MS;
export const FILL_OBSERVATION_SLACK_MS = 10 * 60_000;

export interface FillManifest {
  scan_cycle_id: string; scanned_at: string; fetched_at: string | null;
  first_bar_time: string; last_bar_time: string; bar_count: number; content_hash: string;
  last_bar_closed: boolean | null; forming_bar: FormingBar | null;
}
export interface FillStoredBar { bar_time: string; bar_time_raw: string; open: number; high: number; low: number; close: number; first_seen_at: string; provider: string | null }

/** The array a manifest scored, from the bar rows: per bar_time the latest value first seen at or before scanned_at. */
export function valuesAtScan(m: FillManifest, bars: readonly FillStoredBar[]): Candle[] {
  const cutoff = Date.parse(m.scanned_at), from = Date.parse(m.first_bar_time), to = Date.parse(m.last_bar_time);
  const best = new Map<number, FillStoredBar>();
  for (const b of bars) {
    const t = Date.parse(b.bar_time), seen = Date.parse(b.first_seen_at);
    if (t < from || t > to || seen > cutoff) continue;
    const cur = best.get(t);
    if (!cur || seen > Date.parse(cur.first_seen_at)) best.set(t, b);
  }
  return [...best.values()].map((b) => ({ datetime: b.bar_time_raw, open: b.open, high: b.high, low: b.low, close: b.close } as Candle));
}

export interface FillPlan { inserts: WritePlan["inserts"]; revisions: WritePlan["revisions"]; counts: Record<string, number> }
type Candidate = Extract<Evaluation, { kind: "candidate" }>;

/**
 * Plan ONE SYMBOL's fill. `existing` = canonical rows already stored for that symbol (bar_time ISO → value), so a re-run
 * after a partial execute only adds what is missing. Rejected observations are counted, not returned: pre-settlement
 * observations are the expected majority, not data-quality events.
 */
export function planFill(symbol: string, manifests: readonly FillManifest[], bars: readonly FillStoredBar[], untilMs: number,
  existing: Map<string, { hash: string; open: number; high: number; low: number; close: number }>): FillPlan {
  if (untilMs % H1_MS !== 0 || untilMs <= FILL_START_MS) throw new Error(`until must be an hour boundary after ${new Date(FILL_START_MS).toISOString()}`);
  const counts: Record<string, number> = {};
  const bump = (k: string, n = 1) => { counts[k] = (counts[k] ?? 0) + n; };
  // one manifest per scan: the scalper's `top` and `context` 1H slots are the same array
  const byScan = new Map<string, FillManifest>();
  for (const m of manifests) if (!byScan.has(m.scan_cycle_id)) byScan.set(m.scan_cycle_id, m);
  const obsTime = (m: FillManifest) => Date.parse(m.fetched_at ?? m.scanned_at) - FILL_OBSERVATION_SLACK_MS;
  const ordered = [...byScan.values()].sort((a, b) => obsTime(a) - obsTime(b));
  const span = (ref: string) => ({ source: "smc_scan_bars_fill" as const, sourceRef: ref, minBarTime: FILL_START_MS, maxBarTimeExclusive: untilMs });
  const settled = new Map<string, Candidate[]>(); // bar_time → settled candidates in observation order, one per distinct value
  for (const m of ordered) {
    const r = reconstruct(m, valuesAtScan(m, bars));
    if (!r.ok) { bump("manifest_unreconstructable"); continue; }
    bump("manifest_verified");
    const closed = m.forming_bar ? r.candles.slice(0, -1) : r.candles; // the forming bar is never an observation of a closed bar
    for (const c of closed) {
      const t = Date.parse(c.datetime);
      if (t < FILL_START_MS || t >= untilMs) continue; // most of each 300-bar array lies before the span
      const e = evaluateObservation({ symbol, barTime: t, o: c.open, h: c.high, l: c.low, c: c.close, observedAt: obsTime(m), provider: null },
        span(`smc_scan_manifest:${m.scan_cycle_id}`));
      if (e.kind === "rejected") { bump(`observation_rejected:${e.reason}`); continue; }
      const list = settled.get(e.row.bar_time) ?? settled.set(e.row.bar_time, []).get(e.row.bar_time)!;
      if (!list.some((x) => x.hash === e.hash)) list.push(e);
    }
  }
  // first settled observation per bar → insert; later DIFFERENT settled values → revisions against that canonical value
  const firsts = [...settled.values()].map((l) => l[0]).sort((a, b) => a.row.bar_time.localeCompare(b.row.bar_time));
  const p1 = planWrites(firsts, existing, "smc_scan_bars_fill");
  const after = new Map(existing);
  for (const e of firsts) if (!existing.has(e.row.bar_time)) after.set(e.row.bar_time, { hash: e.hash, open: e.row.open, high: e.row.high, low: e.row.low, close: e.row.close });
  const p2 = planWrites([...settled.values()].flatMap((l) => l.slice(1)), after, "smc_scan_bars_fill");
  for (const [k, v] of Object.entries(p1.counts)) bump(k, v);
  for (const [k, v] of Object.entries(p2.counts)) bump(`later_${k}`, v);
  return { inserts: p1.inserts, revisions: [...p1.revisions, ...p2.revisions], counts };
}
