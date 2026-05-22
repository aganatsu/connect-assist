/**
 * ImpulseZonePanel — Displays impulse zone detection results in the scan detail panel.
 * Shows zone status, selected timeframe, Fib alignment, S/R confirmation, LTF refinement,
 * and scoring impact.
 *
 * When direction is null (no zone search ran), shows the direction engine's reason
 * so the user understands what needs to happen for a zone to appear.
 *
 * Expects `impulseZone` data from the scan detail object (detail.impulseZone).
 */

interface ImpulseZoneData {
  hasZone: boolean;
  selectedTF: "1H" | "4H" | null;
  reason: string;
  impulse: {
    high: number;
    low: number;
    direction: "bullish" | "bearish";
  } | null;
  bestZone: {
    type: "ob" | "fvg";
    high: number;
    low: number;
    fibLevel: number;
    fibDepth: number;
    totalScore: number;
    srConfirmed: boolean;
    ltfRefined: boolean;
    ltfType: "ob" | "fvg" | null;
    refinedEntry: number | null;
    refinedSL: number | null;
    priceAtZone: boolean;
    distanceToZone: number;
  } | null;
  allZonesCount: number;
  h1HasZone: boolean;
  h4HasZone: boolean;
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
  data: ImpulseZoneData | null | undefined;
}

export function ImpulseZonePanel({ data }: Props) {
  if (!data) return null;

  const { hasZone, selectedTF, reason, impulse, bestZone, allZonesCount, h1HasZone, h4HasZone, scoringEnabled, directionDetail } = data;

  // Color scheme based on zone status
  const borderColor = hasZone
    ? bestZone?.priceAtZone
      ? "border-emerald-500/40"
      : "border-violet-500/30"
    : "border-zinc-500/20";
  const bgColor = hasZone
    ? bestZone?.priceAtZone
      ? "bg-emerald-500/5"
      : "bg-violet-500/5"
    : "bg-zinc-500/5";
  const titleColor = hasZone
    ? bestZone?.priceAtZone
      ? "text-emerald-400"
      : "text-violet-400"
    : "text-zinc-400";

  // Format price based on magnitude
  const fmt = (price: number | null | undefined) => {
    if (price == null) return "—";
    return price > 10 ? price.toFixed(3) : price.toFixed(5);
  };

  // Fib level label
  const fibLabel = (level: number) => `${(level * 100).toFixed(1)}%`;

  // Score badge color
  const scoreBadgeColor = (score: number) => {
    if (score >= 5) return "bg-emerald-500/20 text-emerald-300";
    if (score >= 3) return "bg-violet-500/20 text-violet-300";
    if (score >= 1) return "bg-amber-500/20 text-amber-300";
    return "bg-zinc-500/20 text-zinc-400";
  };

  return (
    <div className={`rounded border ${borderColor} ${bgColor} px-2 py-1.5 space-y-1.5`}>
      {/* Header row */}
      <div className="flex items-center gap-2">
        <p className={`text-[11px] uppercase tracking-wider font-bold ${titleColor}`}>
          Impulse Zone
        </p>
        {/* TF badges */}
        <div className="flex gap-0.5">
          <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
            h1HasZone ? "bg-blue-500/20 text-blue-300" : "bg-zinc-500/10 text-zinc-500"
          }`}>1H{h1HasZone ? " ✓" : ""}</span>
          <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
            h4HasZone ? "bg-purple-500/20 text-purple-300" : "bg-zinc-500/10 text-zinc-500"
          }`}>4H{h4HasZone ? " ✓" : ""}</span>
        </div>
        {/* Status badge */}
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ml-auto ${
          hasZone
            ? bestZone?.priceAtZone
              ? "bg-emerald-500/20 text-emerald-300"
              : "bg-violet-500/15 text-violet-300"
            : "bg-zinc-500/15 text-zinc-400"
        }`}>
          {hasZone ? (bestZone?.priceAtZone ? "AT ZONE" : "ZONE FOUND") : "NO ZONE"}
        </span>
      </div>

      {/* Zone details — only show when zone exists */}
      {hasZone && bestZone && (
        <>
          {/* Zone type + Fib + Score row */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded ${
              bestZone.type === "ob" ? "bg-orange-500/15 text-orange-300" : "bg-cyan-500/15 text-cyan-300"
            }`}>
              {bestZone.type.toUpperCase()}
            </span>
            <span className="text-[11px] font-mono text-amber-300 px-1 py-0.5 rounded bg-amber-500/10">
              Fib {fibLabel(bestZone.fibLevel)}
            </span>
            <span className={`text-[11px] font-mono font-bold px-1.5 py-0.5 rounded ${scoreBadgeColor(bestZone.totalScore)}`}>
              Score {bestZone.totalScore}/11
            </span>
            {selectedTF && (
              <span className="text-[10px] font-mono text-muted-foreground">
                via {selectedTF}
              </span>
            )}
          </div>

          {/* Zone price range */}
          <div className="flex items-center gap-2 text-[11px] font-mono">
            <span className="text-muted-foreground">Zone:</span>
            <span className="text-foreground">{fmt(bestZone.low)} – {fmt(bestZone.high)}</span>
            {impulse && (
              <>
                <span className="text-muted-foreground ml-1">Impulse:</span>
                <span className={impulse.direction === "bullish" ? "text-emerald-400" : "text-red-400"}>
                  {impulse.direction === "bullish" ? "↑" : "↓"} {fmt(impulse.low)} – {fmt(impulse.high)}
                </span>
              </>
            )}
          </div>

          {/* Confirmation badges */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
              bestZone.srConfirmed ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-500/10 text-zinc-500"
            }`}>
              S/R {bestZone.srConfirmed ? "✓" : "✗"}
            </span>
            <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
              bestZone.ltfRefined ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-500/10 text-zinc-500"
            }`}>
              LTF {bestZone.ltfRefined ? `✓ ${bestZone.ltfType?.toUpperCase() || ""}` : "✗"}
            </span>
            {bestZone.refinedEntry && (
              <span className={`text-[10px] font-mono ${bestZone.priceAtZone ? "text-amber-300" : "text-muted-foreground"}`}>
                {bestZone.priceAtZone ? "Trigger: " : "Entry: "}{fmt(bestZone.refinedEntry)}
              </span>
            )}
            {bestZone.refinedSL && (
              <span className="text-[10px] font-mono text-muted-foreground">
                SL: {fmt(bestZone.refinedSL)}
              </span>
            )}
            {bestZone.priceAtZone && (
              <span className="text-[10px] font-mono font-bold px-1 py-0.5 rounded bg-amber-500/15 text-amber-300 animate-pulse">
                ⏳ Hunting 5m CHoCH
              </span>
            )}
          </div>

          {/* Price proximity */}
          {!bestZone.priceAtZone && bestZone.distanceToZone > 0 && (
            <p className="text-[10px] text-muted-foreground font-mono">
              Distance to zone: {fmt(bestZone.distanceToZone)} ({allZonesCount} zone{allZonesCount !== 1 ? "s" : ""} total)
            </p>
          )}
        </>
      )}

      {/* Scoring impact indicator */}
      {scoringEnabled && (
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">Scoring:</span>
          <span className={`text-[10px] font-mono font-bold px-1 py-0.5 rounded ${
            hasZone && bestZone?.priceAtZone
              ? "bg-emerald-500/15 text-emerald-300"
              : !hasZone
                ? "bg-red-500/15 text-red-300"
                : "bg-zinc-500/10 text-zinc-400"
          }`}>
            {hasZone && bestZone?.priceAtZone ? "+bonus" : !hasZone ? "−penalty" : "neutral"}
          </span>
        </div>
      )}

      {/* No-zone explanation — show direction engine detail when available */}
      {!hasZone && (
        <div className="space-y-1">
          {directionDetail ? (
            <div className="space-y-0.5">
              {/* Direction engine status badges */}
              <div className="flex items-center gap-1 flex-wrap">
                {directionDetail.bias && (
                  <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
                    directionDetail.bias === "bullish" ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"
                  }`}>
                    {directionDetail.biasSource?.toUpperCase()} {directionDetail.bias === "bullish" ? "↑ BULL" : "↓ BEAR"}
                  </span>
                )}
                {!directionDetail.bias && (
                  <span className="text-[10px] font-mono px-1 py-0.5 rounded bg-zinc-500/15 text-zinc-400">
                    NO BIAS
                  </span>
                )}
                <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
                  directionDetail.h4Retrace ? "bg-amber-500/15 text-amber-300" : "bg-zinc-500/10 text-zinc-500"
                }`}>
                  4H {directionDetail.h4ChochAgainst ? "✗ CHoCH AGAINST" : directionDetail.h4Retrace ? "↩ RETRACE" : "— intact"}
                </span>
                <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
                  directionDetail.h1Confirmed ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-500/10 text-zinc-500"
                }`}>
                  1H {directionDetail.h1Confirmed ? "✓ CONFIRMED" : "✗ waiting"}
                </span>
              </div>
              {/* Full reason text */}
              <p className="text-[10px] text-muted-foreground leading-tight" title={reason}>
                {reason}
              </p>
            </div>
          ) : (
            <p className="text-[10px] text-muted-foreground leading-tight" title={reason}>
              {reason}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default ImpulseZonePanel;
