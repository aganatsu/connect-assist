import React, { useState } from "react";
import { TierFactorBreakdown, TierScoreSummary, type TieredScoringMeta } from "./TierFactorBreakdown";

// ─── Types ──────────────────────────────────────────────────────────

interface SignalReasoningCardProps {
  signalReason: string;
  compact?: boolean;
}

interface ParsedSummary {
  direction: "BUY" | "SELL" | null;
  factorCount: number | null;
  total: number | null;
  score: number | null;
  alignedFactors: string[];
  extraContext: string[];
}

/** Shape of each factor saved in signal_reason.factorScores */
interface FactorScore {
  name: string;
  present: boolean;
  weight: number;
  detail?: string;
  group?: string;
  tier?: number;
}

// ─── Summary text parser ────────────────────────────────────────────

function parseSummary(summary: string): ParsedSummary {
  const result: ParsedSummary = {
    direction: null,
    factorCount: null,
    total: null,
    score: null,
    alignedFactors: [],
    extraContext: [],
  };
  if (!summary) return result;

  const dirMatch = summary.match(/^(BUY|SELL)/i);
  if (dirMatch) result.direction = dirMatch[1].toUpperCase() as "BUY" | "SELL";

  const factorMatch = summary.match(/(\d+)\/(\d+)\s+factors/i);
  if (factorMatch) {
    result.factorCount = parseInt(factorMatch[1], 10);
    result.total = parseInt(factorMatch[2], 10);
  }

  // Try percentage format first (new), then legacy /10 format
  const pctMatch = summary.match(/score:\s*([\d.]+)%/i);
  if (pctMatch) {
    result.score = parseFloat(pctMatch[1]);
  } else {
    const scoreMatch = summary.match(/score:\s*([\d.]+)\/10/i);
    if (scoreMatch) result.score = parseFloat(scoreMatch[1]);
  }

  // Split off after first ". " — that's where factor list starts
  const afterPeriod = summary.split(/\.\s+/).slice(1).join(". ");
  if (afterPeriod) {
    const segments = afterPeriod.split(/\s*\|\s*/);
    const factorSeg = segments[0] || "";
    result.alignedFactors = factorSeg
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s !== "...");
    result.extraContext = segments.slice(1).map((s) => s.trim()).filter(Boolean);
  }

  return result;
}

// ─── Main Component ─────────────────────────────────────────────────

export function SignalReasoningCard({ signalReason, compact = false }: SignalReasoningCardProps) {
  if (!signalReason) {
    return <span className="text-[10px] text-muted-foreground">—</span>;
  }

  let parsed: any = null;
  let summaryText = signalReason;
  try {
    const obj = JSON.parse(signalReason);
    if (obj && typeof obj === "object") {
      parsed = obj;
      summaryText = typeof obj.summary === "string" ? obj.summary : signalReason;
    }
  } catch {
    // not JSON — treat whole string as summary
  }

  const s = parseSummary(summaryText);

  // Fallback: nothing parseable
  if (!s.direction && !s.factorCount && !s.score) {
    if (compact) {
      return (
        <span className="text-[10px] text-muted-foreground font-mono truncate inline-block max-w-full">
          {signalReason}
        </span>
      );
    }
    return (
      <p className="text-[10px] text-muted-foreground font-mono whitespace-pre-wrap break-words">
        {signalReason}
      </p>
    );
  }

  const dirColor = s.direction === "BUY" ? "text-success" : s.direction === "SELL" ? "text-destructive" : "text-foreground";
  const dirBg =
    s.direction === "BUY"
      ? "bg-success/15 border-success/40 text-success"
      : s.direction === "SELL"
        ? "bg-destructive/15 border-destructive/40 text-destructive"
        : "bg-secondary border-border text-foreground";

  if (compact) {
    return (
      <span className={`text-[10px] font-mono ${dirColor}`}>
        {s.direction ?? "—"}
        {s.factorCount !== null ? ` · ${s.factorCount} factors` : ""}
        {s.score !== null ? ` (${s.score > 10 ? `${s.score.toFixed(1)}%` : s.score})` : ""}
      </span>
    );
  }

  // Check for factor data
  const factorScores: FactorScore[] | null =
    Array.isArray(parsed?.factorScores) && parsed.factorScores.length > 0
      ? parsed.factorScores
      : null;

  // Extract tieredScoring metadata if available
  const tieredScoring: TieredScoringMeta | null = parsed?.tieredScoring ?? null;

  const setupType: string | null = parsed?.setupType ?? null;
  const setupConfidence: number | null = parsed?.setupConfidence ?? null;
  const setupRationale: string | null = parsed?.setupRationale ?? null;
  const exitFlags = parsed?.exitFlags ?? null;
  const spreadFilter = parsed?.spreadFilter ?? null;
  const newsFilter = parsed?.newsFilter ?? null;

  // ── Zone Qualifiers (from impulseZoneEngine result) ──
  const bestZone = parsed?.impulseZone?.bestZone?.zone ?? null;
  const zoneQualifiers: { label: string; tone: "deep" | "origin" | "info" }[] = [];
  if (bestZone) {
    const fibLevel: number | undefined = bestZone.fibLevel;
    const fibDepth: number | undefined = bestZone.fibDepth;
    const poiType: string | undefined = bestZone.poi?.type;
    const isOriginOB: boolean = !!bestZone.poi?.isOriginOB;
    if (isOriginOB) zoneQualifiers.push({ label: "Origin OB Re-test", tone: "origin" });
    if (typeof fibLevel === "number") {
      const pct = (fibLevel * 100).toFixed(1).replace(/\.0$/, "");
      const deep = fibLevel >= 0.786;
      zoneQualifiers.push({
        label: `Zone Depth ${pct}%${deep ? " · deep" : ""}`,
        tone: deep ? "deep" : "info",
      });
    } else if (typeof fibDepth === "number") {
      zoneQualifiers.push({ label: `Fib depth ${(fibDepth * 100).toFixed(0)}%`, tone: "info" });
    }
    if (poiType) zoneQualifiers.push({ label: `POI: ${poiType.toUpperCase()}`, tone: "info" });
  }

  const qualifierClass = (tone: "deep" | "origin" | "info") =>
    tone === "origin"
      ? "bg-primary/15 border-primary/40 text-primary"
      : tone === "deep"
        ? "bg-warning/15 border-warning/40 text-warning"
        : "bg-secondary/60 border-border text-foreground";

  const exitRows: { label: string; value: string }[] = [];
  if (exitFlags) {
    if (exitFlags.trailingStopPips != null) {
      exitRows.push({
        label: "Trailing Stop",
        value: `${exitFlags.trailingStopPips} pips${exitFlags.trailingStopActivation ? ` (${exitFlags.trailingStopActivation})` : ""}`,
      });
    }
    if (exitFlags.breakEvenPips != null) {
      exitRows.push({ label: "Break Even", value: `${exitFlags.breakEvenPips} pips` });
    }
    if (exitFlags.partialTPPercent != null || exitFlags.partialTPLevel != null) {
      const pct = exitFlags.partialTPPercent ?? "—";
      const lvl = exitFlags.partialTPLevel != null ? `${exitFlags.partialTPLevel}R` : "—";
      exitRows.push({ label: "Partial TP", value: `${pct}% @ ${lvl}` });
    }
    if (exitFlags.tpRatio != null) {
      exitRows.push({ label: "TP Ratio", value: `${exitFlags.tpRatio}` });
    }
    if (exitFlags.maxHoldHours != null) {
      exitRows.push({ label: "Max Hold", value: `${exitFlags.maxHoldHours}h` });
    }
  }

  return (
    <div className="space-y-2 text-[10px]">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        {s.direction && (
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-bold tracking-wider ${dirBg}`}>
            {s.direction}
          </span>
        )}
        {s.score !== null && (
          <span className={`font-mono font-bold text-[11px] ${dirColor}`}>{s.score > 10 ? `${s.score.toFixed(1)}%` : `${s.score}/10`}</span>
        )}
        {s.factorCount !== null && s.total !== null && (
          <span className="text-[9px] text-muted-foreground font-mono">
            {s.factorCount} factors aligned{s.total ? ` (of ${s.total})` : ""}
          </span>
        )}
        {tieredScoring && <TierScoreSummary tieredScoring={tieredScoring} />}
      </div>

      {/* ── Tier-Grouped Factor Breakdown ── */}
      {factorScores && factorScores.length > 0 ? (
        <TierFactorBreakdown factors={factorScores} tieredScoring={tieredScoring} />
      ) : (
        /* ── LEGACY: Aligned factor chips from summary text ── */
        s.alignedFactors.length > 0 && (
          <div>
            <p className="text-[8px] text-muted-foreground uppercase tracking-wider mb-1 font-bold">Aligned Factors</p>
            <div className="flex flex-wrap gap-1">
              {s.alignedFactors.map((f, i) => (
                <span
                  key={i}
                  className="rounded-full bg-secondary/60 border border-border px-1.5 py-0.5 text-[9px] text-foreground"
                >
                  {f}
                </span>
              ))}
            </div>
          </div>
        )
      )}

      {/* Extra context */}
      {s.extraContext.length > 0 && (
        <div>
          <p className="text-[8px] text-muted-foreground uppercase tracking-wider mb-1 font-bold">Context</p>
          <div className="flex flex-wrap gap-1">
            {s.extraContext.map((c, i) => (
              <span
                key={i}
                className="rounded bg-muted/40 border border-border/60 px-1.5 py-0.5 text-[9px] font-mono text-muted-foreground"
              >
                {c}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* SMC Enhancement Factors (from smcEnhancements module) */}
      {parsed?.smcEnhancementFactors && parsed.smcEnhancementFactors.length > 0 && (
        <div>
          <p className="text-[8px] text-muted-foreground uppercase tracking-wider mb-1 font-bold">SMC Enhancements</p>
          <div className="flex flex-wrap gap-1">
            {parsed.smcEnhancementFactors.map((f: any, i: number) => (
              <span
                key={i}
                className={`rounded border px-1.5 py-0.5 text-[9px] font-mono ${
                  f.present && f.weight > 0
                    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                    : f.present && f.weight < 0
                    ? "bg-red-500/10 border-red-500/30 text-red-400"
                    : "bg-muted/40 border-border/60 text-muted-foreground"
                }`}
              >
                {f.name}{f.weight ? ` (${f.weight > 0 ? "+" : ""}${f.weight.toFixed(1)})` : ""}
              </span>
            ))}
          </div>
          {parsed.smcEnhancementFactors.some((f: any) => f.detail) && (
            <div className="mt-1 space-y-0.5">
              {parsed.smcEnhancementFactors.filter((f: any) => f.detail && f.present).map((f: any, i: number) => (
                <p key={i} className="text-[8px] text-muted-foreground/80 leading-tight">
                  {f.name}: {f.detail}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Breaker Block Entry (from smcEnhancements module) */}
      {parsed?.breakerData && (
        <div>
          <p className="text-[8px] text-muted-foreground uppercase tracking-wider mb-1 font-bold">Breaker Block</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            <div className="flex justify-between gap-2 border-b border-border/30 py-0.5">
              <span className="text-muted-foreground text-[9px]">Direction</span>
              <span className="font-mono text-[9px] text-foreground">{parsed.breakerData.direction}</span>
            </div>
            <div className="flex justify-between gap-2 border-b border-border/30 py-0.5">
              <span className="text-muted-foreground text-[9px]">Confidence</span>
              <span className="font-mono text-[9px] text-foreground">{(parsed.breakerData.confidence * 100).toFixed(0)}%</span>
            </div>
            <div className="flex justify-between gap-2 border-b border-border/30 py-0.5">
              <span className="text-muted-foreground text-[9px]">Displacement</span>
              <span className="font-mono text-[9px] text-foreground">{parsed.breakerData.displacementStrength?.toFixed(2)}x ATR</span>
            </div>
            <div className="flex justify-between gap-2 border-b border-border/30 py-0.5">
              <span className="text-muted-foreground text-[9px]">Sweep</span>
              <span className="font-mono text-[9px] text-foreground">{parsed.breakerData.hadLiquiditySweep ? "Yes" : "No"}</span>
            </div>
          </div>
        </div>
      )}

      {/* Zone Qualifiers — impulseZoneEngine gate outcomes */}
      {zoneQualifiers.length > 0 && (
        <div>
          <p className="text-[8px] text-muted-foreground uppercase tracking-wider mb-1 font-bold">Zone Qualifiers</p>
          <div className="flex flex-wrap gap-1">
            {zoneQualifiers.map((q, i) => (
              <span
                key={i}
                className={`rounded border px-1.5 py-0.5 text-[9px] font-mono ${qualifierClass(q.tone)}`}
              >
                {q.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Exit Strategy */}
      {exitRows.length > 0 && (
        <div>
          <p className="text-[8px] text-muted-foreground uppercase tracking-wider mb-1 font-bold">Exit Strategy</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {exitRows.map((r, i) => (
              <div key={i} className="flex justify-between gap-2 border-b border-border/30 py-0.5">
                <span className="text-muted-foreground text-[9px]">{r.label}</span>
                <span className="font-mono text-[9px] text-foreground">{r.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      {(spreadFilter || newsFilter) && (
        <div>
          <p className="text-[8px] text-muted-foreground uppercase tracking-wider mb-1 font-bold">Filters</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {spreadFilter && (
              <div className="flex justify-between gap-2 border-b border-border/30 py-0.5">
                <span className="text-muted-foreground text-[9px]">Spread</span>
                <span className="font-mono text-[9px] text-foreground">
                  {spreadFilter.enabled ? "on" : "off"}
                  {spreadFilter.maxPips != null ? ` · max ${spreadFilter.maxPips} pips` : ""}
                </span>
              </div>
            )}
            {newsFilter && (
              <div className="flex justify-between gap-2 border-b border-border/30 py-0.5">
                <span className="text-muted-foreground text-[9px]">News</span>
                <span className="font-mono text-[9px] text-foreground">
                  {newsFilter.enabled ? "on" : "off"}
                  {newsFilter.pauseMinutes != null ? ` · pause ${newsFilter.pauseMinutes} min` : ""}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default SignalReasoningCard;
