/**
 * Trades tab side panel: the trade under review (with the bot's record at entry and how far
 * price went for / against it), then open and recent closed trades to pick from.
 */
import { closeReasonLabel, type ChartTrade, type Excursion } from "@/lib/chartTrades";
import { formatPrice } from "@/lib/formatTime";
import { INSTRUMENTS } from "@/lib/marketData";

const px = (v: number | null | undefined, sym: string) =>
  formatPrice(v, (INSTRUMENTS.find((i) => i.symbol === sym) as never) ?? { symbol: sym });

interface Props {
  trades: ChartTrade[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  excursion: Excursion | null;
  loading?: boolean;
}

const fmtR = (r: number | null) => (r == null ? "—" : `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`);
const fmtMoney = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`);
/** UTC, like the chart's time axis, so a trade's time here matches where its marker sits. */
const fmtTime = (iso: string | null) => (iso ? `${new Date(iso).toLocaleString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })} UTC` : "—");
function held(t: ChartTrade): string {
  const ms = (t.closeTime ? Date.parse(t.closeTime) : Date.now()) - Date.parse(t.openTime);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const h = Math.floor(ms / 3_600_000), m = Math.round((ms % 3_600_000) / 60_000);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}
const rTone = (r: number | null) => (r == null ? "text-muted-foreground" : r > 0 ? "text-success" : r < 0 ? "text-destructive" : "text-muted-foreground");

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-right">{children}</span>
    </div>
  );
}

function Detail({ t, excursion }: { t: ChartTrade; excursion: Excursion | null }) {
  const long = t.direction === "long";
  return (
    <div className="p-3 space-y-3 border-b border-border/50">
      <div className="flex items-center gap-2">
        <span className="font-bold text-sm">{t.symbol}</span>
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${long ? "bg-success/20 text-success" : "bg-destructive/20 text-destructive"}`}>{long ? "LONG" : "SHORT"}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${t.status === "open" ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"}`}>{t.status === "open" ? "OPEN" : closeReasonLabel(t.closeReason)}</span>
        <span className={`ml-auto font-mono font-bold ${rTone(t.r)}`}>{fmtR(t.r)}</span>
      </div>
      <div className="space-y-1">
        <Row label="Entry">{px(t.entryPrice, t.symbol)} · {fmtTime(t.openTime)}</Row>
        <Row label={t.status === "open" ? "Now" : "Exit"}>{t.exitPrice != null ? px(t.exitPrice, t.symbol) : "—"}{t.closeTime ? ` · ${fmtTime(t.closeTime)}` : ""}</Row>
        <Row label="Stop / target">{t.sl != null ? px(t.sl, t.symbol) : "—"} / {t.tp != null ? px(t.tp, t.symbol) : "—"}</Row>
        <Row label="P&L">{fmtMoney(t.pnl)}</Row>
        <Row label="Held">{held(t)}</Row>
      </div>
      {excursion && (
        <div className="space-y-1">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">While open</p>
          <Row label="Best for you"><span className="text-success">{fmtR(excursion.bestR)}</span> ({px(excursion.best, t.symbol)})</Row>
          <Row label="Worst against"><span className="text-destructive">{fmtR(excursion.worstR)}</span> ({px(excursion.worst, t.symbol)})</Row>
          <p className="text-[10px] text-muted-foreground">From the chart candles, so a candle that started before the entry can overstate it slightly.</p>
        </div>
      )}
      <div className="space-y-1">
        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">The bot at entry</p>
        {t.impulse ? (
          <Row label={`Impulse${t.impulse.tf ? ` (${t.impulse.tf})` : ""}`}>{px(t.impulse.fromPrice, t.symbol)} → {px(t.impulse.toPrice, t.symbol)}</Row>
        ) : <Row label="Impulse">not recorded</Row>}
        {t.zone ? (
          <Row label="Zone">{t.zone.label}{t.zone.score != null ? ` · ${t.zone.score}/9` : ""}</Row>
        ) : <Row label="Zone">not recorded</Row>}
        {t.zone && <Row label="Zone range">{px(t.zone.low, t.symbol)} – {px(t.zone.high, t.symbol)}</Row>}
        {t.summary && <p className="text-[10px] text-muted-foreground leading-snug pt-1">{t.summary}</p>}
        <p className="text-[10px] text-muted-foreground pt-1">The purple line and the zone box on the chart are this record, not today's read.</p>
      </div>
    </div>
  );
}

function List({ title, trades, selectedId, onSelect }: { title: string; trades: ChartTrade[]; selectedId: string | null; onSelect: (id: string) => void }) {
  if (!trades.length) return null;
  return (
    <div>
      <p className="px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{title}</p>
      {trades.map((t) => (
        <button key={t.id} onClick={() => onSelect(t.id)}
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left hover:bg-secondary/60 ${t.id === selectedId ? "bg-primary/10" : ""}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${t.direction === "long" ? "bg-success" : "bg-destructive"}`} />
          <span className="font-medium w-16 shrink-0">{t.symbol}</span>
          <span className="text-muted-foreground truncate">{t.status === "open" ? "open" : closeReasonLabel(t.closeReason)}</span>
          <span className={`ml-auto font-mono ${rTone(t.r)}`}>{fmtR(t.r)}</span>
          <span className="text-muted-foreground w-20 text-right shrink-0">{fmtTime(t.closeTime ?? t.openTime)}</span>
        </button>
      ))}
    </div>
  );
}

export function TradesPanel({ trades, selectedId, onSelect, excursion, loading }: Props) {
  const selected = trades.find((t) => t.id === selectedId) ?? null;
  if (loading && !trades.length) return <p className="p-3 text-xs text-muted-foreground">Loading trades…</p>;
  if (!trades.length) return <p className="p-3 text-xs text-muted-foreground">No trades yet.</p>;
  return (
    <div className="flex-1 overflow-y-auto">
      {selected && <Detail t={selected} excursion={excursion} />}
      <List title="Open" trades={trades.filter((t) => t.status === "open")} selectedId={selectedId} onSelect={onSelect} />
      <List title="Recent closed (last 50)" trades={trades.filter((t) => t.status === "closed")} selectedId={selectedId} onSelect={onSelect} />
    </div>
  );
}
