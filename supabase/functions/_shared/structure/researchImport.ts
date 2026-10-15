// Approved research-history import for canonical 1H structure bars (Q2, 2026-10-15). PURE — no database, no file IO.
// The runnable tool is local-runner/structure-bars-import.ts; this module holds the rules so CI can test them.
//
//   - Only the three approved datasets, identified by sha256 (verified by the tool before anything else).
//   - Canonical span: 2025-04-16 21:00Z ≤ bar < 2026-10-09 21:00Z. A dataset holding ANY 1H row at or after
//     2026-10-09 21:00Z is refused outright (the reserved V2.1.1 OOS window 2026-10-12 → 10-23 is never touched).
//   - Prices rounded to 5 decimal places (all six pairs); provenance = research_import; observed_at = the dataset's last retrieval.
//   - Overlapping smc_scan_bars observations are comparison / revision telemetry only and never overwrite these rows.
import { EPOCH_MS, evaluateObservation, H1_MS, RESEARCH_IMPORT_END_MS, STRUCTURE_PAIRS, type Evaluation } from "./canonicalBars.ts";

export const APPROVED_RESEARCH_DATASETS: ReadonlyArray<{ name: string; sha256: string; startMs: number; endMs: number }> = [
  { name: "validation-20250416-20260416", sha256: "c5655420cd2edf31edc7dafe83d85c1fbc7a7d7092be2e4c973e7578e6085183", startMs: Date.parse("2025-04-16T21:00:00Z"), endMs: Date.parse("2026-04-16T21:00:00Z") },
  { name: "v22-hist-20261013", sha256: "f9ac3466c19a8f7f9824b0988bf66827b739f2a082d81a8b2f2afa5be5305dcb", startMs: Date.parse("2026-04-16T21:00:00Z"), endMs: Date.parse("2026-09-07T21:00:00Z") },
  { name: "phase3-20261011T1837Z", sha256: "2cc0c4b3c5badf60b909759c083c40384cdef53b1d93bbd90c6a974ef679559f", startMs: Date.parse("2026-09-07T21:00:00Z"), endMs: Date.parse("2026-10-09T21:00:00Z") },
];

export interface ResearchDataset { start: number; end: number; bars: Record<string, Record<string, { t: number; o: number; h: number; l: number; c: number }[]>> }
export interface DatasetMeta { sha256: string; manifestSha256: string; retrievedAtMs: number }

/** Throws unless the dataset is one of the approved ones and its bytes match both the manifest and the approval list. */
export function assertApproved(meta: DatasetMeta) {
  const ok = APPROVED_RESEARCH_DATASETS.find((d) => d.sha256 === meta.sha256);
  if (!ok) throw new Error(`dataset sha256 ${meta.sha256} is not an approved research dataset`);
  if (meta.manifestSha256 !== meta.sha256) throw new Error(`dataset bytes ${meta.sha256} do not match the manifest ${meta.manifestSha256}`);
  if (!Number.isFinite(meta.retrievedAtMs)) throw new Error("manifest retrieval time missing");
  return ok;
}

/** Hard refusal: any 1H row (any symbol) at or after the import boundary aborts the whole dataset. */
export function assertNoRowAfterBoundary(ds: ResearchDataset) {
  for (const [sym, tfs] of Object.entries(ds.bars)) for (const b of tfs["1h"] ?? []) {
    if (!(b.t < RESEARCH_IMPORT_END_MS)) throw new Error(`refused: ${sym} 1H row at ${new Date(b.t).toISOString()} is at/after the import boundary 2026-10-09T21:00:00Z`);
  }
}

/** Evaluate every 1H row of the six pairs for the research_import path. */
export function evaluateResearchDataset(ds: ResearchDataset, meta: DatasetMeta): Evaluation[] {
  assertApproved(meta);
  assertNoRowAfterBoundary(ds);
  const span = { source: "research_import" as const, sourceRef: meta.sha256, minBarTime: EPOCH_MS, maxBarTimeExclusive: RESEARCH_IMPORT_END_MS };
  const out: Evaluation[] = [];
  for (const sym of STRUCTURE_PAIRS) for (const b of ds.bars[sym]?.["1h"] ?? []) {
    out.push(evaluateObservation({ symbol: sym, barTime: b.t, o: b.o, h: b.h, l: b.l, c: b.c, observedAt: meta.retrievedAtMs, provider: "twelvedata" }, span));
  }
  return out;
}

/** Expected FX-open hour count helper for dry-run reports. */
export const hoursBetween = (a: number, b: number) => Math.max(0, Math.floor((b - a) / H1_MS));
