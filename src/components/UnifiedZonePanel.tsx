/**
 * UnifiedZonePanel — Displays the unified zone engine story in the scan detail panel.
 * Shows the full narrative: Impulse → Zone → Price → Liquidity → Confirmation → Entry
 *
 * This replaces both the old ImpulseZonePanel (standalone) and CascadeZonePanel (cascade)
 * with a single unified story-driven display.
 *
 * Entry direction = impulse direction (continuation, not reversal).
 */

interface UnifiedZoneData {
  hasZone: boolean;
  state: string;
  selectedTF: string | null;
  unifiedScore: number;
  scoreBreakdown: {
    baseScore: number;
    liquidityBonus: number;
    confirmationBonus: number;
    tfBonus: number;
    total: number;
  };
  impulse: {
    direction: "bullish" | "bearish";
    high: number;
    low: number;
    pips: number;
    timeframe: string;
    startDate: string | null;
    endDate: string | null;
    spanBars: number;
    bosPrice: number;
  } | null;
  zone: {
    type: "OB" | "FVG";
    high: number;
    low: number;
    fibLevel: number;
    fibLabel: string;
    srConfirmed: boolean;
    htfLayers: string[];
    ltfRefined: boolean;
    totalScore: number;
    zonesFound: number;
  } | null;
  price: {
    currentPrice: number;
    atZone: boolean;
    atZoneStrict: boolean;
    insideZone: boolean;
    distancePips: number;
    sideOk: boolean;
  };
  liquidity: {
    liquidityScore: number;
    summary: string;
    nearbyPools: number;
    sweepEvent: {
      level: number;
      type: string;
      rejected: boolean;
    } | null;
  } | null;
  confirmation: {
    type: string;
    score: number;
    entryReady: boolean;
    direction: string;
    detail: string;
  } | null;
  entry: {
    direction: "long" | "short";
    entryPrice: number;
    slPrice: number;
    tpPrice: number | null;
    riskPips: number;
    rewardPips: number | null;
    rrRatio: number | null;
  } | null;
  storySummary: string;
  reason: string;
}

interface Props {
  data: UnifiedZoneData | null | undefined;
}

const STATE_COLORS: Record<string, string> = {
  triggered: "text-success",
  confirmed: "text-cyan-400",
  at_zone: "text-yellow-400",
  watching: "text-orange-400",
  no_zone: "text-muted-foreground",
  no_impulse: "text-muted-foreground",
  error: "text-destructive",
};

const STATE_LABELS: Record<string, string> = {
  triggered: "⚡ TRIGGERED",
  confirmed: "✓ Confirmed — Entry Ready",
  at_zone: "📍 At Zone — Waiting Confirmation",
  watching: "⏳ Watching (price not at zone)",
  no_zone: "— No Zone Found",
  no_impulse: "— No Impulse",
  error: "⚠ Error",
};

export function UnifiedZonePanel({ data }: Props) {
  if (!data) return null;

  const stateColor = STATE_COLORS[data.state] ?? "text-muted-foreground";
  const stateLabel = STATE_LABELS[data.state] ?? data.state;

  // Error state
  if (data.state === "error") {
    return (
      <div className="mt-3 p-3 rounded-lg bg-zinc-900/60 border border-red-900/50">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold text-zinc-200 uppercase tracking-wider">Unified Zone</span>
          <span className="text-xs font-bold text-destructive">⚠ Error</span>
        </div>
        <p className="text-[10px] text-destructive">{data.reason}</p>
      </div>
    );
  }

  // No impulse / no zone — minimal display
  if (data.state === "no_impulse" || (data.state === "no_zone" && !data.impulse)) {
    return (
      <div className="mt-3 p-3 rounded-lg bg-zinc-900/60 border border-zinc-800">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold text-zinc-200 uppercase tracking-wider">Unified Zone</span>
          <span className={`text-xs font-bold ${stateColor}`}>{stateLabel}</span>
        </div>
        <p className="text-[10px] text-zinc-300">{data.reason}</p>
      </div>
    );
  }

  return (
    <div className="mt-3 p-3 rounded-lg bg-zinc-900/60 border border-zinc-800">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-zinc-200 uppercase tracking-wider">Unified Zone</span>
          {data.selectedTF && (
            <span className="px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-400 text-[10px] font-bold">
              via {data.selectedTF}
            </span>
          )}
          {data.unifiedScore > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-cyan-900/50 text-cyan-400 text-[10px] font-bold">
              Score {data.unifiedScore.toFixed(1)}/14
            </span>
          )}
        </div>
        <span className={`text-xs font-bold ${stateColor}`}>{stateLabel}</span>
      </div>

      {/* Story progression */}
      <div className="space-y-1.5 text-[11px]">
        {/* 1. Impulse Leg */}
        <StoryBullet
          filled={!!data.impulse}
          label={`${data.impulse?.timeframe ?? ""} Impulse`}
        >
          {data.impulse ? (
            <div className="text-zinc-200 mt-0.5">
              <span className={data.impulse.direction === "bullish" ? "text-success" : "text-destructive"}>
                {data.impulse.direction === "bullish" ? "↑" : "↓"} {data.impulse.direction.toUpperCase()}
              </span>
              <span className="text-zinc-200 ml-2">
                {data.impulse.low.toFixed(5)} → {data.impulse.high.toFixed(5)}
              </span>
              <span className="text-cyan-400 ml-2">({data.impulse.pips.toFixed(0)} pips)</span>
              <div className="text-zinc-300 mt-0.5">
                BOS: {data.impulse.bosPrice.toFixed(5)}
                {data.impulse.startDate && data.impulse.endDate && (
                  <span className="ml-2">
                    {data.impulse.startDate} → {data.impulse.endDate}
                    <span className="text-muted-foreground ml-1">({data.impulse.spanBars} bars)</span>
                  </span>
                )}
              </div>
            </div>
          ) : (
            <span className="text-muted-foreground ml-1">None found</span>
          )}
        </StoryBullet>

        {/* 2. Zone */}
        <StoryBullet filled={!!data.zone} label="Zone">
          {data.zone ? (
            <span className="text-zinc-200">
              {data.zone.type} @ Fib {data.zone.fibLabel}
              {data.zone.srConfirmed && <span className="text-success ml-1">(S/R ✓)</span>}
              {!data.zone.srConfirmed && <span className="text-muted-foreground ml-1">(S/R ✗)</span>}
              <span className="text-zinc-300 ml-1">[{data.zone.low.toFixed(5)}–{data.zone.high.toFixed(5)}]</span>
              {data.zone.htfLayers.length > 0 && (
                <span className="text-blue-400 ml-1">[HTF: {data.zone.htfLayers.join("+")}]</span>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground ml-1">None found</span>
          )}
        </StoryBullet>

        {/* 3. Price */}
        <StoryBullet
          filled={data.price.atZone || data.price.insideZone}
          label="Price"
        >
          <span className="text-zinc-200">
            {data.price.insideZone ? (
              <span className="text-success">Inside zone</span>
            ) : data.price.atZone ? (
              <span className="text-success">At zone{!data.price.sideOk && " (wrong side)"}</span>
            ) : (
              <span className="text-orange-400">{data.price.distancePips.toFixed(1)} pips away</span>
            )}
          </span>
        </StoryBullet>

        {/* 4. Liquidity */}
        <StoryBullet
          filled={!!data.liquidity && data.liquidity.liquidityScore > 0}
          label="Liquidity"
        >
          {data.liquidity && data.liquidity.liquidityScore > 0 ? (
            <span className="text-zinc-200">
              {data.liquidity.summary}
              {data.liquidity.sweepEvent && (
                <span className={data.liquidity.sweepEvent.rejected ? "text-success ml-1" : "text-yellow-400 ml-1"}>
                  [{data.liquidity.sweepEvent.type} swept{data.liquidity.sweepEvent.rejected ? " + rejected" : ""}]
                </span>
              )}
              <span className="text-zinc-300 ml-1">({data.liquidity.nearbyPools} pools)</span>
            </span>
          ) : (
            <span className="text-muted-foreground">No significant pools near zone</span>
          )}
        </StoryBullet>

        {/* 5. Confirmation */}
        <StoryBullet
          filled={!!data.confirmation?.entryReady}
          partial={!!data.confirmation && data.confirmation.score > 0 && !data.confirmation.entryReady}
          label="Confirmation"
        >
          {data.confirmation?.entryReady ? (
            <span className="text-zinc-200">
              {data.confirmation.detail}
              <span className="text-cyan-400 ml-1">(+{data.confirmation.score.toFixed(1)})</span>
            </span>
          ) : data.confirmation && data.confirmation.score > 0 ? (
            <span className="text-yellow-400">
              {data.confirmation.detail} (partial — not entry-ready)
            </span>
          ) : (
            <span className="text-muted-foreground">
              Waiting for CHoCH/displacement in {data.impulse?.direction ?? "—"} direction
            </span>
          )}
        </StoryBullet>

        {/* 6. Entry */}
        <StoryBullet filled={!!data.entry} label="Entry">
          {data.entry ? (
            <div className="text-zinc-200 mt-0.5">
              <span className={data.entry.direction === "long" ? "text-success font-bold" : "text-destructive font-bold"}>
                {data.entry.direction.toUpperCase()}
              </span>
              <span className="font-mono ml-2">@ {data.entry.entryPrice.toFixed(5)}</span>
              <span className="text-destructive font-mono ml-2">SL: {data.entry.slPrice.toFixed(5)}</span>
              {data.entry.tpPrice && (
                <span className="text-success font-mono ml-2">TP: {data.entry.tpPrice.toFixed(5)}</span>
              )}
              <div className="flex gap-2 mt-0.5 text-[10px]">
                <span className="text-zinc-300">Risk: {data.entry.riskPips.toFixed(1)} pips</span>
                {data.entry.rewardPips && <span className="text-zinc-300">Reward: {data.entry.rewardPips.toFixed(1)} pips</span>}
                {data.entry.rrRatio && (
                  <span className={data.entry.rrRatio >= 3 ? "text-success font-bold" : data.entry.rrRatio >= 2 ? "text-cyan-400" : "text-orange-400"}>
                    R:R {data.entry.rrRatio}:1
                  </span>
                )}
              </div>
            </div>
          ) : data.state === "confirmed" || data.state === "triggered" ? (
            <span className="text-orange-400">R:R below minimum — no entry</span>
          ) : (
            <span className="text-muted-foreground">Not yet</span>
          )}
        </StoryBullet>
      </div>

      {/* Score breakdown */}
      {data.hasZone && (
        <div className="mt-2 pt-2 border-t border-zinc-800 flex flex-wrap gap-2 text-[10px]">
          <span className="text-zinc-300">Base: {data.scoreBreakdown.baseScore.toFixed(1)}/9</span>
          {data.scoreBreakdown.liquidityBonus > 0 && (
            <span className="text-purple-400">Liq: +{data.scoreBreakdown.liquidityBonus.toFixed(1)}</span>
          )}
          {data.scoreBreakdown.confirmationBonus > 0 && (
            <span className="text-cyan-400">Conf: +{data.scoreBreakdown.confirmationBonus.toFixed(1)}</span>
          )}
          {data.scoreBreakdown.tfBonus > 0 && (
            <span className="text-blue-400">TF: +{data.scoreBreakdown.tfBonus.toFixed(1)}</span>
          )}
        </div>
      )}

      {/* Reason */}
      <p className="text-[10px] text-zinc-300 mt-2 leading-relaxed">{data.reason}</p>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────

function StoryBullet({
  filled,
  partial,
  label,
  children,
}: {
  filled: boolean;
  partial?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  const bulletColor = filled ? "text-success" : partial ? "text-yellow-400" : "text-muted-foreground";
  const bullet = filled ? "●" : partial ? "◐" : "○";

  return (
    <div className="flex items-start gap-2">
      <span className={`${bulletColor} mt-0.5`}>{bullet}</span>
      <div className="flex-1">
        <span className="text-zinc-200 font-medium">{label}:</span>
        {children}
      </div>
    </div>
  );
}
