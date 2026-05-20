/**
 * ChartContextPanel — Right-side sticky panel showing actionable SMC analysis.
 * 
 * Sections:
 * 1. Bias header (direction + score)
 * 2. Top 3 confluence factors
 * 3. Nearest levels (OB, FVG, Liquidity)
 * 4. Impulse Zone (from bot scan)
 * 5. Session & timing
 * 6. Suggested trade (entry/SL/TP from analysis)
 */
import { TrendingUp, TrendingDown, Minus, Clock, Zap, Target, Radio, ChevronDown, X } from 'lucide-react';
import { getCurrentSession, isInKillzone } from '@/lib/marketData';
import type { UnifiedConfluence, FactorItem } from '@/lib/confluenceUnify';

const fx = (n: unknown, digits = 5) =>
  typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : '—';

interface ChartContextPanelProps {
  analysis: any;
  unified: UnifiedConfluence | null;
  botScanSignal: { signal: any; scannedAt: string } | null;
  currentPrice?: number;
  onClose?: () => void;
  className?: string;
}

export function ChartContextPanel({ analysis, unified, botScanSignal, currentPrice, onClose, className = '' }: ChartContextPanelProps) {
  const session = getCurrentSession();
  const kz = isInKillzone();
  const sig = botScanSignal?.signal;

  if (!analysis && !sig) {
    return (
      <div className={`flex items-center justify-center h-full text-muted-foreground text-xs ${className}`}>
        <p>Waiting for analysis...</p>
      </div>
    );
  }

  // Bias
  const direction = unified?.direction ?? 'NEUTRAL';
  const score = unified?.total ?? 0;
  const isPercentage = score > 10;

  // Top factors (sorted by weight, only passing ones)
  const topFactors: FactorItem[] = [];
  if (unified?.groups) {
    for (const g of unified.groups) {
      for (const item of g.items) {
        if (item.pass) topFactors.push(item);
      }
    }
  }
  topFactors.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  const top3 = topFactors.slice(0, 3);

  // Nearest levels
  const activeOBs = (analysis?.orderBlocks || []).filter((ob: any) => !ob.mitigated);
  const activeFVGs = (analysis?.fvgs || []).filter((f: any) => !f.mitigated);
  const liquidityPools = analysis?.liquidityPools || [];

  const nearestOB = activeOBs.length > 0 ? activeOBs.reduce((closest: any, ob: any) => {
    if (!currentPrice) return closest;
    const mid = (ob.high + ob.low) / 2;
    const dist = Math.abs(currentPrice - mid);
    const closestDist = closest ? Math.abs(currentPrice - (closest.high + closest.low) / 2) : Infinity;
    return dist < closestDist ? ob : closest;
  }, null) : null;

  const nearestFVG = activeFVGs.length > 0 ? activeFVGs.reduce((closest: any, fvg: any) => {
    if (!currentPrice) return closest;
    const mid = (fvg.high + fvg.low) / 2;
    const dist = Math.abs(currentPrice - mid);
    const closestDist = closest ? Math.abs(currentPrice - (closest.high + closest.low) / 2) : Infinity;
    return dist < closestDist ? fvg : closest;
  }, null) : null;

  const nearestLiq = liquidityPools.length > 0 ? liquidityPools.reduce((closest: any, lp: any) => {
    if (!currentPrice) return closest;
    const dist = Math.abs(currentPrice - lp.price);
    const closestDist = closest ? Math.abs(currentPrice - closest.price) : Infinity;
    return dist < closestDist ? lp : closest;
  }, null) : null;

  // Impulse zone from bot scan
  const iz = sig?.impulseZone;
  const hasIZ = iz?.hasZone && iz?.impulse;

  // Suggested trade from bot scan
  const hasTrade = sig?.direction && sig?.entry;

  return (
    <div className={`flex flex-col gap-0 overflow-y-auto text-[11px] ${className}`}>
      {/* Close button (mobile) */}
      {onClose && (
        <button onClick={onClose} className="absolute top-2 right-2 text-muted-foreground hover:text-foreground lg:hidden z-10">
          <X className="h-4 w-4" />
        </button>
      )}

      {/* ─── 1. Bias Header ─── */}
      <div className="px-3 py-3 border-b border-border/50">
        <div className="flex items-center gap-2">
          {direction === 'BUY' ? (
            <TrendingUp className="h-5 w-5 text-emerald-400" />
          ) : direction === 'SELL' ? (
            <TrendingDown className="h-5 w-5 text-red-400" />
          ) : (
            <Minus className="h-5 w-5 text-muted-foreground" />
          )}
          <div>
            <p className={`text-sm font-bold ${
              direction === 'BUY' ? 'text-emerald-400' : direction === 'SELL' ? 'text-red-400' : 'text-muted-foreground'
            }`}>
              {direction === 'BUY' ? 'BULLISH' : direction === 'SELL' ? 'BEARISH' : 'NEUTRAL'}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {isPercentage ? `${score.toFixed(1)}%` : `${score.toFixed(1)} / 10`}
              {unified && ` · ${unified.passCount}/${unified.totalFactors} factors`}
            </p>
          </div>
        </div>
      </div>

      {/* ─── 2. Top Confluence Factors ─── */}
      {top3.length > 0 && (
        <div className="px-3 py-2.5 border-b border-border/50">
          <p className="text-[9px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Top Factors</p>
          <div className="space-y-1">
            {top3.map((f, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <span className="text-emerald-400 text-[10px] mt-0.5">✓</span>
                <div className="flex-1 min-w-0">
                  <span className="text-foreground font-medium text-[10px]">{f.label}</span>
                  {f.weight != null && (
                    <span className="ml-1 text-[8px] text-muted-foreground font-mono">({f.weight.toFixed(2)})</span>
                  )}
                  {f.detail && <p className="text-[9px] text-muted-foreground truncate">{f.detail}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── 3. Nearest Levels ─── */}
      <div className="px-3 py-2.5 border-b border-border/50">
        <p className="text-[9px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Nearest Levels</p>
        <div className="space-y-1.5">
          {/* Nearest OB */}
          <div className="flex items-center justify-between">
            <span className="text-orange-400 font-medium">OB</span>
            {nearestOB ? (
              <span className="font-mono text-[10px]">
                {nearestOB.type === 'bullish' ? '🟢' : '🔴'} {fx(nearestOB.high)} – {fx(nearestOB.low)}
                {currentPrice && (
                  <span className="text-muted-foreground ml-1">
                    ({Math.abs(currentPrice - (nearestOB.high + nearestOB.low) / 2).toFixed(5)} away)
                  </span>
                )}
              </span>
            ) : (
              <span className="text-muted-foreground">none active</span>
            )}
          </div>
          {/* Nearest FVG */}
          <div className="flex items-center justify-between">
            <span className="text-purple-400 font-medium">FVG</span>
            {nearestFVG ? (
              <span className="font-mono text-[10px]">
                {nearestFVG.type === 'bullish' ? '🟢' : '🔴'} {fx(nearestFVG.high)} – {fx(nearestFVG.low)}
                {nearestFVG.mitigationPercent != null && (
                  <span className="text-muted-foreground ml-1">{nearestFVG.mitigationPercent.toFixed(0)}% filled</span>
                )}
              </span>
            ) : (
              <span className="text-muted-foreground">none active</span>
            )}
          </div>
          {/* Nearest Liquidity */}
          <div className="flex items-center justify-between">
            <span className="text-red-400 font-medium">LIQ</span>
            {nearestLiq ? (
              <span className="font-mono text-[10px]">
                {nearestLiq.type === 'high' ? '↑' : '↓'} {fx(nearestLiq.price)}
                {nearestLiq.swept && <span className="text-amber-400 ml-1">swept</span>}
              </span>
            ) : (
              <span className="text-muted-foreground">none detected</span>
            )}
          </div>
        </div>
      </div>

      {/* ─── 4. Impulse Zone ─── */}
      {hasIZ && (
        <div className="px-3 py-2.5 border-b border-border/50">
          <p className="text-[9px] uppercase tracking-wider font-bold text-cyan-400 mb-1.5">
            ⚡ Impulse Zone ({iz.selectedTF || '—'})
          </p>
          <div className="space-y-1 bg-cyan-500/5 border border-cyan-500/20 rounded p-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Impulse</span>
              <span className="font-mono">{fx(iz.impulse.high)} – {fx(iz.impulse.low)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Direction</span>
              <span className={iz.impulse.direction === 'bullish' ? 'text-emerald-400' : 'text-red-400'}>
                {iz.impulse.direction}
              </span>
            </div>
            {iz.bestZone && (
              <>
                <div className="border-t border-cyan-500/20 my-1" />
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Entry Zone</span>
                  <span className="font-mono text-cyan-300">{fx(iz.bestZone.high)} – {fx(iz.bestZone.low)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Type</span>
                  <span className="uppercase text-[9px] font-bold">{iz.bestZone.type}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Fib Depth</span>
                  <span className="font-mono">{(iz.bestZone.fibDepth * 100).toFixed(0)}%</span>
                </div>
                {iz.bestZone.priceAtZone && (
                  <p className="text-[9px] text-cyan-300 font-bold mt-1">⚡ PRICE AT ZONE</p>
                )}
                {!iz.bestZone.priceAtZone && iz.bestZone.distanceToZone != null && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Distance</span>
                    <span className="font-mono">{iz.bestZone.distanceToZone.toFixed(5)}</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ─── 5. Session & Timing ─── */}
      <div className="px-3 py-2.5 border-b border-border/50">
        <p className="text-[9px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Session</p>
        <div className="flex items-center gap-2">
          <Clock className="h-3 w-3 text-muted-foreground" />
          <span className="font-medium">{session}</span>
          {kz.active && (
            <span className="text-[9px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded">
              ⚡ {kz.name}
            </span>
          )}
        </div>
        {sig?.extendedFactors?.silverBullet && (
          <p className="text-[9px] text-primary mt-1">Silver Bullet window active</p>
        )}
        {sig?.extendedFactors?.macroTime && (
          <p className="text-[9px] text-amber-400 mt-0.5">Macro time flag</p>
        )}
      </div>

      {/* ─── 6. Suggested Trade ─── */}
      {hasTrade && (
        <div className="px-3 py-2.5">
          <p className="text-[9px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">
            Bot Suggestion
            <span className="text-[8px] text-muted-foreground/60 normal-case ml-1">(gates may differ)</span>
          </p>
          <div className={`rounded p-2 border ${
            sig.direction === 'long' ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-red-500/5 border-red-500/20'
          }`}>
            <div className="flex items-center gap-2 mb-1.5">
              {sig.direction === 'long' ? (
                <TrendingUp className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <TrendingDown className="h-3.5 w-3.5 text-red-400" />
              )}
              <span className={`font-bold text-xs ${sig.direction === 'long' ? 'text-emerald-400' : 'text-red-400'}`}>
                {sig.direction.toUpperCase()}
              </span>
              {sig.score != null && (
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {Number(sig.score) > 10 ? `${Number(sig.score).toFixed(0)}%` : `${Number(sig.score).toFixed(1)}/10`}
                </span>
              )}
            </div>
            <div className="space-y-0.5 font-mono text-[10px]">
              {sig.entry && <div className="flex justify-between"><span className="text-muted-foreground">Entry</span><span>{fx(sig.entry)}</span></div>}
              {sig.sl && <div className="flex justify-between"><span className="text-red-400">SL</span><span>{fx(sig.sl)}</span></div>}
              {sig.tp && <div className="flex justify-between"><span className="text-emerald-400">TP</span><span>{fx(sig.tp)}</span></div>}
              {sig.rr && <div className="flex justify-between"><span className="text-muted-foreground">R:R</span><span className="text-primary font-bold">1:{sig.rr.toFixed(1)}</span></div>}
            </div>
            {sig.status === 'trade_placed' && (
              <p className="text-[9px] text-emerald-400 font-bold mt-1.5">✓ Trade was placed</p>
            )}
            {sig.status === 'rejected' && sig.rejectionReasons?.length > 0 && (
              <div className="mt-1.5">
                <p className="text-[8px] text-red-400 font-bold">Rejected:</p>
                {sig.rejectionReasons.slice(0, 2).map((r: string, i: number) => (
                  <p key={i} className="text-[9px] text-red-300">⚠ {r}</p>
                ))}
              </div>
            )}
          </div>
          {botScanSignal?.scannedAt && (
            <p className="text-[8px] text-muted-foreground/60 mt-1">
              Scanned: {new Date(botScanSignal.scannedAt).toLocaleTimeString()}
            </p>
          )}
        </div>
      )}

      {/* No bot signal fallback */}
      {!sig && (
        <div className="px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Radio className="h-3 w-3" />
            <span className="text-[10px]">No recent bot scan — check back soon</span>
          </div>
        </div>
      )}
    </div>
  );
}
