/**
 * Operational heartbeat for the IPO paper runner. PURE. Outside strategy.
 *
 * WHY IT EXISTS. The runner deliberately writes nothing when a run changes
 * nothing: no row, no `updated_at`. That is correct — an audit column that ticks
 * when nothing happened is not an audit column — but it makes silence
 * ambiguous. During a quiet period "cron ran and found no new bar" and "cron
 * stopped three days ago" are the same observation. On a weekday with bars due
 * that resolves itself; at 3am on a Sunday it does not.
 *
 * So a successful no-op MUST still update this record. That is the entire point,
 * and it is why the engine-state `updated_at` cannot serve: that column is
 * meaningful precisely because it only moves when the strategy moves.
 *
 * STRICTLY OPERATIONAL. Nothing here is read by any strategy code. It cannot
 * affect setup validity, sequencing, paper execution or idempotency, and a test
 * asserts no strategy module so much as names it. If the heartbeat write fails
 * the run is still a success — the failure is reported, not propagated.
 *
 * WHY kv_cache AND NOT A TABLE. `kv_cache` is already where this project keeps
 * operational runtime state, and a key needs no migration, so this ships with
 * the code that produces it. The cost is honest: one row holds only the LATEST
 * beat, so there is no history to trend. If health history is ever wanted, a
 * dedicated `ipo_runner_health` table is the right answer and this record maps
 * onto it one-to-one.
 *
 * THE HOURLY SWEEP. `kv-cache-cleanup-hourly` runs
 * `DELETE FROM kv_cache WHERE expires_at < now()`, so the expiry is set far out
 * deliberately. A swept heartbeat would read as "never ran", which is the exact
 * false alarm this is meant to prevent.
 */

export const RUNNER_NAME = "ipo-paper-runner";

/** Bumped by hand when the heartbeat's own shape or semantics change. */
export const RUNNER_HEALTH_VERSION = 1;

export const runnerHealthKey = (strategyId: string) =>
  `ipo_runner_health:${strategyId}:${RUNNER_NAME}`;

/**
 * OK      every instrument was checked and none reported a problem
 * PARTIAL at least one instrument needed a bootstrap, diverged, or errored,
 *         while others were fine — the run did work, but not all of it
 * FAILED  the invocation itself threw, or nothing could be checked at all
 *
 * A run that legitimately processed zero bars is OK, not FAILED. Doing nothing
 * because there was nothing to do is the most common healthy outcome.
 */
export type RunnerStatus = "OK" | "PARTIAL" | "FAILED";

export interface RunnerHealth {
  healthVersion: number;
  runner: string;
  strategyId: string;
  strategyVersion: string;

  lastRunAt: string;
  /**
   * Carried forward across failures. The question worth answering at 3am is
   * "when did this last actually work", and a failing run must not erase it.
   */
  lastSuccessAt: string | null;
  lastStatus: RunnerStatus;
  durationMs: number;

  instrumentsChecked: number;
  barsProcessed: number;
  eventsEmitted: number;
  /** Instruments that could not run because no compatible state exists. */
  bootstrapRequired: string[];
  /** Instruments where engine and paper disagreed. Any entry is a stop condition. */
  divergent: string[];

  errorCode: string | null;
  errorMessage: string | null;

  /** Consecutive runs that were not OK. Resets on the first clean one. */
  consecutiveFailures: number;
}

export interface RunSummary {
  strategyId: string;
  strategyVersion: string;
  startedAtMs: number;
  endedAtMs: number;
  instrumentsChecked: number;
  barsProcessed: number;
  eventsEmitted: number;
  bootstrapRequired: string[];
  divergent: string[];
  /** Per-instrument errors, if any. */
  errors: Array<{ instrument: string; message: string }>;
  /** Set when the invocation itself failed before or across all instruments. */
  fatal?: { code: string; message: string };
}

export function parseHealth(value: string | null | undefined): RunnerHealth | null {
  if (!value) return null;
  try {
    const h = JSON.parse(value) as RunnerHealth;
    return typeof h?.runner === "string" ? h : null;
  } catch {
    return null;
  }
}

/**
 * Builds the next heartbeat from this run and the previous one.
 *
 * `previous` matters only for the two fields that are histories rather than
 * observations: `lastSuccessAt` and `consecutiveFailures`. Everything else
 * describes this run alone.
 */
export function buildHealth(s: RunSummary, previous: RunnerHealth | null): RunnerHealth {
  const fatal = s.fatal ?? null;
  const status: RunnerStatus = fatal || s.instrumentsChecked === 0
    ? "FAILED"
    : (s.errors.length || s.divergent.length || s.bootstrapRequired.length)
      ? "PARTIAL"
      : "OK";

  const at = new Date(s.endedAtMs).toISOString();
  const firstError = s.errors[0];

  return {
    healthVersion: RUNNER_HEALTH_VERSION,
    runner: RUNNER_NAME,
    strategyId: s.strategyId,
    strategyVersion: s.strategyVersion,
    lastRunAt: at,
    // Only a clean run refreshes this. A PARTIAL run did something, but not
    // everything, and calling that a success is how a half-broken system gets
    // to look healthy for a week.
    lastSuccessAt: status === "OK" ? at : (previous?.lastSuccessAt ?? null),
    lastStatus: status,
    durationMs: Math.max(0, s.endedAtMs - s.startedAtMs),
    instrumentsChecked: s.instrumentsChecked,
    barsProcessed: s.barsProcessed,
    eventsEmitted: s.eventsEmitted,
    bootstrapRequired: [...s.bootstrapRequired],
    divergent: [...s.divergent],
    errorCode: fatal?.code ?? (firstError ? "INSTRUMENT_ERROR" : null),
    errorMessage: fatal?.message ??
      (s.errors.length
        ? s.errors.map((e) => `${e.instrument}: ${e.message}`).join("; ")
        : null),
    consecutiveFailures: status === "OK" ? 0 : (previous?.consecutiveFailures ?? 0) + 1,
  };
}

/** How stale a heartbeat may be before it means something is wrong. */
export function isStale(h: RunnerHealth | null, nowMs: number, cadenceMs: number): boolean {
  if (!h) return true;
  // Three missed ticks, so one slow run or a single transient failure is not an
  // alarm but a stopped scheduler is.
  return nowMs - new Date(h.lastRunAt).getTime() > cadenceMs * 3;
}
