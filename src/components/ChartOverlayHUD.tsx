/**
 * ChartOverlayHUD — Floating glass panel with overlay toggle chips.
 * 
 * Anchored top-left of the chart area. Each chip toggles an overlay layer
 * on/off. Hover shows a tooltip with the underlying detail. A confluence
 * score pill sits on the right.
 */
import { useState } from 'react';

export type OverlayLayer = 'iz' | 'ob' | 'fvg' | 'sp' | 'liq' | 'fib' | 'sr' | 'bos' | 'disp' | 'judas' | 'sessions' | 'killZones';

export interface OverlayVisibility {
  iz: boolean;
  ob: boolean;
  fvg: boolean;
  sp: boolean;
  liq: boolean;
  fib: boolean;
  sr: boolean;
  bos: boolean;
  disp: boolean;
  judas: boolean;
  sessions: boolean;
  killZones: boolean;
}

interface LayerInfo {
  key: OverlayLayer;
  label: string;
  color: string;
  activeColor: string;
  tooltip: string;
}

const LAYERS: LayerInfo[] = [
  { key: 'iz', label: 'IZ', color: 'border-cyan-500/40 text-cyan-400', activeColor: 'bg-cyan-500/20 border-cyan-400 text-cyan-300', tooltip: 'Impulse Zone — full impulse leg + entry POI' },
  { key: 'ob', label: 'OB', color: 'border-orange-500/40 text-warn', activeColor: 'bg-badge-warn border-orange-400 text-warn', tooltip: 'Order Blocks — institutional supply/demand zones' },
  { key: 'fvg', label: 'FVG', color: 'border-purple-500/40 text-tier3', activeColor: 'bg-purple-500/20 border-purple-400 text-tier3', tooltip: 'Fair Value Gaps — imbalance zones' },
  { key: 'sp', label: 'SP', color: 'border-yellow-500/40 text-highlight', activeColor: 'bg-badge-warn border-yellow-400 text-highlight', tooltip: 'Swing Points — HH/HL/LH/LL structure' },
  { key: 'liq', label: 'LIQ', color: 'border-destructive/40 text-loss', activeColor: 'bg-badge-loss border-red-400 text-loss', tooltip: 'Liquidity Pools — equal highs/lows' },
  { key: 'fib', label: 'FIB', color: 'border-blue-500/40 text-info-c', activeColor: 'bg-badge-info border-blue-400 text-info-c', tooltip: 'Fibonacci Levels — retracement zones' },
  { key: 'sr', label: 'S/R', color: 'border-emerald-500/40 text-profit', activeColor: 'bg-badge-profit border-emerald-400 text-profit', tooltip: 'Support / Resistance levels' },
  { key: 'bos', label: 'BOS', color: 'border-sky-500/40 text-tier2', activeColor: 'bg-sky-500/20 border-sky-400 text-tier2', tooltip: 'BOS/CHoCH — structure break & change of character' },
  { key: 'disp', label: 'DISP', color: 'border-rose-500/40 text-rose-400', activeColor: 'bg-rose-500/20 border-rose-400 text-rose-300', tooltip: 'Displacement Candles — strong momentum candles' },
  { key: 'judas', label: 'JDS', color: 'border-amber-500/40 text-warn', activeColor: 'bg-badge-warn border-amber-400 text-warn', tooltip: 'Judas Swing — false break & reversal' },
  { key: 'sessions', label: 'SES', color: 'border-indigo-500/40 text-indigo-400', activeColor: 'bg-indigo-500/20 border-indigo-400 text-indigo-300', tooltip: 'Session Boxes — Asian/London/NY time windows' },
  { key: 'killZones', label: 'KZ', color: 'border-pink-500/40 text-pink-400', activeColor: 'bg-pink-500/20 border-pink-400 text-pink-300', tooltip: 'Kill Zones — high-probability time windows' },
];

interface ChartOverlayHUDProps {
  visibility: OverlayVisibility;
  onToggle: (layer: OverlayLayer) => void;
  confluenceScore?: number;
  direction?: 'bullish' | 'bearish' | 'neutral';
  /** Extra detail per layer for tooltips */
  layerDetails?: Partial<Record<OverlayLayer, string>>;
}

export function ChartOverlayHUD({ visibility, onToggle, confluenceScore, direction, layerDetails }: ChartOverlayHUDProps) {
  const [hoveredLayer, setHoveredLayer] = useState<OverlayLayer | null>(null);

  const scoreColor = confluenceScore != null
    ? confluenceScore >= 6.5 ? 'text-profit bg-badge-profit border-emerald-500/40'
      : confluenceScore >= 4 ? 'text-warn bg-badge-warn border-amber-500/40'
      : 'text-loss bg-badge-loss border-destructive/40'
    : 'text-muted-foreground bg-muted/30 border-border';

  const dirColor = direction === 'bullish' ? 'text-profit' : direction === 'bearish' ? 'text-loss' : 'text-muted-foreground';

  return (
    <div className="absolute top-3 left-3 z-20 flex items-center gap-1.5 flex-wrap max-w-[calc(100%-6rem)]">
      {/* Glass panel with chips */}
      <div className="flex items-center gap-1 px-2 py-1.5 rounded-md bg-card/70 backdrop-blur-md border border-border/50 shadow-lg flex-wrap">
        {LAYERS.map((layer) => {
          const active = visibility[layer.key];
          const isHovered = hoveredLayer === layer.key;
          return (
            <div key={layer.key} className="relative">
              <button
                onClick={() => onToggle(layer.key)}
                onMouseEnter={() => setHoveredLayer(layer.key)}
                onMouseLeave={() => setHoveredLayer(null)}
                className={`px-1.5 py-0.5 text-[9px] font-bold rounded border transition-all duration-150 ${
                  active ? layer.activeColor : `${layer.color} opacity-40 hover:opacity-70`
                }`}
              >
                {layer.label}
              </button>
              {/* Tooltip */}
              {isHovered && (
                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-2 py-1 rounded bg-popover border border-border shadow-xl text-[9px] text-popover-foreground whitespace-nowrap z-50 pointer-events-none">
                  <p className="font-medium">{layer.tooltip}</p>
                  {layerDetails?.[layer.key] && (
                    <p className="text-muted-foreground mt-0.5">{layerDetails[layer.key]}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Confluence score pill */}
      {confluenceScore != null && (
        <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md border backdrop-blur-md ${scoreColor}`}>
          {direction && direction !== 'neutral' && (
            <span className={`text-[9px] font-bold uppercase ${dirColor}`}>
              {direction === 'bullish' ? '▲' : '▼'}
            </span>
          )}
          <span className="text-[10px] font-mono font-bold">
            {confluenceScore > 10 ? `${confluenceScore.toFixed(0)}%` : `${confluenceScore.toFixed(1)}/10`}
          </span>
        </div>
      )}
    </div>
  );
}

export const DEFAULT_VISIBILITY: OverlayVisibility = {
  iz: true,
  ob: true,
  fvg: true,
  sp: true,
  liq: true,
  fib: true,
  sr: true,
  bos: true,
  disp: true,
  judas: true,
  sessions: true,
  killZones: true,
};
