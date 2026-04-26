import { cn } from "@/lib/utils";
import type { TradeItem } from "./TradeReplaySidebar";

interface Props {
  trade: TradeItem | null;
}

const fx = (n: number | undefined | null, d = 3) =>
  typeof n === "number" && Number.isFinite(n) ? n.toFixed(d) : "—";

const fmtDate = (iso: string | undefined) => {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
      ", " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) + " ET";
  } catch { return "—"; }
};

/* ─── Management event from signal_reason ─── */
interface MgmtEvent {
  time: string;
  label: string;
  color: string;
}

function extractManagementEvents(trade: TradeItem): MgmtEvent[] {
  const events: MgmtEvent[] = [];
  const sr = trade.signal_reason || {};

  // Entry event
  events.push({
    time: trade.opened_at,
    label: `Entry at ${fx(trade.entry_price, 5)} — ${sr.summary || sr.setupType || "confluence entry"}`,
    color: "#22c55e",
  });

  // Parse management actions from scan detail if available
  const mgmt = trade.scan_detail?.managementActions || sr.managementActions || [];
  if (Array.isArray(mgmt)) {
    for (const action of mgmt) {
      if (action.action === "no_change") continue;
      events.push({
        time: action.timestamp || trade.opened_at,
        label: action.description || `${action.action}: SL → ${action.newSL || "—"}`,
        color:
          action.action === "break_even" ? "#3b82f6" :
          action.action === "trailing" ? "#06b6d4" :
          action.action === "tighten" ? "#f59e0b" :
          action.action === "partial_close" ? "#a855f7" : "#64748b",
      });
    }
  }

  // Exit event
  if (trade.status === "closed" && trade.exit_price) {
    events.push({
      time: trade.closed_at || trade.opened_at,
      label: `Exit at ${fx(trade.exit_price, 5)} — ${(trade.pnl_pips ?? 0) >= 0 ? "profit" : "loss"} (${fx(trade.pnl_pips, 1)} pips)`,
      color: (trade.pnl_pips ?? 0) >= 0 ? "#22c55e" : "#ef4444",
    });
  } else {
    events.push({
      time: new Date().toISOString(),
      label: `Active — current SL at ${fx(trade.current_sl || trade.stop_loss, 5)}`,
      color: "#a855f7",
    });
  }

  return events;
}

/* ─── Scoring bar ─── */
function ScoreBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="text-[11px] text-muted-foreground min-w-[100px]">{label}</span>
      <div className="flex-1 h-1 bg-accent/30 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="font-mono text-[11px] min-w-[32px] text-right" style={{ color }}>
        {value.toFixed(1)}
      </span>
    </div>
  );
}

export function TradeReplayDetails({ trade }: Props) {
  if (!trade) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        Select a trade to view details
      </div>
    );
  }

  const sr = trade.signal_reason || {};
  const events = extractManagementEvents(trade);
  const entryPips = Math.abs(trade.entry_price - trade.stop_loss);
  const holdMs = trade.closed_at
    ? new Date(trade.closed_at).getTime() - new Date(trade.opened_at).getTime()
    : Date.now() - new Date(trade.opened_at).getTime();
  const holdHours = Math.floor(holdMs / 3600000);
  const holdMins = Math.floor((holdMs % 3600000) / 60000);
  const currentR = entryPips > 0 ? (trade.pnl_pips ?? 0) / (entryPips * 10000) : 0;

  // Extract scoring factors from signal_reason or scan_detail
  const snapshot = trade.scan_detail?.analysis_snapshot || sr;
  const factors = extractScoringFactors(snapshot);
  const totalScore = factors.reduce((s, f) => s + f.value, 0);
  const maxScore = factors.reduce((s, f) => s + f.max, 0);
  const scorePct = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;

  return (
    <div className="h-full grid grid-cols-3 divide-x divide-border overflow-hidden">
      {/* Trade Details */}
      <div className="p-3 overflow-y-auto">
        <SectionTitle dotColor="#06b6d4">Trade Details</SectionTitle>
        <DetailRow label="Entry Time" value={fmtDate(trade.opened_at)} />
        <DetailRow label="Entry Price" value={fx(trade.entry_price, 5)} />
        <DetailRow label="Original SL" value={fx(trade.stop_loss, 5)} valueColor="#ef4444" />
        <DetailRow label="Take Profit" value={fx(trade.take_profit, 5)} valueColor="#22c55e" />
        {trade.current_sl && trade.current_sl !== trade.stop_loss && (
          <DetailRow label="Current SL" value={`${fx(trade.current_sl, 5)} (trailed)`} valueColor="#f59e0b" />
        )}
        <DetailRow label="Hold Time" value={`${holdHours}h ${holdMins}m`} />
        {trade.pnl_pips !== undefined && (
          <DetailRow
            label="P&L"
            value={`${(trade.pnl_pips >= 0 ? "+" : "")}${fx(trade.pnl_pips, 1)} pips`}
            valueColor={trade.pnl_pips >= 0 ? "#22c55e" : "#ef4444"}
          />
        )}
        <DetailRow label="Direction" value={trade.direction} valueColor={trade.direction === "BUY" ? "#22c55e" : "#ef4444"} />
        {trade.status === "closed" && trade.exit_price && (
          <DetailRow label="Exit Price" value={fx(trade.exit_price, 5)} />
        )}
      </div>

      {/* Management Timeline */}
      <div className="p-3 overflow-y-auto">
        <SectionTitle dotColor="#f59e0b">Management Timeline</SectionTitle>
        <div className="space-y-0">
          {events.map((evt, i) => (
            <div key={i} className="flex items-start gap-2.5 py-1.5 relative">
              <div className="flex flex-col items-center">
                <div className="w-2 h-2 rounded-full shrink-0 mt-1" style={{ background: evt.color }} />
                {i < events.length - 1 && (
                  <div className="w-px flex-1 min-h-[16px] bg-border/50" />
                )}
              </div>
              <div className="min-w-0">
                <div className="font-mono text-[10px] text-muted-foreground">
                  {fmtDate(evt.time)}
                </div>
                <div className="text-[11px] text-foreground/80 leading-relaxed">
                  {evt.label}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Entry Scoring */}
      <div className="p-3 overflow-y-auto">
        <SectionTitle dotColor="#22c55e">
          Entry Scoring ({scorePct}%)
        </SectionTitle>
        {factors.map((f, i) => (
          <ScoreBar
            key={i}
            label={f.label}
            value={f.value}
            max={f.max}
            color={f.tier === 1 ? "#22c55e" : f.tier === 2 ? "#06b6d4" : "#a855f7"}
          />
        ))}
        {factors.length === 0 && (
          <div className="text-[11px] text-muted-foreground py-4 text-center">
            No scoring data available
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── helpers ─── */
function SectionTitle({ children, dotColor }: { children: React.ReactNode; dotColor: string }) {
  return (
    <div className="flex items-center gap-1.5 mb-2.5">
      <div className="w-1.5 h-1.5 rounded-full" style={{ background: dotColor }} />
      <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-muted-foreground">
        {children}
      </span>
    </div>
  );
}

function DetailRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="flex justify-between items-center py-1">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className="font-mono text-[12px]" style={{ color: valueColor || "inherit" }}>
        {value}
      </span>
    </div>
  );
}

interface ScoringFactor {
  label: string;
  value: number;
  max: number;
  tier: number;
}

function extractScoringFactors(snapshot: any): ScoringFactor[] {
  if (!snapshot) return [];

  const factors: ScoringFactor[] = [];

  // Try to extract from the analysis_snapshot structure
  const tierMap: Record<string, { label: string; max: number; tier: number }> = {
    marketStructure:   { label: "Market Structure", max: 2.0, tier: 1 },
    orderBlock:        { label: "Order Block",      max: 2.0, tier: 1 },
    fvg:               { label: "Fair Value Gap",   max: 2.0, tier: 1 },
    premiumDiscount:   { label: "Premium/Disc.",    max: 1.5, tier: 1 },
    sessionQuality:    { label: "Session",          max: 1.0, tier: 2 },
    pdpwLevels:        { label: "PD/PW Levels",     max: 1.0, tier: 2 },
    reversalCandle:    { label: "Reversal Candle",  max: 1.0, tier: 2 },
    liquiditySweep:    { label: "Liq. Sweep",       max: 1.0, tier: 2 },
    displacement:      { label: "Displacement",     max: 1.0, tier: 2 },
    breakerBlock:      { label: "Breaker Block",    max: 1.0, tier: 3 },
    unicornModel:      { label: "Unicorn Model",    max: 1.5, tier: 3 },
    confluenceStack:   { label: "Confluence",       max: 1.5, tier: 3 },
    sweepReclaim:      { label: "Sweep Reclaim",    max: 1.0, tier: 3 },
    volumeProfile:     { label: "Volume Profile",   max: 0.5, tier: 3 },
    dailyBias:         { label: "Daily Bias",       max: 0.5, tier: 3 },
  };

  for (const [key, meta] of Object.entries(tierMap)) {
    const val = snapshot[key]?.score ?? snapshot[key]?.points ?? snapshot[key] ?? 0;
    if (typeof val === "number" && val > 0) {
      factors.push({ label: meta.label, value: val, max: meta.max, tier: meta.tier });
    }
  }

  // If no structured data, try flat score fields
  if (factors.length === 0 && typeof snapshot.score === "number") {
    factors.push({ label: "Total Score", value: snapshot.score, max: 18, tier: 1 });
  }

  return factors;
}
