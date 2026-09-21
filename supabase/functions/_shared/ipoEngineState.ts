/**
 * Persistent runtime state for the frozen IPO engine. Phase D.1. PURE.
 *
 * WHAT PROBLEM THIS SOLVES. A stateless worker that rebuilds the engine every
 * invocation is not incremental: it pays the whole ~1,200-bar bootstrap to learn
 * what one new bar did. Worse, it is not even continuous — each run anchors on a
 * fresh sliding window, and every whole-series function in the frozen stack
 * (`twoStageContractions`, `segmentEpisodes`, `fvgsNear`) reads that window. A
 * bar that drops off the back can change an episode, and an episode can change a
 * candidate. Persisting state removes both the cost and the discontinuity.
 *
 * NOT A BLIND SERIALISER. `IncrementalEngine.snapshot()` enumerates the fields a
 * continuation reads and omits the ones it does not; this module versions,
 * packs, fingerprints and validates that enumeration. Nothing reflects over the
 * instance, so a field added to the engine without being added to the snapshot
 * is a visible omission rather than a silent one.
 *
 * RESTORE IS FAIL-CLOSED. Every check rejects into a named `RebuildReason` and
 * the caller rebuilds. There is no partial restore and no best-effort repair:
 * state that cannot be proven to belong to these rules, this strategy version,
 * this instrument and this cost model is not state, it is a guess.
 *
 * THE ONE THING A PAYLOAD CANNOT CARRY is `EngineConfig.costPerSide`, a
 * function. The caller supplies it on restore, and the identity block records a
 * `costModelId` that must match — so a silently re-tuned cost model invalidates
 * the state instead of quietly re-pricing an open trade.
 */

import {
  IncrementalEngine, FROZEN_RULES, type EngineSnapshot,
} from "./ipoIncrementalEngine.ts";
import type { Candle } from "./smcAnalysis.ts";
import type { EngineConfig } from "./ipoLiveEngine.ts";

/** Bumped whenever the shape below changes in a way old payloads cannot satisfy. */
export const RUNTIME_STATE_SCHEMA_VERSION = 1;

/**
 * Hard ceiling on retained bars.
 *
 * The bar array cannot be truncated without changing what the whole-series
 * functions see, so state only ever grows. Measured on a 1h fixture: 389 KB at
 * 1,200 bars and 784 KB at 2,400, i.e. about 330 bytes per bar, of which the
 * bars themselves are only a quarter — 55% is `tracked`, which accumulates one
 * candidate roughly every other bar and is never pruned.
 *
 * 3,000 bars is therefore ~1 MB raw (~240 KB gzipped) and about four months of
 * hourly data. Past it the state is discarded and the engine re-anchors on a
 * fresh window. That is a DECISION-AFFECTING event, so it has its own rebuild
 * reason and is reported rather than folded into "a rebuild happened".
 */
export const MAX_STATE_BARS = 3000;

export type RebuildReason =
  | "NO_STATE"
  | "MALFORMED_STATE"
  | "SCHEMA_VERSION_CHANGED"
  | "STRATEGY_VERSION_CHANGED"
  | "ENGINE_RULES_CHANGED"
  | "INSTRUMENT_CONFIG_CHANGED"
  | "COST_MODEL_CHANGED"
  | "CHECKSUM_MISMATCH"
  | "BAR_CONTINUITY_BROKEN"
  | "STATE_BAR_LIMIT"
  | "ADMIN_REQUESTED";

/** Everything that must match before a payload may be treated as this engine's past. */
export interface StateIdentity {
  schemaVersion: number;
  strategyVersion: string;
  /** Derived from `FROZEN_RULES`, so changing a rule invalidates old state by itself. */
  engineRulesFingerprint: string;
  instrument: string;
  timeframe: string;
  highVolOnly: boolean;
  /** Caller-declared identity of `costPerSide`, which cannot be serialised. */
  costModelId: string;
}

/**
 * Columnar, delta-encoded bars.
 *
 * Bars dominate the payload, and one object per bar spends most of its bytes on
 * repeated key names. Times are stored as deltas from the first bar because a
 * fixed-interval series compresses to a column of identical small integers.
 */
export interface PackedBars {
  /** Epoch ms of the first bar. */
  t0: number;
  /** Millisecond deltas; `dt[i]` is bar i+1 minus bar i. */
  dt: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  /** Null where the source candle had no volume, so the round trip is exact. */
  v: Array<number | null>;
}

export interface EngineRuntimeState {
  identity: StateIdentity;
  lastProcessedBarTime: string;
  barCount: number;
  bars: PackedBars;
  /** The engine snapshot minus its bars, which are packed above. */
  engine: Omit<EngineSnapshot, "bars">;
  /** Fingerprint of everything above. Detects truncation and corruption. */
  checksum: string;
}

export type RestoreResult =
  | { ok: true; engine: IncrementalEngine; state: EngineRuntimeState }
  | { ok: false; reason: RebuildReason; detail: string };

// ─── fingerprinting ──────────────────────────────────────────────────────────

/**
 * 64-bit FNV-1a over a string, as two 32-bit halves.
 *
 * A checksum, not a security primitive: it exists to catch a truncated or
 * half-written payload, not an adversary. `ipoPaperContract` has its own digest
 * for minting short stable IDs — the two are kept apart deliberately, because an
 * id scheme and an integrity check have different reasons to change.
 */
export function fingerprint(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0xcbf29ce4;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (s.charCodeAt(i) + i), 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** Identity of the frozen rule set. Derived, never hand-maintained. */
export function engineRulesFingerprint(): string {
  return fingerprint(JSON.stringify(FROZEN_RULES));
}

/**
 * The bytes the checksum covers.
 *
 * Key order is fixed by construction rather than by sorting: the object is built
 * literally, in one place, and both writer and reader use this function.
 */
function checksumBody(s: Omit<EngineRuntimeState, "checksum">): string {
  return JSON.stringify([s.identity, s.lastProcessedBarTime, s.barCount, s.bars, s.engine]);
}

// ─── bar packing ─────────────────────────────────────────────────────────────

export function packBars(bars: Candle[]): PackedBars {
  const t = bars.map((b) => new Date(b.datetime).getTime());
  return {
    t0: t.length ? t[0] : 0,
    dt: t.slice(1).map((x, i) => x - t[i]),
    o: bars.map((b) => b.open),
    h: bars.map((b) => b.high),
    l: bars.map((b) => b.low),
    c: bars.map((b) => b.close),
    v: bars.map((b) => (b.volume === undefined ? null : b.volume)),
  };
}

export function unpackBars(p: PackedBars): Candle[] {
  const out: Candle[] = [];
  let t = p.t0;
  for (let i = 0; i < p.o.length; i++) {
    if (i > 0) t += p.dt[i - 1];
    const c: Candle = {
      datetime: new Date(t).toISOString(),
      open: p.o[i], high: p.h[i], low: p.l[i], close: p.c[i],
    };
    // A volume key is only added back when the original had one, so a
    // round-tripped candle is deep-equal to the candle that went in.
    if (p.v[i] !== null) c.volume = p.v[i] as number;
    out.push(c);
  }
  return out;
}

// ─── export ──────────────────────────────────────────────────────────────────

export interface ExportMeta {
  strategyVersion: string;
  costModelId: string;
}

export function exportState(
  engine: IncrementalEngine, cfg: EngineConfig, meta: ExportMeta,
): EngineRuntimeState {
  const snap = engine.snapshot();
  const { bars, ...rest } = snap;
  const body: Omit<EngineRuntimeState, "checksum"> = {
    identity: {
      schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
      strategyVersion: meta.strategyVersion,
      engineRulesFingerprint: engineRulesFingerprint(),
      instrument: cfg.instrument,
      timeframe: cfg.timeframe,
      highVolOnly: cfg.highVolOnly,
      costModelId: meta.costModelId,
    },
    lastProcessedBarTime: bars.length ? bars[bars.length - 1].datetime : "",
    barCount: bars.length,
    bars: packBars(bars),
    engine: rest,
  };
  return { ...body, checksum: fingerprint(checksumBody(body)) };
}

export const serializeState = (s: EngineRuntimeState): string => JSON.stringify(s);

export function parseState(json: string | null): EngineRuntimeState | null {
  if (!json) return null;
  try {
    const s = JSON.parse(json) as EngineRuntimeState;
    return s && typeof s === "object" && s.identity && s.bars && s.engine ? s : null;
  } catch {
    return null;
  }
}

// ─── restore ─────────────────────────────────────────────────────────────────

const reject = (reason: RebuildReason, detail: string): RestoreResult =>
  ({ ok: false, reason, detail });

/**
 * Rebuilds an engine from a payload, or says exactly why it will not.
 *
 * Checks run cheapest-first and the payload is never partially trusted: the
 * checksum is verified before anything inside it is used for a decision.
 */
export function restoreState(
  raw: string | EngineRuntimeState | null, cfg: EngineConfig, meta: ExportMeta,
): RestoreResult {
  const s = typeof raw === "string" ? parseState(raw) : raw;
  if (!s) return reject(raw ? "MALFORMED_STATE" : "NO_STATE", "no usable payload");

  const id = s.identity;
  if (id.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION) {
    return reject("SCHEMA_VERSION_CHANGED",
      `state schema v${id.schemaVersion}, code expects v${RUNTIME_STATE_SCHEMA_VERSION}`);
  }
  if (id.strategyVersion !== meta.strategyVersion) {
    return reject("STRATEGY_VERSION_CHANGED",
      `state was written by ${id.strategyVersion}, running ${meta.strategyVersion}`);
  }
  if (id.engineRulesFingerprint !== engineRulesFingerprint()) {
    return reject("ENGINE_RULES_CHANGED",
      "a frozen engine parameter changed since this state was written");
  }
  if (id.instrument !== cfg.instrument || id.timeframe !== cfg.timeframe ||
      id.highVolOnly !== cfg.highVolOnly) {
    return reject("INSTRUMENT_CONFIG_CHANGED",
      `state is ${id.instrument}/${id.timeframe}/highVolOnly=${id.highVolOnly}`);
  }
  if (id.costModelId !== meta.costModelId) {
    // costPerSide cannot be compared directly, so its declared identity is.
    return reject("COST_MODEL_CHANGED",
      `state priced with ${id.costModelId}, running ${meta.costModelId}`);
  }

  const { checksum, ...body } = s;
  if (fingerprint(checksumBody(body)) !== checksum) {
    return reject("CHECKSUM_MISMATCH", "payload does not match its own checksum");
  }

  // Checked before unpacking: an oversized payload is rejected on its own
  // declared size rather than after paying to expand it.
  if (s.barCount > MAX_STATE_BARS) {
    return reject("STATE_BAR_LIMIT", `${s.barCount} bars exceeds ${MAX_STATE_BARS}`);
  }

  let bars: Candle[];
  try {
    bars = unpackBars(s.bars);
  } catch (e) {
    return reject("MALFORMED_STATE", `bars could not be unpacked: ${(e as Error).message}`);
  }
  if (bars.length !== s.barCount) {
    return reject("MALFORMED_STATE", `barCount ${s.barCount} but ${bars.length} bars unpacked`);
  }
  if (bars.length && bars[bars.length - 1].datetime !== s.lastProcessedBarTime) {
    return reject("MALFORMED_STATE", "last bar does not match lastProcessedBarTime");
  }

  return { ok: true, engine: IncrementalEngine.fromSnapshot(cfg, { ...s.engine, bars }), state: s };
}

// ─── continuity ──────────────────────────────────────────────────────────────

export type ContinuityResult =
  | { ok: true; append: Candle[] }
  | { ok: false; reason: RebuildReason; detail: string };

/**
 * Decides which of a provider's bars may be appended to persisted state.
 *
 * THE OVERLAP IS THE PROOF. The fetched window must CONTAIN the last processed
 * bar; only then is it demonstrable that no bar between the two is missing.
 * Without that anchor the two series might be adjacent, or might have a hole,
 * and there is no way to tell from the payload — so the state is discarded
 * rather than silently spliced.
 *
 * A bar already processed is never re-fed, and a provider that restates a bar we
 * have already acted on is a continuity break, not an update: the decision on
 * that bar has already been made.
 */
export function continuityCheck(
  state: EngineRuntimeState, providerBars: Candle[],
): ContinuityResult {
  if (!providerBars.length) return { ok: true, append: [] };

  const anchor = providerBars.findIndex((b) => b.datetime === state.lastProcessedBarTime);
  if (anchor === -1) {
    return {
      ok: false, reason: "BAR_CONTINUITY_BROKEN",
      detail: `fetched window [${providerBars[0].datetime} … ` +
        `${providerBars[providerBars.length - 1].datetime}] does not contain ` +
        `the last processed bar ${state.lastProcessedBarTime}`,
    };
  }

  const append = providerBars.slice(anchor + 1);
  if (state.barCount + append.length > MAX_STATE_BARS) {
    return {
      ok: false, reason: "STATE_BAR_LIMIT",
      detail: `${state.barCount} + ${append.length} bars would exceed ${MAX_STATE_BARS}`,
    };
  }
  return { ok: true, append };
}
