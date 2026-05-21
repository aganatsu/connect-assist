/**
 * ChartOverlayHUD — Floating glass panel with overlay toggle chips.
 * 
 * Anchored top-left of the chart area. Each chip toggles an overlay layer
 * on/off. Hover shows a tooltip with the underlying detail. A confluence
 * score pill sits on the right.
 */
import { useState } from 'react';

export type OverlayLayer = 'iz' | 'ob' | 'fvg' | 'sp' | 'liq' | 'fib' | 'sr';

export interface OverlayVisibility {
  iz: boolean;
  ob: boolean;
  fvg: boolean;
  sp: boolean;
  liq: boolean;
  fib: boolean;
  sr: boolean;
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
  { key: 'ob', label: 'OB', color: 'border-orange-500/40 text-orange-400', activeColor: 'bg-orange-500/20 border-orange-400 text-orange-300', tooltip: 'Order Blocks — institutional supply/demand zones' },
  { key: 'fvg', label: 'FVG', color: 'border-purple-500/40 text-purple-400', activeColor: 'bg-purple-500/20 border-purple-400 text-purple-300', tooltip: 'Fair Value Gaps — imbalance zones' },
  { key: 'sp', label: 'SP', color: 'border-yellow-500/40 text-yellow-400', activeColor: 'bg-yellow-500/20 border-yellow-400 text-yellow-300', tooltip: 'Swing Points — HH/HL/LH/LL structure' },
  { key: 'liq', label: 'LIQ', color: 'border-red-500/40 text-red-400', activeColor: 'bg-red-500/20 border-red-400 text-red-300', tooltip: 'Liquidity Pools — equal highs/lows' },
  { key: 'fib', label: 'FIB', color: 'border-blue-500/40 text-blue-400', activeColor: 'bg-blue-500/20 border-blue-400 text-blue-300', tooltip: 'Fibonacci Levels — retracement zones' },
  { key: 'sr', label: 'S/R', color: 'border-emerald-500/40 text-emerald-400', activeColor: 'bg-emerald-500/20 border-emerald-400 text-emerald-300', tooltip: 'Support / Resistance levels' },
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
    ? confluenceScore >= 6.5 ? 'text-emerald-400 bg-emerald-500/15 border-emerald-500/40'
      : confluenceScore >= 4 ? 'text-amber-400 bg-amber-500/15 border-amber-500/40'
      : 'text-red-400 bg-red-500/15 border-red-500/40'
    : 'text-muted-foreground bg-muted/30 border-border';

  const dirColor = direction === 'bullish' ? 'text-emerald-400' : direction === 'bearish' ? 'text-red-400' : 'text-muted-foreground';

  return (
    <div className="absolute top-3 left-3 z-20 flex items-center gap-1.5">
      {/* Glass panel with chips */}
      <div className="flex items-center gap-1 px-2 py-1.5 rounded-md bg-card/70 backdrop-blur-md border border-border/50 shadow-lg">
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
};
