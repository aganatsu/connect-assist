/**
 * Corpus insert planning: batch-local parent handles -> real database ids.
 *
 * THE BUG THIS FIXES. A Weekly -> Daily -> 4H demonstration arrives as one
 * batch in which the daily row's parent is the weekly row of the SAME batch.
 * Neither has a database id yet, so the caller can only name its parent by a
 * batch-local handle. The first version passed that handle straight into
 * parent_example_id, where it either violated the uuid type or the foreign key
 * — and because all three rows went in one upsert, the parent had no id to
 * reference even if the type had matched.
 *
 * The result was that a refinement chain could not actually be stored. Every
 * row landed, the response said so, and the parent/child edges were silently
 * null: the one structure the corpus exists to record was the one thing lost.
 *
 * So a batch is planned into WAVES. Roots first, then rows whose parent was
 * resolved by an earlier wave. After each wave the caller reports the real ids
 * it received and the next wave's parent_example_id is rewritten to them.
 * example_group_id is filled in the same pass: every row in a chain shares one
 * group, minted per chain only when the caller supplied none.
 */

import { validateCorpusExamples } from "./ipoZones.ts";

export interface PlannedCorpusRow {
  /** The caller's handle for this row, if any. Never written to the database. */
  localId: string | null;
  /** Index in the caller's original array, so an error can point at it. */
  sourceIndex: number;
  /** Parent handle local to this batch; resolved to a real id before insert. */
  localParentId: string | null;
  row: Record<string, unknown>;
}

export interface CorpusInsertPlan {
  waves: PlannedCorpusRow[][];
  problems: Array<{ row: number; why: string }>;
}

/**
 * Natural key of a corpus row — the same tuple the unique constraint uses.
 *
 * user_id is deliberately absent: the constraint is now
 * (symbol, timeframe, candle_datetime, direction) project-wide, so two
 * accounts can no longer store contradictory versions of one demonstration.
 */
export function corpusNaturalKey(
  e: { symbol?: unknown; timeframe?: unknown; candleDatetime?: unknown; candle_datetime?: unknown; direction?: unknown },
): string {
  const dt = (e as any).candleDatetime ?? (e as any).candle_datetime ?? null;
  return `${e.symbol}|${e.timeframe}|${dt ?? "~"}|${e.direction}`;
}

/**
 * Orders a corpus batch into insertable waves and resolves local parent refs.
 *
 * mintGroupId is injected rather than called directly, so a test can assert the
 * grouping without depending on random uuids.
 */
export function planCorpusInsert(
  rows: any[],
  mintGroupId: () => string,
  /**
   * example_group_id of rows ALREADY stored, keyed by corpusNaturalKey.
   *
   * Without this a re-send mints a fresh uuid and the upsert overwrites the
   * group, so the row ids and edges survive but the DEMONSTRATION IDENTITY
   * changes — every earlier reference to that group silently stops matching,
   * and the coverage report would count one demonstration as two across runs.
   * The group is the demonstration, so an existing one always wins over a
   * minted one.
   */
  existingGroupByKey: Map<string, string> = new Map(),
): CorpusInsertPlan {
  const problems = validateCorpusExamples(rows);
  if (problems.length) return { waves: [], problems };

  const handleOf = (e: any): string | null => {
    const h = e.localId ?? e.id;
    return h == null ? null : String(h);
  };
  const parentHandleOf = (e: any): string | null => {
    const h = e.localParentId ?? e.parentExampleId;
    return h == null ? null : String(h);
  };

  const indexByLocal = new Map<string, number>();
  rows.forEach((e, i) => {
    const h = handleOf(e);
    if (h !== null) indexByLocal.set(h, i);
  });
  /** True when the handle names another row of THIS batch. */
  const localParentIndex = (i: number): number | undefined => {
    const h = parentHandleOf(rows[i]);
    return h === null ? undefined : indexByLocal.get(h);
  };

  const rootOf = (i: number): number => {
    const seen = new Set<number>();
    let cur = i;
    for (;;) {
      if (seen.has(cur)) return cur;      // a cycle is already a validation error
      seen.add(cur);
      const next = localParentIndex(cur);
      if (next === undefined) return cur;
      cur = next;
    }
  };
  const depth = (i: number): number => {
    const seen = new Set<number>();
    let d = 0, cur = i;
    for (;;) {
      if (seen.has(cur)) return d;
      seen.add(cur);
      const next = localParentIndex(cur);
      if (next === undefined) return d;
      cur = next; d++;
    }
  };

  // One group per chain. An explicit group anywhere in the chain wins over a
  // minted one, so a caller can attach new rows to an existing demonstration.
  const groupByRoot = new Map<number, string>();
  rows.forEach((_, i) => {
    const r = rootOf(i);
    if (groupByRoot.has(r)) return;
    // Precedence: a group the caller named, then a group already stored for any
    // row of this chain, then a fresh one. Minting is the last resort.
    const explicit = rows.find((e, j) => rootOf(j) === r && e.exampleGroupId)?.exampleGroupId;
    const stored = rows
      .map((e, j) => (rootOf(j) === r ? existingGroupByKey.get(corpusNaturalKey(e)) : undefined))
      .find((v) => v);
    groupByRoot.set(r, explicit ? String(explicit) : (stored ?? mintGroupId()));
  });
  const inAChain = (i: number): boolean =>
    localParentIndex(i) !== undefined ||
    rows.some((_, j) => j !== i && localParentIndex(j) === i);

  const planned: PlannedCorpusRow[] = rows.map((e, i) => {
    const parentIdx = localParentIndex(i);
    return {
      localId: handleOf(e),
      sourceIndex: i,
      localParentId: parentIdx === undefined ? null : parentHandleOf(e),
      row: {
        // No user_id. The corpus is project-owned: there is exactly one record
        // of what a video demonstrated, not one per account.
        evidence_source: e.evidenceSource ?? "VIDEO_DEMONSTRATION",
        source_video: e.sourceVideo ?? null,
        source_timestamp: e.sourceTimestamp ?? null,
        reference_url: e.referenceUrl ?? null,
        symbol: e.symbol,
        timeframe: e.timeframe,
        candle_datetime: e.candleDatetime ?? null,
        direction: e.direction,
        demonstrated_zone_low: e.demonstratedZoneLow ?? null,
        demonstrated_zone_high: e.demonstratedZoneHigh ?? null,
        // Stored, not derived. Both were previously held only in conversation
        // and had to be recovered from a session transcript — which means a
        // row's usability for rule-proposal was not actually recorded anywhere.
        // Null is "not established" and must never be defaulted to a value.
        confidence_tier: e.confidenceTier ?? null,
        source_family: e.sourceFamily ?? null,
        // A row in a chain always carries a group. A lone row keeps null unless
        // the caller asked for one, so solo examples are not silently grouped
        // into demonstrations they are not part of.
        example_group_id: e.exampleGroupId
          ? String(e.exampleGroupId)
          : (inAChain(i)
            ? groupByRoot.get(rootOf(i))!
            // A solo row is not given a group it never had, but it does keep
            // one it already has — an upsert must not blank it.
            : (existingGroupByKey.get(corpusNaturalKey(e)) ?? null)),
        // Only an id the caller says is ALREADY in the database survives here.
        // A batch-local handle is resolved after its own wave lands.
        parent_example_id: parentIdx === undefined ? (e.parentExampleId ?? null) : null,
        notes: e.notes ?? null,
      },
    };
  });

  const maxDepth = planned.reduce((m, _, i) => Math.max(m, depth(i)), 0);
  const waves: PlannedCorpusRow[][] = [];
  for (let d = 0; d <= maxDepth; d++) {
    const w = planned.filter((_, i) => depth(i) === d);
    if (w.length) waves.push(w);
  }
  return { waves, problems: [] };
}

/** Raised when a batch-local parent handle cannot be resolved to a real id. */
export class UnresolvedParentError extends Error {
  constructor(readonly localParentId: string, readonly sourceIndex: number) {
    super(
      `local parent "${localParentId}" (row ${sourceIndex}) has no database id. ` +
      "Its wave should already have landed, so this means an earlier wave did " +
      "not return the row — writing the child without its parent would lose the " +
      "refinement edge silently, which is the failure this planner exists to stop.",
    );
    this.name = "UnresolvedParentError";
  }
}

/**
 * Rewrites a wave's local parent handles to the real ids of earlier waves.
 *
 * AN UNRESOLVED HANDLE IS FATAL. The earlier draft wrote `real ?? null`, which
 * reintroduced exactly the bug this module was written to remove: a child
 * stored with no parent, no error, and a response saying the batch succeeded.
 * Waves are ordered by depth, so a local parent is GUARANTEED to have been
 * inserted already; a missing entry means something upstream went wrong, and
 * failing loudly leaves the chain reconstructible on a re-send.
 */
export function resolveWaveParents(
  wave: PlannedCorpusRow[],
  idByLocal: Map<string, string>,
): Array<Record<string, unknown>> {
  return wave.map((p) => {
    if (!p.localParentId) return p.row;
    const real = idByLocal.get(p.localParentId);
    if (!real) throw new UnresolvedParentError(p.localParentId, p.sourceIndex);
    return { ...p.row, parent_example_id: real };
  });
}
