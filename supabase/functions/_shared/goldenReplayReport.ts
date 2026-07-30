import {
  buildGoldenReplaySnapshot,
  compareGoldenReplaySnapshots,
  finalizeGoldenReplaySnapshot,
  type GoldenReplayFinalization,
  type GoldenReplayInput,
  type GoldenReplayMismatch,
  type GoldenReplaySnapshot,
} from "./goldenReplay.ts";

export const GOLDEN_REPLAY_REPORT_VERSION = "golden-replay-report.v1";
export const GOLDEN_REPLAY_INPUT_VERSION = "golden-replay-input.v1";

export interface GoldenReplayInputCandle {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
}

export interface GoldenReplayInputFingerprintSource {
  symbol: string;
  evaluatedAt: string;
  policyBaseHash: string;
  timeframeRoles: Record<string, string>;
  candlesByRole: Record<string, GoldenReplayInputCandle[]>;
  config: Record<string, unknown>;
}

export interface GoldenReplayIntentionalDifference {
  path: string;
  reason: string;
}

export type GoldenReplayMismatchClassification =
  | "unexpected"
  | "intentional";

export interface ClassifiedGoldenReplayMismatch extends GoldenReplayMismatch {
  classification: GoldenReplayMismatchClassification;
  reason: string | null;
}

export type GoldenReplayPairStatus =
  | "match"
  | "mismatch"
  | "intentional_difference"
  | "incomplete"
  | "input_mismatch"
  | "input_unverified"
  | "missing_live"
  | "missing_backtest";

export interface GoldenReplayPairReport {
  key: string;
  symbol: string;
  evaluatedAt: string;
  status: GoldenReplayPairStatus;
  inputVerified: boolean;
  inputFingerprint: string | null;
  liveHash: string | null;
  backtestHash: string | null;
  liveCoverageComplete: boolean | null;
  backtestCoverageComplete: boolean | null;
  mismatches: ClassifiedGoldenReplayMismatch[];
}

export interface GoldenReplayReport {
  contractVersion: typeof GOLDEN_REPLAY_REPORT_VERSION;
  deterministicPass: boolean;
  summary: {
    liveSnapshots: number;
    backtestSnapshots: number;
    paired: number;
    matches: number;
    intentionalDifferences: number;
    unexpectedMismatches: number;
    incomplete: number;
    inputMismatches: number;
    inputUnverified: number;
    missingLive: number;
    missingBacktest: number;
  };
  mismatchPathCounts: Record<string, number>;
  pairs: GoldenReplayPairReport[];
}

export interface GoldenReplayDecisionFixture {
  id: string;
  inputFingerprint: string;
  candidate: Omit<GoldenReplayInput, "surface" | "provenance">;
  liveFinalization?: GoldenReplayFinalization | null;
  backtestFinalization?: GoldenReplayFinalization | null;
  intentionalDifferences?: GoldenReplayIntentionalDifference[];
}

export interface GoldenReplayDecisionFixtureResult {
  fixtureId: string;
  live: GoldenReplaySnapshot;
  backtest: GoldenReplaySnapshot;
  report: GoldenReplayReport;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${
    Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(",")
  }}`;
}

function normalizeTimestamp(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toISOString();
}

function normalizeCandle(
  candle: GoldenReplayInputCandle,
): GoldenReplayInputCandle {
  return {
    datetime: normalizeTimestamp(candle.datetime),
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: candle.volume == null ? null : Number(candle.volume),
  };
}

export async function buildGoldenReplayInputFingerprint(
  source: GoldenReplayInputFingerprintSource,
): Promise<string> {
  const canonical = {
    contractVersion: GOLDEN_REPLAY_INPUT_VERSION,
    symbol: source.symbol,
    evaluatedAt: normalizeTimestamp(source.evaluatedAt),
    policyBaseHash: source.policyBaseHash,
    timeframeRoles: source.timeframeRoles,
    candlesByRole: Object.fromEntries(
      Object.entries(source.candlesByRole)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([role, candles]) => [
          role,
          candles.map(normalizeCandle),
        ]),
    ),
    config: source.config,
  };
  const bytes = new TextEncoder().encode(stableSerialize(canonical));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${GOLDEN_REPLAY_INPUT_VERSION}:${hash}`;
}

export function isGoldenReplayInputFingerprint(
  value: unknown,
): value is string {
  return typeof value === "string" &&
    new RegExp(
      `^${GOLDEN_REPLAY_INPUT_VERSION.replaceAll(".", "\\.")}:[a-f0-9]{64}$`,
    ).test(value);
}

export function isGoldenReplaySnapshot(
  value: unknown,
): value is GoldenReplaySnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<GoldenReplaySnapshot>;
  return snapshot.contractVersion === "golden-replay.v1" &&
    (snapshot.surface === "live" || snapshot.surface === "backtest") &&
    typeof snapshot.symbol === "string" &&
    typeof snapshot.evaluatedAt === "string" &&
    typeof snapshot.decisionHash === "string" &&
    !!snapshot.provenance &&
    !!snapshot.decision &&
    !!snapshot.coverage &&
    typeof snapshot.coverage.complete === "boolean" &&
    Array.isArray(snapshot.coverage.missing);
}

function observationKey(snapshot: GoldenReplaySnapshot): string {
  return `${snapshot.symbol}|${snapshot.evaluatedAt}`;
}

function groupSnapshots(
  snapshots: GoldenReplaySnapshot[],
): Map<string, GoldenReplaySnapshot[]> {
  const groups = new Map<string, GoldenReplaySnapshot[]>();
  for (const snapshot of snapshots) {
    const key = observationKey(snapshot);
    const group = groups.get(key) || [];
    group.push(snapshot);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) =>
      [
        a.decision.lifecycle.route,
        a.decision.lifecycle.stage,
        a.decision.lifecycle.outcome,
        a.decisionHash,
      ].join("|").localeCompare([
        b.decision.lifecycle.route,
        b.decision.lifecycle.stage,
        b.decision.lifecycle.outcome,
        b.decisionHash,
      ].join("|"))
    );
  }
  return groups;
}

function selectBacktestMatch(
  live: GoldenReplaySnapshot,
  candidates: GoldenReplaySnapshot[],
  used: Set<number>,
): number {
  const exact = candidates.findIndex((candidate, index) =>
    !used.has(index) && candidate.decisionHash === live.decisionHash
  );
  if (exact >= 0) return exact;
  const sameLifecycle = candidates.findIndex((candidate, index) =>
    !used.has(index) &&
    candidate.decision.lifecycle.route === live.decision.lifecycle.route &&
    candidate.decision.lifecycle.stage === live.decision.lifecycle.stage
  );
  if (sameLifecycle >= 0) return sameLifecycle;
  return candidates.findIndex((_, index) => !used.has(index));
}

function classifyMismatches(
  mismatches: GoldenReplayMismatch[],
  intentionalDifferences: GoldenReplayIntentionalDifference[],
): ClassifiedGoldenReplayMismatch[] {
  const rules = new Map(
    intentionalDifferences.map((difference) => [
      difference.path,
      difference.reason,
    ]),
  );
  return mismatches.map((mismatch) => {
    const reason = rules.get(mismatch.path) || null;
    return {
      ...mismatch,
      classification: reason ? "intentional" : "unexpected",
      reason,
    };
  });
}

function buildPairReport(
  key: string,
  live: GoldenReplaySnapshot | null,
  backtest: GoldenReplaySnapshot | null,
  intentionalDifferences: GoldenReplayIntentionalDifference[],
): GoldenReplayPairReport {
  const snapshot = live || backtest!;
  if (!live) {
    return {
      key,
      symbol: snapshot.symbol,
      evaluatedAt: snapshot.evaluatedAt,
      status: "missing_live",
      inputVerified: false,
      inputFingerprint: backtest!.provenance.inputFingerprint,
      liveHash: null,
      backtestHash: backtest!.decisionHash,
      liveCoverageComplete: null,
      backtestCoverageComplete: backtest!.coverage.complete,
      mismatches: [],
    };
  }
  if (!backtest) {
    return {
      key,
      symbol: snapshot.symbol,
      evaluatedAt: snapshot.evaluatedAt,
      status: "missing_backtest",
      inputVerified: false,
      inputFingerprint: live.provenance.inputFingerprint,
      liveHash: live.decisionHash,
      backtestHash: null,
      liveCoverageComplete: live.coverage.complete,
      backtestCoverageComplete: null,
      mismatches: [],
    };
  }

  const liveInput = live.provenance.inputFingerprint;
  const backtestInput = backtest.provenance.inputFingerprint;
  const inputVerified = isGoldenReplayInputFingerprint(liveInput) &&
    liveInput === backtestInput;
  const comparison = compareGoldenReplaySnapshots(live, backtest);
  const mismatches = classifyMismatches(
    comparison.mismatches,
    intentionalDifferences,
  );
  const unexpected = mismatches.some((mismatch) =>
    mismatch.classification === "unexpected"
  );
  const intentional = mismatches.length > 0 && !unexpected;

  let status: GoldenReplayPairStatus;
  if (liveInput && backtestInput && liveInput !== backtestInput) {
    status = "input_mismatch";
  } else if (!inputVerified) {
    status = "input_unverified";
  } else if (!live.coverage.complete || !backtest.coverage.complete) {
    status = "incomplete";
  } else if (unexpected) {
    status = "mismatch";
  } else if (intentional) {
    status = "intentional_difference";
  } else {
    status = "match";
  }

  return {
    key,
    symbol: live.symbol,
    evaluatedAt: live.evaluatedAt,
    status,
    inputVerified,
    inputFingerprint: inputVerified ? liveInput : null,
    liveHash: live.decisionHash,
    backtestHash: backtest.decisionHash,
    liveCoverageComplete: live.coverage.complete,
    backtestCoverageComplete: backtest.coverage.complete,
    mismatches,
  };
}

export function buildGoldenReplayReport(
  liveSnapshots: GoldenReplaySnapshot[],
  backtestSnapshots: GoldenReplaySnapshot[],
  intentionalDifferences: GoldenReplayIntentionalDifference[] = [],
): GoldenReplayReport {
  const liveGroups = groupSnapshots(liveSnapshots);
  const backtestGroups = groupSnapshots(backtestSnapshots);
  const observationKeys = [
    ...new Set([
      ...liveGroups.keys(),
      ...backtestGroups.keys(),
    ]),
  ].sort();
  const pairs: GoldenReplayPairReport[] = [];

  for (const observation of observationKeys) {
    const liveGroup = liveGroups.get(observation) || [];
    const backtestGroup = backtestGroups.get(observation) || [];
    const usedBacktest = new Set<number>();
    let ordinal = 0;
    for (const live of liveGroup) {
      const backtestIndex = selectBacktestMatch(
        live,
        backtestGroup,
        usedBacktest,
      );
      const backtest = backtestIndex >= 0 ? backtestGroup[backtestIndex] : null;
      if (backtestIndex >= 0) usedBacktest.add(backtestIndex);
      ordinal++;
      pairs.push(buildPairReport(
        `${observation}|${ordinal}`,
        live,
        backtest,
        intentionalDifferences,
      ));
    }
    for (let index = 0; index < backtestGroup.length; index++) {
      if (usedBacktest.has(index)) continue;
      ordinal++;
      pairs.push(buildPairReport(
        `${observation}|${ordinal}`,
        null,
        backtestGroup[index],
        intentionalDifferences,
      ));
    }
  }

  const count = (status: GoldenReplayPairStatus) =>
    pairs.filter((pair) => pair.status === status).length;
  const mismatchPathCounts: Record<string, number> = {};
  for (const pair of pairs) {
    for (const mismatch of pair.mismatches) {
      mismatchPathCounts[mismatch.path] =
        (mismatchPathCounts[mismatch.path] || 0) + 1;
    }
  }
  const summary = {
    liveSnapshots: liveSnapshots.length,
    backtestSnapshots: backtestSnapshots.length,
    paired:
      pairs.filter((pair) =>
        pair.liveHash !== null && pair.backtestHash !== null
      ).length,
    matches: count("match"),
    intentionalDifferences: count("intentional_difference"),
    unexpectedMismatches: count("mismatch"),
    incomplete: count("incomplete"),
    inputMismatches: count("input_mismatch"),
    inputUnverified: count("input_unverified"),
    missingLive: count("missing_live"),
    missingBacktest: count("missing_backtest"),
  };

  return {
    contractVersion: GOLDEN_REPLAY_REPORT_VERSION,
    deterministicPass: pairs.length > 0 &&
      summary.matches + summary.intentionalDifferences === pairs.length,
    summary,
    mismatchPathCounts,
    pairs,
  };
}

export async function runGoldenReplayDecisionFixture(
  fixture: GoldenReplayDecisionFixture,
): Promise<GoldenReplayDecisionFixtureResult> {
  let live = await buildGoldenReplaySnapshot({
    ...fixture.candidate,
    surface: "live",
    provenance: {
      inputFingerprint: fixture.inputFingerprint,
    },
  });
  let backtest = await buildGoldenReplaySnapshot({
    ...fixture.candidate,
    surface: "backtest",
    provenance: {
      inputFingerprint: fixture.inputFingerprint,
    },
  });
  if (fixture.liveFinalization) {
    live = await finalizeGoldenReplaySnapshot(
      live,
      fixture.liveFinalization,
    );
  }
  if (fixture.backtestFinalization) {
    backtest = await finalizeGoldenReplaySnapshot(
      backtest,
      fixture.backtestFinalization,
    );
  }
  return {
    fixtureId: fixture.id,
    live,
    backtest,
    report: buildGoldenReplayReport(
      [live],
      [backtest],
      fixture.intentionalDifferences,
    ),
  };
}
