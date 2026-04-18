import { Radio } from "lucide-react";
import type { CandleSource } from "@/lib/api";

// Tiny pill that shows where candle data is coming from.
// - metaapi    → green   (broker feed, most accurate)
// - twelvedata → amber   (real-time third-party fallback)
// - yahoo      → red     (15-min delayed fallback — be careful!)
// - none       → muted   (no data available)
const SOURCE_META: Record<CandleSource, { label: string; cls: string; tip: string }> = {
  metaapi:    { label: "MetaAPI",      cls: "text-success bg-success/10 border-success/40",         tip: "Broker feed (live, broker-accurate)" },
  twelvedata: { label: "Twelve Data",  cls: "text-warning bg-warning/10 border-warning/40",         tip: "Real-time third-party feed" },
  yahoo:      { label: "Yahoo",        cls: "text-destructive bg-destructive/10 border-destructive/40", tip: "15-min delayed fallback feed" },
  none:       { label: "No Data",      cls: "text-muted-foreground bg-muted/20 border-border",      tip: "No source returned candles" },
  unknown:    { label: "—",            cls: "text-muted-foreground bg-muted/20 border-border",      tip: "Source not reported yet" },
};

interface Props {
  source: CandleSource | undefined | null;
  className?: string;
  showIcon?: boolean;
}

export function DataSourceBadge({ source, className = "", showIcon = true }: Props) {
  const meta = SOURCE_META[(source ?? "unknown") as CandleSource] ?? SOURCE_META.unknown;
  return (
    <span
      title={meta.tip}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 border text-[9px] font-bold uppercase tracking-wider rounded-sm ${meta.cls} ${className}`}
    >
      {showIcon && <Radio className="h-2.5 w-2.5" />}
      {meta.label}
    </span>
  );
}
