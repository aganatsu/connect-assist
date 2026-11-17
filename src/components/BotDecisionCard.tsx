/** BotDecisionCard — the bot's latest decision for the pair, in plain words. */
import type { BotView } from "@/lib/botView";

interface Props {
  view: BotView | null;
  symbol: string;
  loading?: boolean;
  /** The scan lookup failed — say so instead of claiming the pair was not scanned. */
  error?: string | null;
  /** Pairs on the bot's latest scan. */
  scannedPairs?: string[];
  onPickPair?: (pair: string) => void;
}

function PairChips({ pairs, current, onPick }: { pairs?: string[]; current: string; onPick?: (p: string) => void }) {
  if (!pairs?.length || !onPick) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {pairs.map((p) => (
        <button key={p} onClick={() => onPick(p)}
          className={`px-2 py-0.5 rounded border text-[10px] font-mono ${p === current ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/40"}`}>
          {p}
        </button>
      ))}
    </div>
  );
}

const minutesAgo = (iso: string) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));

export function BotDecisionCard({ view, symbol, loading, error, scannedPairs, onPickPair }: Props) {
  if (loading) return <div className="p-4 text-xs text-muted-foreground">Loading the bot's latest scan…</div>;
  if (!view && error) {
    return (
      <div className="p-4 space-y-2 text-xs">
        <p className="font-semibold text-destructive">Could not load the bot's latest scan of {symbol}.</p>
        <p className="text-muted-foreground font-mono break-words">{error}</p>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="p-4 space-y-2 text-xs">
        <p className="font-semibold text-foreground">The bot has not scanned {symbol} recently.</p>
        <p className="text-muted-foreground">Bot View shows what the bot saw on its last scan. {symbol} is not on it{scannedPairs?.length ? " — pick a pair the bot scans:" : " — it is probably not in your Bot Config instruments."}</p>
        <PairChips pairs={scannedPairs} current={symbol} onPick={onPickPair} />
      </div>
    );
  }
  const d = view.decision;
  const toneCls = d.tone === "go" ? "text-success border-success/40 bg-success/10"
    : d.tone === "wait" ? "text-yellow-400 border-yellow-400/40 bg-yellow-400/10"
      : "text-destructive border-destructive/40 bg-destructive/10";
  const age = minutesAgo(view.scannedAt);
  const stale = age > 15;

  return (
    <div className="p-3 space-y-3 text-xs overflow-y-auto">
      <div className={`border rounded px-3 py-2 font-semibold ${toneCls}`}>{d.headline}</div>
      <div className={`text-[10px] ${stale ? "text-destructive" : "text-muted-foreground"}`}>
        Last scan {age} min ago{stale ? " — the bot may not be scanning this pair right now" : ""}
      </div>

      <section className="space-y-1">
        <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Direction</h4>
        <p className="font-semibold">
          {d.direction === "long" ? <span className="text-success">↑ Looking for longs</span>
            : d.direction === "short" ? <span className="text-destructive">↓ Looking for shorts</span>
              : <span className="text-muted-foreground">No direction</span>}
        </p>
        {d.directionLines.map((l, i) => <p key={i} className="text-zinc-300 leading-snug">{l}</p>)}
      </section>

      {(d.zoneLine || d.breakLine) && (
        <section className="space-y-1">
          <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Zone</h4>
          {d.zoneLine && <p className="text-zinc-300">{d.zoneLine}</p>}
          {d.breakLine && <p className="text-zinc-300">{d.breakLine}</p>}
        </section>
      )}

      {(view.levels.entry != null || view.levels.sl != null || view.levels.tp != null) && (
        <section className="space-y-1">
          <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Plan</h4>
          <div className="grid grid-cols-3 gap-1 font-mono">
            <div><div className="text-[10px] text-muted-foreground">Entry</div><div className="text-blue-400">{view.levels.entry ?? "—"}</div></div>
            <div><div className="text-[10px] text-muted-foreground">Stop</div><div className="text-destructive">{view.levels.sl ?? "—"}</div></div>
            <div><div className="text-[10px] text-muted-foreground">Target</div><div className="text-success">{view.levels.tp ?? "—"}</div></div>
          </div>
        </section>
      )}

      {d.waitingFor && (
        <section className="space-y-1">
          <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Waiting for</h4>
          <p className="text-zinc-300">{d.waitingFor}</p>
        </section>
      )}

      {scannedPairs && scannedPairs.length > 1 && (
        <section className="space-y-1 border-t border-border/50 pt-2">
          <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Other pairs the bot scans</h4>
          <PairChips pairs={scannedPairs} current={symbol} onPick={onPickPair} />
        </section>
      )}

      <p className="text-[10px] text-muted-foreground border-t border-border/50 pt-2">
        Swings and CHoCH/BOS are drawn with the bot's own structure code on these candles. The zone, impulse and plan come from the scan record.
      </p>
    </div>
  );
}
