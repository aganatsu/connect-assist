/**
 * ZoneStoryPanel — Consolidated zone display that tells the full trade story.
 *
 * Replaces both ImpulseZonePanel and UnifiedZonePanel with a single narrative:
 * Impulse → Zone → Price → Liquidity → Confirmation → Entry
 *
 * Shows the zone detection result from the unified engine (which now includes
 * Daily → 4H → 1H waterfall). When price is at zone, shows live action
 * indicators (CHoCH hunting, confirmation status).
 *
 * Data comes from detail.unifiedZone (the story) and detail.impulseZone (gate data).
 */

import { formatPipDisplay } from "@/lib/pipDisplay";

interface ZoneStoryData {
  hasZone: boolean;
  state: string;
  selectedTF: "D" | "4H" | "1H" | null;
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

interface ImpulseGateData {
  hasZone: boolean;
  selectedTF: string | null;
  bestZone: {
    type: string;
    totalScore: number;
    srConfirmed: boolean;
    ltfRefined: boolean;
    ltfType: string | null;
    refinedEntry: number | null;
    refinedSL: number | null;
    priceAtZone: boolean;
    priceInsideZone?: boolean;
    priceAtZoneStrict?: boolean;
    sideOk?: boolean;
    distancePips?: number;
  } | null;
  scoringEnabled?: boolean;
  directionDetail?: {
    bias: "bullish" | "bearish" | null;
    biasSource: "daily" | "4h" | null;
    h4Retrace: boolean;
    h4ChochAgainst: boolean;
    h1Confirmed: boolean;
  } | null;
}

interface Props {
  unifiedData: ZoneStoryData | null | undefined;
  gateData?: ImpulseGateData | null | undefined;
  /** When true, live-action badges ("Hunting 5m CHoCH") are shown. */
  isLiveContext?: boolean;
  /** Trading symbol (e.g. "EUR/USD", "ETH/USD") — used for asset-aware pip/$/pts labels. */
  symbol?: string;
}

const STATE_COLORS: Record<string, string> = {
  triggered: "text-green-400",
  confirmed: "text-cyan-400",
  at_zone: "text-yellow-400",
  watching: "text-orange-400",
  no_zone: "text-zinc-500",
  no_impulse: "text-zinc-500",
  error: "text-red-400",
};

const STATE_LABELS: Record<string, string> = {
  triggered: "⚡ TRIGGERED",
  confirmed: "✓ Confirmed",
  at_zone: "📍 At Zone",
  watching: "⏳ Watching",
  no_zone: "— No Zone",
  no_impulse: "— No Impulse",
  error: "⚠ Error",
};

export function ZoneStoryPanel({ unifiedData, gateData, isLiveContext = false, symbol }: Props) {
  if (!unifiedData) return null;

  // Asset-aware formatter — falls back to plain "X pips" if no symbol provided
  const fmtPips = (raw: number | null | undefined, opts: { showSign?: boolean; absolute?: boolean; decimals?: number } = {}) => {
    if (raw == null) return "—";
    if (symbol) {
      return formatPipDisplay(raw, symbol, { showSign: opts.showSign ?? false, absolute: opts.absolute });
    }
    const d = opts.decimals ?? 1;
    const v = opts.absolute ? Math.abs(raw) : raw;
    return `${v.toFixed(d)} pips`;
  };

  const stateColor = STATE_COLORS[unifiedData.state] ?? "text-zinc-400";
  const stateLabel = STATE_LABELS[unifiedData.state] ?? unifiedData.state;

  // Error state
  if (unifiedData.state === "error") {
    return (
      <div className="mt-3 p-3 rounded-lg bg-zinc-900/60 border border-red-900/50">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Zone Story</span>
          <span className="text-xs font-bold text-red-400">⚠ Error</span>
        </div>
        <p className="text-[10px] text-red-400">{unifiedData.reason}</p>
      </div>
    );
  }

  // No impulse / no zone — show direction detail if available
  if (unifiedData.state === "no_impulse" || (unifiedData.state === "no_zone" && !unifiedData.impulse)) {
    return (
      <div className="mt-3 p-3 rounded-lg bg-zinc-900/60 border border-zinc-800">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Zone Story</span>
          <span className={`text-xs font-bold ${stateColor}`}>{stateLabel}</span>
        </div>
        {/* Direction detail from gate data (when no zone search ran) */}
        {gateData?.directionDetail ? (
          <div className="space-y-1">
            <div className="flex items-center gap-1 flex-wrap">
              {gateData.directionDetail.bias && (
                <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
                  gateData.directionDetail.bias === "bullish" ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"
                }`}>
                  {gateData.directionDetail.biasSource?.toUpperCase()} {gateData.directionDetail.bias === "bullish" ? "↑ BULL" : "↓ BEAR"}
                </span>
              )}
              {!gateData.directionDetail.bias && (
                <span className="text-[10px] font-mono px-1 py-0.5 rounded bg-zinc-500/15 text-zinc-500">
                  NO BIAS
                </span>
              )}
              <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
                gateData.directionDetail.h4Retrace ? "bg-yellow-500/15 text-yellow-400" : "bg-zinc-500/10 text-zinc-500"
              }`}>
                4H {gateData.directionDetail.h4ChochAgainst ? "✗ CHoCH AGAINST" : gateData.directionDetail.h4Retrace ? "↩ RETRACE" : "— intact"}
              </span>
              <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
                gateData.directionDetail.h1Confirmed ? "bg-green-500/15 text-green-400" : "bg-zinc-500/10 text-zinc-500"
              }`}>
                1H {gateData.directionDetail.h1Confirmed ? "✓ CONFIRMED" : "✗ waiting"}
              </span>
            </div>
            <p className="text-[10px] text-zinc-500 leading-tight">{unifiedData.reason}</p>
          </div>
        ) : (
          <p className="text-[10px] text-zinc-500">{unifiedData.reason}</p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 p-3 rounded-lg bg-zinc-900/60 border border-zinc-800">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Zone Story</span>
          {unifiedData.selectedTF && (
            <span className="px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-400 text-[10px] font-bold">
              via {unifiedData.selectedTF}
            </span>
          )}
          {unifiedData.unifiedScore > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-cyan-900/50 text-cyan-400 text-[10px] font-bold">
              Score {unifiedData.unifiedScore.toFixed(1)}/14
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {/* Live action indicator */}
          {isLiveContext && gateData?.bestZone && (gateData.bestZone.priceInsideZone || gateData.bestZone.priceAtZoneStrict) && (
            <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-300 animate-pulse">
              ⏳ Hunting CHoCH
            </span>
          )}
          <span className={`text-xs font-bold ${stateColor}`}>{stateLabel}</span>
        </div>
      </div>

      {/* Story progression */}
      <div className="space-y-1.5 text-[11px]">
        {/* 1. Impulse Leg */}
        <StoryBullet filled={!!unifiedData.impulse} label={`${unifiedData.impulse?.timeframe ?? ""} Impulse`}>
          {unifiedData.impulse ? (
            <div className="text-zinc-200 mt-0.5">
              <span className={unifiedData.impulse.direction === "bullish" ? "text-green-400" : "text-red-400"}>
                {unifiedData.impulse.direction === "bullish" ? "↑" : "↓"} {unifiedData.impulse.direction.toUpperCase()}
              </span>
              <span className="text-zinc-400 ml-2">
                {fmt(unifiedData.impulse.low)} → {fmt(unifiedData.impulse.high)}
              </span>
              <span className="text-cyan-400 ml-2">({fmtPips(unifiedData.impulse.pips, { absolute: true })})</span>
              <div className="text-zinc-500 mt-0.5">
                BOS: {fmt(unifiedData.impulse.bosPrice)}
                {unifiedData.impulse.startDate && unifiedData.impulse.endDate && (
                  <span className="ml-2">
                    {unifiedData.impulse.startDate} → {unifiedData.impulse.endDate}
                    <span className="text-zinc-600 ml-1">({unifiedData.impulse.spanBars} bars)</span>
                  </span>
                )}
              </div>
            </div>
          ) : (
            <span className="text-zinc-600 ml-1">None found</span>
          )}
        </StoryBullet>

        {/* 2. Zone (with gate scoring from impulseZone data) */}
        <StoryBullet filled={!!unifiedData.zone} label="Zone">
          {unifiedData.zone ? (
            <div className="text-zinc-200">
              <span>{unifiedData.zone.type} @ Fib {unifiedData.zone.fibLabel}</span>
              <span className={unifiedData.zone.srConfirmed ? "text-green-400 ml-1" : "text-zinc-500 ml-1"}>
                (S/R {unifiedData.zone.srConfirmed ? "✓" : "✗"})
              </span>
              <span className="text-zinc-500 ml-1">[{fmt(unifiedData.zone.low)}–{fmt(unifiedData.zone.high)}]</span>
              {unifiedData.zone.htfLayers.length > 0 && (
                <span className="text-blue-400 ml-1">[HTF: {unifiedData.zone.htfLayers.join("+")}]</span>
              )}
              {/* Gate scoring badge from impulse zone data */}
              {gateData?.bestZone && (
                <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                  <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
                    gateData.bestZone.totalScore >= 5 ? "bg-green-500/15 text-green-400"
                    : gateData.bestZone.totalScore >= 3 ? "bg-cyan-500/15 text-cyan-400"
                    : "bg-zinc-500/15 text-zinc-500"
                  }`}>
                    Gate Score {gateData.bestZone.totalScore.toFixed(1)}/9
                  </span>
                  {gateData.bestZone.ltfRefined && (
                    <span className="text-[10px] font-mono px-1 py-0.5 rounded bg-green-500/15 text-green-400">
                      LTF ✓ {gateData.bestZone.ltfType?.toUpperCase() || ""}
                    </span>
                  )}
                  {gateData.bestZone.refinedEntry && (
                    <span className="text-[10px] font-mono text-zinc-400">
                      Entry: {fmt(gateData.bestZone.refinedEntry)}
                    </span>
                  )}
                  {gateData.bestZone.refinedSL && (
                    <span className="text-[10px] font-mono text-zinc-400">
                      SL: {fmt(gateData.bestZone.refinedSL)}
                    </span>
                  )}
                </div>
              )}
            </div>
          ) : (
            <span className="text-zinc-600 ml-1">None found</span>
          )}
        </StoryBullet>

        {/* 3. Price */}
        <StoryBullet filled={unifiedData.price.atZone || unifiedData.price.insideZone} label="Price">
          <span className="text-zinc-200">
            {unifiedData.price.insideZone ? (
              <span className="text-green-400">Inside zone</span>
            ) : unifiedData.price.atZone ? (
              <span className="text-green-400">At zone{!unifiedData.price.sideOk && " (wrong side)"}</span>
            ) : (
              <span className="text-orange-400">{fmtPips(unifiedData.price.distancePips, { absolute: true })} away</span>
            )}
          </span>
        </StoryBullet>

        {/* 4. Liquidity */}
        <StoryBullet filled={!!unifiedData.liquidity && unifiedData.liquidity.liquidityScore > 0} label="Liquidity">
          {unifiedData.liquidity && unifiedData.liquidity.liquidityScore > 0 ? (
            <span className="text-zinc-200">
              {unifiedData.liquidity.summary}
              {unifiedData.liquidity.sweepEvent && (
                <span className={unifiedData.liquidity.sweepEvent.rejected ? "text-green-400 ml-1" : "text-yellow-400 ml-1"}>
                  [{unifiedData.liquidity.sweepEvent.type} swept{unifiedData.liquidity.sweepEvent.rejected ? " + rejected" : ""}]
                </span>
              )}
              <span className="text-zinc-500 ml-1">({unifiedData.liquidity.nearbyPools} pools)</span>
            </span>
          ) : (
            <span className="text-zinc-600">No significant pools near zone</span>
          )}
        </StoryBullet>

        {/* 5. Confirmation */}
        <StoryBullet
          filled={!!unifiedData.confirmation?.entryReady}
          partial={!!unifiedData.confirmation && unifiedData.confirmation.score > 0 && !unifiedData.confirmation.entryReady}
          label="Confirmation"
        >
          {unifiedData.confirmation?.entryReady ? (
            <span className="text-zinc-200">
              {unifiedData.confirmation.detail}
              <span className="text-cyan-400 ml-1">(+{unifiedData.confirmation.score.toFixed(1)})</span>
            </span>
          ) : unifiedData.confirmation && unifiedData.confirmation.score > 0 ? (
            <span className="text-yellow-400">
              {unifiedData.confirmation.detail} (partial — not entry-ready)
            </span>
          ) : (
            <span className="text-zinc-600">
              Waiting for CHoCH/displacement in {unifiedData.impulse?.direction ?? "—"} direction
            </span>
          )}
        </StoryBullet>

        {/* 6. Entry */}
        <StoryBullet filled={!!unifiedData.entry} label="Entry">
          {unifiedData.entry ? (
            <div className="text-zinc-200 mt-0.5">
              <span className={unifiedData.entry.direction === "long" ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
                {unifiedData.entry.direction.toUpperCase()}
              </span>
              <span className="font-mono ml-2">@ {fmt(unifiedData.entry.entryPrice)}</span>
              <span className="text-red-400 font-mono ml-2">SL: {fmt(unifiedData.entry.slPrice)}</span>
              {unifiedData.entry.tpPrice && (
                <span className="text-green-400 font-mono ml-2">TP: {fmt(unifiedData.entry.tpPrice)}</span>
              )}
              <div className="flex gap-2 mt-0.5 text-[10px]">
                <span className="text-zinc-500">Risk: {fmtPips(unifiedData.entry.riskPips, { absolute: true })}</span>
                {unifiedData.entry.rewardPips && <span className="text-zinc-500">Reward: {fmtPips(unifiedData.entry.rewardPips, { absolute: true })}</span>}
                {unifiedData.entry.rrRatio && (
                  <span className={unifiedData.entry.rrRatio >= 3 ? "text-green-400 font-bold" : unifiedData.entry.rrRatio >= 2 ? "text-cyan-400" : "text-orange-400"}>
                    R:R {unifiedData.entry.rrRatio}:1
                  </span>
                )}
              </div>
            </div>
          ) : unifiedData.state === "confirmed" || unifiedData.state === "triggered" ? (
            <span className="text-orange-400">R:R below minimum — no entry</span>
          ) : (
            <span className="text-zinc-600">Not yet</span>
          )}
        </StoryBullet>
      </div>

      {/* Score breakdown */}
      {unifiedData.hasZone && (
        <div className="mt-2 pt-2 border-t border-zinc-800 flex flex-wrap gap-2 text-[10px]">
          <span className="text-zinc-500">Base: {unifiedData.scoreBreakdown.baseScore.toFixed(1)}/9</span>
          {unifiedData.scoreBreakdown.liquidityBonus > 0 && (
            <span className="text-purple-400">Liq: +{unifiedData.scoreBreakdown.liquidityBonus.toFixed(1)}</span>
          )}
          {unifiedData.scoreBreakdown.confirmationBonus > 0 && (
            <span className="text-cyan-400">Conf: +{unifiedData.scoreBreakdown.confirmationBonus.toFixed(1)}</span>
          )}
          {unifiedData.scoreBreakdown.tfBonus > 0 && (
            <span className="text-blue-400">TF: +{unifiedData.scoreBreakdown.tfBonus.toFixed(1)}</span>
          )}
          {/* Gate scoring impact */}
          {gateData?.scoringEnabled && (
            <span className={`font-mono font-bold px-1 py-0.5 rounded ${
              gateData.bestZone?.priceAtZone
                ? "bg-green-500/15 text-green-400"
                : !gateData.hasZone
                  ? "bg-red-500/15 text-red-400"
                  : "bg-zinc-500/10 text-zinc-500"
            }`}>
              {gateData.bestZone?.priceAtZone ? "+bonus" : !gateData.hasZone ? "−penalty" : "neutral"}
            </span>
          )}
        </div>
      )}

      {/* Story summary */}
      <p className="text-[10px] text-zinc-500 mt-2 leading-relaxed">
        {unifiedData.selectedTF === "D" ? "Daily" : unifiedData.selectedTF === "4H" ? "4H" : "1H"} zone selected
        {unifiedData.selectedTF === "D" ? " (A+ setup)" : unifiedData.selectedTF === "4H" ? " (B+ setup)" : ""}: {unifiedData.reason}
      </p>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

function fmt(price: number | null | undefined): string {
  if (price == null) return "—";
  return price > 10 ? price.toFixed(3) : price.toFixed(5);
}

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
  const bulletColor = filled ? "text-green-400" : partial ? "text-yellow-400" : "text-zinc-600";
  const bullet = filled ? "●" : partial ? "◐" : "○";

  return (
    <div className="flex items-start gap-2">
      <span className={`${bulletColor} mt-0.5`}>{bullet}</span>
      <div className="flex-1">
        <span className="text-zinc-400">{label}:</span>
        {children}
      </div>
    </div>
  );
}

export default ZoneStoryPanel;
