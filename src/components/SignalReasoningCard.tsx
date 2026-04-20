import React, { useState } from "react";

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
}

// ─── Group ordering (mirrors confluenceUnify.ts / backend) ──────────
const GROUP_ORDER: string[] = [
  "Market Structure",
  "Daily Bias",
  "Order Flow Zones",
  "Premium/Discount & Fib",
  "Timing",
  "Price Action",
  "AMD / Power of 3",
  "Macro Confirmation",
  "Volume Profile",
];

const GROUP_ICONS: Record<string, string> = {
  "Market Structure": "📐",
  "Daily Bias": "📊",
  "Order Flow Zones": "🧱",
  "Premium/Discount & Fib": "📏",
  "Timing": "⏰",
  "Price Action": "🕯",
  "AMD / Power of 3": "⚡",
  "Macro Confirmation": "🔍",
  "Volume Profile": "📈",
};

// ─── Summary text parser (unchanged from original) ──────────────────

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

  const scoreMatch = summary.match(/score:\s*([\d.]+)\/10/i);
  if (scoreMatch) result.score = parseFloat(scoreMatch[1]);

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

// ─── Grouped Factor Breakdown ───────────────────────────────────────

interface GroupedFactors {
  name: string;
  icon: string;
  items: FactorScore[];
  passCount: number;
  totalWeight: number;
  passWeight: number;
}

function buildGroupedFactors(factors: FactorScore[]): GroupedFactors[] {
  const groupMap = new Map<string, FactorScore[]>();
  for (const f of factors) {
    const g = f.group || "Other";
    if (!groupMap.has(g)) groupMap.set(g, []);
    groupMap.get(g)!.push(f);
  }

  const result: GroupedFactors[] = [];
  const seen = new Set<string>();

  // Canonical order first
  for (const gName of GROUP_ORDER) {
    const items = groupMap.get(gName);
    if (items && items.length > 0) {
      result.push({
        name: gName,
        icon: GROUP_ICONS[gName] || "📋",
        items,
        passCount: items.filter((i) => i.present).length,
        totalWeight: items.reduce((s, i) => s + i.weight, 0),
        passWeight: items.filter((i) => i.present).reduce((s, i) => s + i.weight, 0),
      });
      seen.add(gName);
    }
  }

  // Any extra groups
  for (const [gName, items] of groupMap) {
    if (!seen.has(gName)) {
      result.push({
        name: gName,
        icon: "📋",
        items,
        passCount: items.filter((i) => i.present).length,
        totalWeight: items.reduce((s, i) => s + i.weight, 0),
        passWeight: items.filter((i) => i.present).reduce((s, i) => s + i.weight, 0),
      });
    }
  }

  return result;
}

// ─── Sub-components ─────────────────────────────────────────────────

function FactorChip({ factor }: { factor: FactorScore }) {
  const passClasses = factor.present
    ? "bg-success/15 border-success/40 text-success"
    : "bg-muted/30 border-border/40 text-muted-foreground";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-mono ${passClasses}`}
      title={factor.detail || factor.name}
    >
      <span className={factor.present ? "" : "opacity-50"}>
        {factor.present ? "✓" : "✗"}
      </span>
      <span className="truncate max-w-[120px]">{factor.name}</span>
      <span className="opacity-60">({factor.weight})</span>
    </span>
  );
}

function GroupSection({ group, defaultOpen }: { group: GroupedFactors; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const hasAnyPass = group.passCount > 0;
  const headerColor = hasAnyPass ? "text-foreground" : "text-muted-foreground";

  return (
    <div className="border border-border/40 rounded-md overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center justify-between px-2 py-1 text-[9px] font-bold tracking-wide uppercase hover:bg-muted/30 transition-colors ${headerColor}`}
      >
        <span className="flex items-center gap-1.5">
          <span>{group.icon}</span>
          <span>{group.name}</span>
          <span className="text-[8px] font-normal text-muted-foreground">
            ({group.passCount}/{group.items.length})
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span className="text-[8px] font-mono text-muted-foreground">
            {group.passWeight.toFixed(1)}/{group.totalWeight.toFixed(1)} pts
          </span>
          <span className="text-[8px]">{open ? "▾" : "▸"}</span>
        </span>
      </button>
      {open && (
        <div className="px-2 py-1.5 border-t border-border/30 flex flex-wrap gap-1">
          {group.items.map((f, i) => (
            <FactorChip key={i} factor={f} />
          ))}
        </div>
      )}
    </div>
  );
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
        {s.score !== null ? ` (${s.score})` : ""}
      </span>
    );
  }

  // Check for new grouped factor data
  const factorScores: FactorScore[] | null =
    Array.isArray(parsed?.factorScores) && parsed.factorScores.length > 0
      ? parsed.factorScores
      : null;

  const groupedFactors = factorScores ? buildGroupedFactors(factorScores) : null;

  const setupType: string | null = parsed?.setupType ?? null;
  const setupConfidence: number | null = parsed?.setupConfidence ?? null;
  const setupRationale: string | null = parsed?.setupRationale ?? null;
  const exitFlags = parsed?.exitFlags ?? null;
  const spreadFilter = parsed?.spreadFilter ?? null;
  const newsFilter = parsed?.newsFilter ?? null;

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
          <span className={`font-mono font-bold text-[11px] ${dirColor}`}>{s.score}/10</span>
        )}
        {s.factorCount !== null && s.total !== null && (
          <span className="text-[9px] text-muted-foreground font-mono">
            {s.factorCount}/{s.total} factors aligned
          </span>
        )}
        {setupType && (
          <span
            className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-bold tracking-wider ${
              setupType === "scalp"
                ? "bg-amber-500/15 border-amber-500/40 text-amber-400"
                : setupType === "swing"
                  ? "bg-purple-500/15 border-purple-500/40 text-purple-400"
                  : "bg-blue-500/15 border-blue-500/40 text-blue-400"
            }`}
            title={setupRationale || `${setupType} setup`}
          >
            {setupType === "scalp" ? "\u26A1 SCALP" : setupType === "swing" ? "\uD83C\uDF0A SWING" : "\uD83D\uDCC8 DAY"}
            {setupConfidence != null && (
              <span className="ml-1 text-[8px] opacity-70">
                {Math.round(setupConfidence * 100)}%
              </span>
            )}
          </span>
        )}
      </div>

      {/* ── NEW: Grouped Factor Breakdown ── */}
      {groupedFactors && groupedFactors.length > 0 ? (
        <div>
          <p className="text-[8px] text-muted-foreground uppercase tracking-wider mb-1 font-bold">
            Factor Breakdown ({groupedFactors.length} groups)
          </p>
          <div className="space-y-1">
            {groupedFactors.map((g, i) => (
              <GroupSection key={i} group={g} defaultOpen={g.passCount > 0} />
            ))}
          </div>
        </div>
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
