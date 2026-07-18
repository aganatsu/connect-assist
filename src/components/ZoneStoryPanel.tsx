/**
 * ZoneStoryPanel — Consolidated zone display that tells the full trade story.
 *
 * Table-based layout for quick scanning:
 * Impulse → Zone → Price → Liquidity → Confirmation → Entry
 *
 * Data comes from detail.unifiedZone (the story) and detail.impulseZone (gate data).
 */

import { formatPipDisplay } from "@/lib/pipDisplay";

/** Format ISO timestamp to readable AM/PM format: "Jul 15, 8:00 PM" */
function formatTraceDate(iso: string): string {
  try {
    const d = new Date(iso.includes("T") ? iso : iso + "T00:00:00");
    if (isNaN(d.getTime())) return iso;
    const hasTime = iso.includes("T");
    if (!hasTime) {
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return iso;
  }
}

interface ZoneStoryData {
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
  isLiveContext?: boolean;
  symbol?: string;
}

const STATE_COLORS: Record<string, string> = {
  triggered: "text-green-400",
  confirmed: "text-cyan-400",
  at_zone: "text-yellow-400",
  watching: "text-orange-400",
  no_zone: "text-zinc-400",
  no_impulse: "text-zinc-400",
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
          <span className="text-xs font-semibold text-zinc-200 uppercase tracking-wider">Zone Story</span>
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
          <span className="text-xs font-semibold text-zinc-200 uppercase tracking-wider">Zone Story</span>
          <span className={`text-xs font-bold ${stateColor}`}>{stateLabel}</span>
        </div>
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
            <p className="text-[10px] text-zinc-300 leading-tight">{unifiedData.reason}</p>
          </div>
        ) : (
          <p className="text-[10px] text-zinc-300">{unifiedData.reason}</p>
        )}
      </div>
    );
  }

  // ─── Main Zone Story Table Layout ───
  return (
    <div className="mt-3 p-3 rounded-lg bg-zinc-900/80 border border-zinc-700">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-zinc-200 uppercase tracking-wider">Zone Story</span>
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
          {isLiveContext && gateData?.bestZone && (gateData.bestZone.priceInsideZone || gateData.bestZone.priceAtZoneStrict) && (
            <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-300 animate-pulse">
              ⏳ Hunting CHoCH
            </span>
          )}
          <span className={`text-xs font-bold ${stateColor}`}>{stateLabel}</span>
        </div>
      </div>

      {/* Table */}
      <table className="w-full text-[11px] border-collapse">
        <tbody>
          {/* Impulse Row */}
          <tr className="border-b border-zinc-800/50">
            <td className="py-1.5 pr-2 align-top w-5">
              <Bullet filled={!!unifiedData.impulse} />
            </td>
            <td className="py-1.5 pr-2 align-top text-zinc-200 font-medium whitespace-nowrap w-24">
              Impulse
            </td>
            <td className="py-1.5 text-zinc-200">
              {unifiedData.impulse ? (
                <div>
                  <span className={unifiedData.impulse.direction === "bullish" ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
                    {unifiedData.impulse.direction === "bullish" ? "↑" : "↓"} {unifiedData.impulse.direction.toUpperCase()}
                  </span>
                  <span className="ml-2">{fmt(unifiedData.impulse.low)} → {fmt(unifiedData.impulse.high)}</span>
                  <span className="text-cyan-400 ml-2">({fmtPips(unifiedData.impulse.pips, { absolute: true })})</span>
                </div>
              ) : (
                <span className="text-zinc-400">None found</span>
              )}
            </td>
          </tr>

          {/* Trace Row */}
          {unifiedData.impulse?.startDate && unifiedData.impulse?.endDate && (
            <tr className="border-b border-zinc-800/50">
              <td className="py-1 pr-2"></td>
              <td className="py-1 pr-2 align-top text-zinc-400 whitespace-nowrap">Trace</td>
              <td className="py-1">
                <span className="text-green-400 font-mono">{formatTraceDate(unifiedData.impulse.startDate)}</span>
                <span className="text-zinc-500 mx-1">→</span>
                <span className="text-red-400 font-mono">{formatTraceDate(unifiedData.impulse.endDate)}</span>
                <span className="text-zinc-400 ml-2">({unifiedData.impulse.spanBars} {unifiedData.impulse.timeframe} bars)</span>
              </td>
            </tr>
          )}

          {/* BOS Row */}
          {unifiedData.impulse && (
            <tr className="border-b border-zinc-800/50">
              <td className="py-1 pr-2"></td>
              <td className="py-1 pr-2 align-top text-zinc-400 whitespace-nowrap">BOS</td>
              <td className="py-1 font-mono text-zinc-200">{fmt(unifiedData.impulse.bosPrice)}</td>
            </tr>
          )}

          {/* Zone Row */}
          <tr className="border-b border-zinc-800/50">
            <td className="py-1.5 pr-2 align-top">
              <Bullet filled={!!unifiedData.zone} />
            </td>
            <td className="py-1.5 pr-2 align-top text-zinc-200 font-medium whitespace-nowrap">Zone</td>
            <td className="py-1.5 text-zinc-200">
              {unifiedData.zone ? (
                <div>
                  <span>{unifiedData.zone.type} @ Fib {unifiedData.zone.fibLabel}</span>
                  <span className={unifiedData.zone.srConfirmed ? "text-green-400 ml-1" : "text-zinc-400 ml-1"}>
                    (S/R {unifiedData.zone.srConfirmed ? "✓" : "✗"})
                  </span>
                  <span className="text-zinc-300 ml-1">[{fmt(unifiedData.zone.low)}–{fmt(unifiedData.zone.high)}]</span>
                </div>
              ) : (
                <span className="text-zinc-400">None found</span>
              )}
            </td>
          </tr>

          {/* HTF Row */}
          {unifiedData.zone && unifiedData.zone.htfLayers.length > 0 && (
            <tr className="border-b border-zinc-800/50">
              <td className="py-1 pr-2"></td>
              <td className="py-1 pr-2 align-top text-zinc-400 whitespace-nowrap">HTF</td>
              <td className="py-1 text-blue-400 font-mono text-[10px]">{unifiedData.zone.htfLayers.join(" + ")}</td>
            </tr>
          )}

          {/* LTF + Gate Score Row */}
          {gateData?.bestZone && (
            <tr className="border-b border-zinc-800/50">
              <td className="py-1 pr-2"></td>
              <td className="py-1 pr-2 align-top text-zinc-400 whitespace-nowrap">Gate Score</td>
              <td className="py-1">
                <span className={`font-mono px-1 py-0.5 rounded text-[10px] ${
                  gateData.bestZone.totalScore >= 5 ? "bg-green-500/15 text-green-400"
                  : gateData.bestZone.totalScore >= 3 ? "bg-cyan-500/15 text-cyan-400"
                  : "bg-zinc-500/15 text-zinc-500"
                }`}>
                  {gateData.bestZone.totalScore.toFixed(1)}/9
                </span>
                {gateData.bestZone.ltfRefined && (
                  <span className="text-[10px] font-mono px-1 py-0.5 rounded bg-green-500/15 text-green-400 ml-1">
                    LTF ✓ {gateData.bestZone.ltfType?.toUpperCase() || ""}
                  </span>
                )}
                {gateData.bestZone.refinedEntry && (
                  <span className="text-[10px] font-mono text-zinc-400 ml-2">
                    Entry: {fmt(gateData.bestZone.refinedEntry)}
                  </span>
                )}
                {gateData.bestZone.refinedSL && (
                  <span className="text-[10px] font-mono text-zinc-400 ml-2">
                    SL: {fmt(gateData.bestZone.refinedSL)}
                  </span>
                )}
              </td>
            </tr>
          )}

          {/* Price Row */}
          <tr className="border-b border-zinc-800/50">
            <td className="py-1.5 pr-2 align-top">
              <Bullet filled={unifiedData.price.atZone || unifiedData.price.insideZone} />
            </td>
            <td className="py-1.5 pr-2 align-top text-zinc-200 font-medium whitespace-nowrap">Price</td>
            <td className="py-1.5">
              {unifiedData.price.insideZone ? (
                <span className="text-green-400">Inside zone</span>
              ) : unifiedData.price.atZone ? (
                <span className="text-green-400">At zone{!unifiedData.price.sideOk && " (wrong side)"}</span>
              ) : (
                <span className="text-orange-400">{fmtPips(unifiedData.price.distancePips, { absolute: true })} away</span>
              )}
            </td>
          </tr>

          {/* Liquidity Row */}
          <tr className="border-b border-zinc-800/50">
            <td className="py-1.5 pr-2 align-top">
              <Bullet filled={!!unifiedData.liquidity && unifiedData.liquidity.liquidityScore > 0} />
            </td>
            <td className="py-1.5 pr-2 align-top text-zinc-200 font-medium whitespace-nowrap">Liquidity</td>
            <td className="py-1.5">
              {unifiedData.liquidity && unifiedData.liquidity.liquidityScore > 0 ? (
                <span className="text-zinc-200">
                  {unifiedData.liquidity.summary}
                  {unifiedData.liquidity.sweepEvent && (
                    <span className={unifiedData.liquidity.sweepEvent.rejected ? "text-green-400 ml-1" : "text-yellow-400 ml-1"}>
                      [{unifiedData.liquidity.sweepEvent.type} swept{unifiedData.liquidity.sweepEvent.rejected ? " + rejected" : ""}]
                    </span>
                  )}
                  <span className="text-zinc-400 ml-1">({unifiedData.liquidity.nearbyPools} pools)</span>
                </span>
              ) : (
                <span className="text-zinc-400">No significant pools near zone</span>
              )}
            </td>
          </tr>

          {/* Confirmation Row */}
          <tr className="border-b border-zinc-800/50">
            <td className="py-1.5 pr-2 align-top">
              <Bullet
                filled={!!unifiedData.confirmation?.entryReady}
                partial={!!unifiedData.confirmation && unifiedData.confirmation.score > 0 && !unifiedData.confirmation.entryReady}
              />
            </td>
            <td className="py-1.5 pr-2 align-top text-zinc-200 font-medium whitespace-nowrap">Confirmation</td>
            <td className="py-1.5">
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
                <span className="text-zinc-400">
                  Waiting for CHoCH/displacement in {unifiedData.impulse?.direction ?? "—"} direction
                </span>
              )}
            </td>
          </tr>

          {/* Entry Row */}
          <tr>
            <td className="py-1.5 pr-2 align-top">
              <Bullet filled={!!unifiedData.entry} />
            </td>
            <td className="py-1.5 pr-2 align-top text-zinc-200 font-medium whitespace-nowrap">Entry</td>
            <td className="py-1.5">
              {unifiedData.entry ? (
                <div>
                  <span className={unifiedData.entry.direction === "long" ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
                    {unifiedData.entry.direction.toUpperCase()}
                  </span>
                  <span className="font-mono ml-2">@ {fmt(unifiedData.entry.entryPrice)}</span>
                  <span className="text-red-400 font-mono ml-2">SL: {fmt(unifiedData.entry.slPrice)}</span>
                  {unifiedData.entry.tpPrice && (
                    <span className="text-green-400 font-mono ml-2">TP: {fmt(unifiedData.entry.tpPrice)}</span>
                  )}
                  {unifiedData.entry.rrRatio && (
                    <span className={`ml-2 font-bold ${unifiedData.entry.rrRatio >= 3 ? "text-green-400" : unifiedData.entry.rrRatio >= 2 ? "text-cyan-400" : "text-orange-400"}`}>
                      R:R {unifiedData.entry.rrRatio}:1
                    </span>
                  )}
                </div>
              ) : unifiedData.state === "confirmed" || unifiedData.state === "triggered" ? (
                <span className="text-orange-400">R:R below minimum — no entry</span>
              ) : (
                <span className="text-zinc-400">Not yet</span>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      {/* Score breakdown footer */}
      {unifiedData.hasZone && (
        <div className="mt-2 pt-2 border-t border-zinc-800 flex flex-wrap gap-2 text-[10px]">
          <span className="text-zinc-300">Base: {unifiedData.scoreBreakdown.baseScore.toFixed(1)}/9</span>
          {unifiedData.scoreBreakdown.liquidityBonus > 0 && (
            <span className="text-purple-400">Liq: +{unifiedData.scoreBreakdown.liquidityBonus.toFixed(1)}</span>
          )}
          {unifiedData.scoreBreakdown.confirmationBonus > 0 && (
            <span className="text-cyan-400">Conf: +{unifiedData.scoreBreakdown.confirmationBonus.toFixed(1)}</span>
          )}
          {unifiedData.scoreBreakdown.tfBonus > 0 && (
            <span className="text-blue-400">TF: +{unifiedData.scoreBreakdown.tfBonus.toFixed(1)}</span>
          )}
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
      <p className="text-[10px] text-zinc-300 mt-2 leading-relaxed">
        {unifiedData.selectedTF ?? "—"} zone selected
        {unifiedData.scoreBreakdown.tfBonus >= 2.0 ? " (A+ setup)" : unifiedData.scoreBreakdown.tfBonus >= 1.0 ? " (B+ setup)" : ""}: {unifiedData.reason}
      </p>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

function fmt(price: number | null | undefined): string {
  if (price == null) return "—";
  return price > 10 ? price.toFixed(3) : price.toFixed(5);
}

function Bullet({ filled, partial }: { filled: boolean; partial?: boolean }) {
  const color = filled ? "text-green-400" : partial ? "text-yellow-400" : "text-zinc-400";
  const char = filled ? "●" : partial ? "◐" : "○";
  return <span className={`${color} text-[11px]`}>{char}</span>;
}

export default ZoneStoryPanel;
