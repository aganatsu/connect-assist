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
    priceAtZone: boolean;        // Loose (1.5×ATR)
    priceInsideZone?: boolean;   // Strict: literally inside zone bounds
    priceAtZoneStrict?: boolean; // Strict: 0.3×ATR + correct side
    sideOk?: boolean;            // Directional check passed
    distanceToZone: number;
    distancePips?: number;
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
  /** When true, live-action badges ("Hunting 5m CHoCH") are shown.
   *  When false/omitted, only static zone info is rendered (historical context). */
  isLiveContext?: boolean;
}

export function ImpulseZonePanel({ data, isLiveContext = false }: Props) {
  if (!data) return null;

  const { hasZone, selectedTF, reason, impulse, bestZone, allZonesCount, h1HasZone, h4HasZone, scoringEnabled, directionDetail } = data;

  // Color scheme based on zone status
  const borderColor = hasZone
    ? bestZone?.priceAtZone
      ? "border-profit/40"
      : "border-violet-500/30"
    : "border-zinc-500/20";
  const bgColor = hasZone
    ? bestZone?.priceAtZone
      ? "bg-badge-profit"
      : "bg-badge-info"
    : "bg-zinc-500/5";
  const titleColor = hasZone
    ? bestZone?.priceAtZone
      ? "text-profit"
      : "text-tier3"
    : "text-muted-foreground";

  // Format price based on magnitude
  const fmt = (price: number | null | undefined) => {
    if (price == null) return "—";
    return price > 10 ? price.toFixed(3) : price.toFixed(5);
  };

  // Fib level label
  const fibLabel = (level: number) => `${(level * 100).toFixed(1)}%`;

  // Score badge color
  const scoreBadgeColor = (score: number) => {
    if (score >= 5) return "bg-badge-profit text-profit";
    if (score >= 3) return "bg-badge-info text-tier3";
    if (score >= 1) return "bg-badge-warn text-warn";
    return "bg-zinc-500/20 text-muted-foreground";
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
            h1HasZone ? "bg-badge-info text-info-c" : "bg-zinc-500/10 text-muted-foreground"
          }`}>1H{h1HasZone ? " ✓" : ""}</span>
          <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
            h4HasZone ? "bg-purple-500/20 text-tier3" : "bg-zinc-500/10 text-muted-foreground"
          }`}>4H{h4HasZone ? " ✓" : ""}</span>
        </div>
        {/* Status badge */}
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ml-auto ${
          hasZone
            ? bestZone?.priceInsideZone
              ? "bg-badge-profit text-profit"
              : bestZone?.priceAtZoneStrict
                ? "bg-badge-profit text-profit"
                : bestZone?.priceAtZone
                  ? "bg-amber-500/20 text-amber-300"
                  : "bg-badge-info text-tier3"
            : "bg-zinc-500/15 text-muted-foreground"
        }`}>
          {hasZone ? (bestZone?.priceInsideZone ? "AT ZONE" : bestZone?.priceAtZoneStrict ? "NEAR ZONE" : bestZone?.priceAtZone ? "NEAR (LOOSE)" : "ZONE FOUND") : "NO ZONE"}
        </span>
      </div>

      {/* Zone details — only show when zone exists */}
      {hasZone && bestZone && (
        <>
          {/* Zone type + Fib + Score row */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded ${
              bestZone.type === "ob" ? "bg-badge-warn text-warn" : "bg-cyan-500/15 text-cyan-300"
            }`}>
              {bestZone.type.toUpperCase()}
            </span>
            <span className="text-[11px] font-mono text-warn px-1 py-0.5 rounded bg-badge-warn">
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
                <span className={impulse.direction === "bullish" ? "text-profit" : "text-loss"}>
                  {impulse.direction === "bullish" ? "↑" : "↓"} {fmt(impulse.low)} – {fmt(impulse.high)}
                </span>
              </>
            )}
          </div>

          {/* Confirmation badges */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
              bestZone.srConfirmed ? "bg-badge-profit text-profit" : "bg-zinc-500/10 text-muted-foreground"
            }`}>
              S/R {bestZone.srConfirmed ? "✓" : "✗"}
            </span>
            <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
              bestZone.ltfRefined ? "bg-badge-profit text-profit" : "bg-zinc-500/10 text-muted-foreground"
            }`}>
              LTF {bestZone.ltfRefined ? `✓ ${bestZone.ltfType?.toUpperCase() || ""}` : "✗"}
            </span>
            {bestZone.refinedEntry && (
              <span className={`text-[10px] font-mono ${bestZone.priceAtZone ? "text-warn" : "text-muted-foreground"}`}>
                {bestZone.priceAtZone ? "Trigger: " : "Entry: "}{fmt(bestZone.refinedEntry)}
              </span>
            )}
            {bestZone.refinedSL && (
              <span className="text-[10px] font-mono text-muted-foreground">
                SL: {fmt(bestZone.refinedSL)}
              </span>
            )}
            {isLiveContext && (bestZone.priceInsideZone || bestZone.priceAtZoneStrict) && (
              <span className="text-[10px] font-mono font-bold px-1 py-0.5 rounded bg-badge-warn text-warn animate-pulse">
                ⏳ Hunting 5m CHoCH
              </span>
            )}
            {bestZone.priceAtZone && !bestZone.priceAtZoneStrict && !bestZone.priceInsideZone && (
              <span className="text-[10px] font-mono px-1 py-0.5 rounded bg-amber-500/10 text-amber-300">
                ⚠️ {bestZone.distancePips?.toFixed(0) ?? "?"}p away{!bestZone.sideOk ? " (wrong side)" : ""}
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
              ? "bg-badge-profit text-profit"
              : !hasZone
                ? "bg-badge-loss text-loss"
                : "bg-zinc-500/10 text-muted-foreground"
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
                    directionDetail.bias === "bullish" ? "bg-badge-profit text-profit" : "bg-badge-loss text-loss"
                  }`}>
                    {directionDetail.biasSource?.toUpperCase()} {directionDetail.bias === "bullish" ? "↑ BULL" : "↓ BEAR"}
                  </span>
                )}
                {!directionDetail.bias && (
                  <span className="text-[10px] font-mono px-1 py-0.5 rounded bg-zinc-500/15 text-muted-foreground">
                    NO BIAS
                  </span>
                )}
                <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
                  directionDetail.h4Retrace ? "bg-badge-warn text-warn" : "bg-zinc-500/10 text-muted-foreground"
                }`}>
                  4H {directionDetail.h4ChochAgainst ? "✗ CHoCH AGAINST" : directionDetail.h4Retrace ? "↩ RETRACE" : "— intact"}
                </span>
                <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
                  directionDetail.h1Confirmed ? "bg-badge-profit text-profit" : "bg-zinc-500/10 text-muted-foreground"
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
