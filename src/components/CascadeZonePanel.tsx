/**
 * CascadeZonePanel — Displays the top-down cascade zone state in the scan detail panel.
 * Shows the story: Daily impulse leg → Daily zone → 4H confirmation → 1H entry → 15m refinement.
 *
 * Expects `cascadeZone` data from the scan detail object (detail.cascadeZone).
 */

interface CascadeZoneData {
  state: string;
  reason: string;
  dailyImpulse: {
    direction: "bullish" | "bearish";
    high: number;
    low: number;
    bosPrice: number;
    startDate: string | null;
    endDate: string | null;
    spanBars: number;
  } | null;
  dailyZone: {
    type: "ob" | "fvg";
    high: number;
    low: number;
    fibLevel: number;
    srConfirmed: boolean;
  } | null;
  dailyZoneDistance: number;
  confirmation: {
    type: "displacement" | "choch_1h";
    direction: "bullish" | "bearish";
    insideDailyZone: boolean;
  } | null;
  entryZone: {
    type: "ob" | "fvg";
    high: number;
    low: number;
    fibLevel: number;
    totalScore: number;
    ltfRefined: boolean;
  } | null;
  entry: number | null;
  sl: number | null;
  priceAtEntry: boolean;
  distancePips: number;
}

interface Props {
  data: CascadeZoneData | null | undefined;
}

const STATE_COLORS: Record<string, string> = {
  triggered: "text-green-400",
  ready: "text-blue-400",
  confirmed: "text-cyan-400",
  at_daily_zone: "text-yellow-400",
  waiting_for_price: "text-orange-400",
  no_confirmation: "text-orange-300",
  no_entry_zone: "text-orange-300",
  no_daily_impulse: "text-zinc-500",
  no_daily_zone: "text-zinc-500",
  off: "text-zinc-600",
  error: "text-red-400",
};

const STATE_LABELS: Record<string, string> = {
  triggered: "⚡ TRIGGERED",
  ready: "🎯 Ready (limit order)",
  confirmed: "✓ Confirmed",
  at_daily_zone: "📍 At Daily Zone",
  waiting_for_price: "⏳ Waiting for Price",
  no_confirmation: "🔍 No Confirmation Yet",
  no_entry_zone: "🔍 No 1H Entry Zone",
  no_daily_impulse: "— No Daily Impulse",
  no_daily_zone: "— No Daily Zone",
  off: "OFF",
  error: "⚠ Error",
};

export function CascadeZonePanel({ data }: Props) {
  if (!data || data.state === "off") return null;

  const stateColor = STATE_COLORS[data.state] ?? "text-zinc-400";
  const stateLabel = STATE_LABELS[data.state] ?? data.state;

  // Calculate impulse range in pips for display
  const impulsePips = data.dailyImpulse
    ? Math.abs(data.dailyImpulse.high - data.dailyImpulse.low) *
      (data.dailyImpulse.high > 50 ? 100 : 10000) // JPY pairs vs standard
    : 0;

  return (
    <div className="mt-3 p-3 rounded-lg bg-zinc-900/60 border border-zinc-800">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Cascade Zone (D→4H→1H→15m)</span>
        <span className={`text-xs font-bold ${stateColor}`}>{stateLabel}</span>
      </div>

      {/* Story progression */}
      <div className="space-y-1.5 text-[11px]">
        {/* Daily Impulse Leg */}
        <div className="flex items-start gap-2">
          <span className={data.dailyImpulse ? "text-green-400 mt-0.5" : "text-zinc-600 mt-0.5"}>
            {data.dailyImpulse ? "●" : "○"}
          </span>
          <div>
            <span className="text-zinc-400">Daily Impulse:</span>
            {data.dailyImpulse ? (
              <div className="text-zinc-200 mt-0.5">
                <span className={data.dailyImpulse.direction === "bullish" ? "text-green-400" : "text-red-400"}>
                  {data.dailyImpulse.direction === "bullish" ? "↑" : "↓"} {data.dailyImpulse.direction.toUpperCase()}
                </span>
                <span className="text-zinc-400 ml-2">
                  {data.dailyImpulse.low.toFixed(5)} → {data.dailyImpulse.high.toFixed(5)}
                </span>
                <span className="text-cyan-400 ml-2">({impulsePips.toFixed(0)} pips)</span>
                <div className="text-zinc-500 mt-0.5">
                  BOS: {data.dailyImpulse.bosPrice.toFixed(5)}
                  {data.dailyImpulse.startDate && data.dailyImpulse.endDate && (
                    <span className="ml-2">
                      {data.dailyImpulse.startDate} → {data.dailyImpulse.endDate}
                      <span className="text-zinc-600 ml-1">({data.dailyImpulse.spanBars} bars)</span>
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <span className="text-zinc-600 ml-1">None found</span>
            )}
          </div>
        </div>

        {/* Daily Zone */}
        <div className="flex items-center gap-2">
          <span className={data.dailyZone ? "text-green-400" : "text-zinc-600"}>
            {data.dailyZone ? "●" : "○"}
          </span>
          <span className="text-zinc-400">Daily Zone:</span>
          {data.dailyZone ? (
            <span className="text-zinc-200">
              {data.dailyZone.type.toUpperCase()} @ Fib {(data.dailyZone.fibLevel * 100).toFixed(1)}%
              {data.dailyZone.srConfirmed && <span className="text-green-400 ml-1">(S/R ✓)</span>}
              <span className="text-zinc-500 ml-1">[{data.dailyZone.low.toFixed(5)}–{data.dailyZone.high.toFixed(5)}]</span>
            </span>
          ) : (
            <span className="text-zinc-600">None found</span>
          )}
        </div>

        {/* Price proximity */}
        {data.dailyZone && (
          <div className="flex items-center gap-2 ml-4">
            <span className={data.dailyZoneDistance === 0 ? "text-green-400" : "text-orange-400"}>
              {data.dailyZoneDistance === 0 ? "●" : "○"}
            </span>
            <span className="text-zinc-400">Price:</span>
            <span className="text-zinc-200">
              {data.dailyZoneDistance === 0 ? "At zone" : `${data.dailyZoneDistance.toFixed(1)} pips away`}
            </span>
          </div>
        )}

        {/* 4H Confirmation */}
        <div className="flex items-center gap-2">
          <span className={data.confirmation ? "text-green-400" : "text-zinc-600"}>
            {data.confirmation ? "●" : "○"}
          </span>
          <span className="text-zinc-400">Confirmation:</span>
          {data.confirmation ? (
            <span className="text-zinc-200">
              {data.confirmation.type === "displacement" ? "4H Displacement" : "1H CHoCH"} ({data.confirmation.direction})
              {data.confirmation.insideDailyZone && <span className="text-green-400 ml-1">inside zone</span>}
            </span>
          ) : (
            <span className="text-zinc-600">Waiting for 4H displacement or 1H CHoCH</span>
          )}
        </div>

        {/* 1H Entry Zone */}
        <div className="flex items-center gap-2">
          <span className={data.entryZone ? "text-green-400" : "text-zinc-600"}>
            {data.entryZone ? "●" : "○"}
          </span>
          <span className="text-zinc-400">Entry Zone:</span>
          {data.entryZone ? (
            <span className="text-zinc-200">
              1H {data.entryZone.type.toUpperCase()} @ Fib {(data.entryZone.fibLevel * 100).toFixed(1)}%
              <span className="text-cyan-400 ml-1">(score: {data.entryZone.totalScore.toFixed(1)}/9)</span>
              {data.entryZone.ltfRefined && <span className="text-purple-400 ml-1">15m refined</span>}
            </span>
          ) : (
            <span className="text-zinc-600">Not yet</span>
          )}
        </div>

        {/* Entry details */}
        {data.entry && (
          <div className="flex items-center gap-2 ml-4">
            <span className={data.priceAtEntry ? "text-green-400" : "text-blue-400"}>
              {data.priceAtEntry ? "●" : "○"}
            </span>
            <span className="text-zinc-400">Entry:</span>
            <span className="text-zinc-200 font-mono">
              {data.entry.toFixed(5)}
              {data.sl && <span className="text-red-400 ml-2">SL: {data.sl.toFixed(5)}</span>}
              {!data.priceAtEntry && data.distancePips > 0 && (
                <span className="text-orange-400 ml-2">({data.distancePips.toFixed(1)} pips away)</span>
              )}
            </span>
          </div>
        )}
      </div>

      {/* Reason */}
      <p className="text-[10px] text-zinc-500 mt-2 leading-relaxed">{data.reason}</p>
    </div>
  );
}
