import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Crosshair, RefreshCw, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { manualImpulseApi, type ManualImpulseRow } from "@/lib/api";
import { INSTRUMENTS } from "@/lib/marketData";

/** Minimum stop per instrument — mirrors MIN_SL_PIPS in _shared/smcAnalysis.ts. */
const MIN_SL_PIPS: Record<string, number> = {
  "GBP/JPY": 35, "EUR/JPY": 30, "USD/JPY": 25, "AUD/JPY": 25, "CAD/JPY": 25,
  "NZD/JPY": 25, "CHF/JPY": 25,
  "GBP/USD": 25, "GBP/AUD": 30, "GBP/CAD": 30, "GBP/NZD": 30, "GBP/CHF": 25,
  "EUR/USD": 20, "EUR/GBP": 15, "EUR/AUD": 25, "EUR/CAD": 25, "EUR/NZD": 25,
  "EUR/CHF": 18,
  "AUD/USD": 18, "NZD/USD": 18, "USD/CAD": 18, "USD/CHF": 18,
  "AUD/CAD": 20, "AUD/NZD": 20, "AUD/CHF": 20, "NZD/CAD": 20, "NZD/CHF": 20,
  "CAD/CHF": 18,
  "XAU/USD": 50, "BTC/USD": 150,
};
const MIN_RR = 1.5;

const pipSizeFor = (symbol: string) => (symbol.includes("JPY") ? 0.01 : 0.0001);

const STATUS_TONE: Record<string, string> = {
  active: "border-success/50 text-success",
  invalidated: "border-destructive/50 text-destructive",
  cancelled: "border-border text-muted-foreground",
  expired: "border-border text-muted-foreground",
  filled: "border-primary/50 text-primary",
};

export default function ManualImpulse() {
  const qc = useQueryClient();
  const [symbol, setSymbol] = useState("EUR/USD");
  const [direction, setDirection] = useState<"bullish" | "bearish">("bullish");
  const [timeframe, setTimeframe] = useState<"D" | "4H" | "1H">("1H");
  const [high, setHigh] = useState("");
  const [low, setLow] = useState("");
  const [validHours, setValidHours] = useState("12");

  const { data: markings = [], isLoading, refetch } = useQuery({
    queryKey: ["manual-impulses"],
    queryFn: () => manualImpulseApi.list(),
    staleTime: 30_000,
  });

  const create = useMutation({
    mutationFn: () =>
      manualImpulseApi.create({
        symbol,
        direction,
        high: Number(high),
        low: Number(low),
        timeframe,
        validHours: Number(validHours),
      }),
    onSuccess: () => {
      toast.success(`${symbol} impulse marked. The scanner picks it up next cycle.`);
      setHigh("");
      setLow("");
      qc.invalidateQueries({ queryKey: ["manual-impulses"] });
    },
    onError: (e: any) => toast.error(e?.message || "Could not save the marking."),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => manualImpulseApi.cancel(id),
    onSuccess: () => {
      toast.success("Marking cancelled.");
      qc.invalidateQueries({ queryKey: ["manual-impulses"] });
    },
    onError: (e: any) => toast.error(e?.message || "Could not cancel."),
  });

  // Same arithmetic the backend enforces, run as you type so an unusable
  // marking is refused here rather than silently never producing a signal.
  const h = Number(high);
  const l = Number(low);
  const bothPresent = high.trim() !== "" && low.trim() !== "";
  const boundsOk = Number.isFinite(h) && Number.isFinite(l) && h > l;
  const rangePips = boundsOk ? (h - l) / pipSizeFor(symbol) : 0;
  const requiredPips = (MIN_SL_PIPS[symbol] ?? 15) * MIN_RR;
  const bigEnough = rangePips >= requiredPips;
  const canSubmit = bothPresent && boundsOk && bigEnough && !create.isPending;

  const problem = !bothPresent
    ? null
    : !boundsOk
    ? "High must be greater than low."
    : !bigEnough
    ? `That leg is ${rangePips.toFixed(1)} pips. ${symbol} needs at least ` +
      `${Math.round(requiredPips)} (min stop ${MIN_SL_PIPS[symbol] ?? 15} × ${MIN_RR} R:R) ` +
      `for any entry inside it to be tradeable.`
    : null;

  return (
    <div className="p-3 sm:p-4 space-y-4 max-w-5xl">
      <div className="flex items-center gap-2">
        <Crosshair className="h-5 w-5 text-primary" />
        <div>
          <h1 className="text-lg sm:text-xl font-bold text-foreground">Manual Impulse</h1>
          <p className="text-[11px] text-muted-foreground">
            Mark the impulse yourself; the bot does the rest — zones, confluence, gates, sizing, execution.
          </p>
        </div>
      </div>

      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="p-3">
          <p className="text-xs font-semibold text-foreground">This overrides automatic detection</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            While a marking is active the scanner will not look for its own impulse on that pair.
            Every safety gate still applies, and the Direction Verdict can still hold the trade
            if it disagrees with your direction.
          </p>
        </CardContent>
      </Card>

      <Card className="border-border/50">
        <CardHeader className="pb-2 pt-3 px-4">
          <CardTitle className="text-sm font-medium">Mark an impulse</CardTitle>
          <p className="text-[10px] text-muted-foreground mt-1">
            Read the swing high and low straight off TradingView. Use the wick extremes of the leg you want traded.
          </p>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-[10px]">Instrument</Label>
              <Select value={symbol} onValueChange={setSymbol}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {INSTRUMENTS.map((i) => (
                    <SelectItem key={i.symbol} value={i.symbol}>{i.symbol}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[10px]">Direction</Label>
              <Select value={direction} onValueChange={(v) => setDirection(v as any)}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="bullish">Bullish (low → high)</SelectItem>
                  <SelectItem value="bearish">Bearish (high → low)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[10px]">Marked on</Label>
              <Select value={timeframe} onValueChange={(v) => setTimeframe(v as any)}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="D">Daily</SelectItem>
                  <SelectItem value="4H">4 Hour</SelectItem>
                  <SelectItem value="1H">1 Hour</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-[10px]">Swing high</Label>
              <Input
                inputMode="decimal" placeholder="1.09000" value={high}
                onChange={(e) => setHigh(e.target.value)}
                className="h-9 text-sm font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px]">Swing low</Label>
              <Input
                inputMode="decimal" placeholder="1.08000" value={low}
                onChange={(e) => setLow(e.target.value)}
                className="h-9 text-sm font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px]">Valid for (hours)</Label>
              <Input
                inputMode="numeric" value={validHours}
                onChange={(e) => setValidHours(e.target.value)}
                className="h-9 text-sm font-mono"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="text-[10px]">
              {bothPresent && boundsOk && (
                <span className={bigEnough ? "text-muted-foreground" : "text-destructive"}>
                  {rangePips.toFixed(1)} pips · needs {Math.round(requiredPips)}
                </span>
              )}
              {problem && <p className="text-destructive mt-0.5 max-w-xl">{problem}</p>}
            </div>
            <Button
              type="button" size="sm" className="h-8 text-xs"
              disabled={!canSubmit}
              onClick={() => create.mutate()}
            >
              {create.isPending ? "Saving…" : "Mark impulse"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/50">
        <CardHeader className="pb-2 pt-3 px-4">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm font-medium">Your markings</CardTitle>
            <Button
              type="button" size="sm" variant="outline" className="h-7 text-[10px]"
              onClick={() => refetch()}
            >
              <RefreshCw className={`h-3 w-3 mr-1 ${isLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {isLoading ? (
            <div className="py-6 text-center text-xs text-muted-foreground">Loading…</div>
          ) : markings.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              Nothing marked yet. The bot is using its own impulse detection.
            </div>
          ) : (
            <div className="space-y-1.5">
              {markings.map((m: ManualImpulseRow) => (
                <div
                  key={m.id}
                  className="grid grid-cols-1 md:grid-cols-[120px_90px_1fr_auto] gap-2 rounded border border-border/50 p-2 items-start"
                >
                  <div>
                    <p className="text-xs font-semibold">{m.symbol}</p>
                    <p className="text-[9px] text-muted-foreground uppercase">
                      {m.direction} · {m.timeframe}
                    </p>
                  </div>
                  <div className="font-mono text-[10px]">
                    <p>{m.high}</p>
                    <p className="text-muted-foreground">{m.low}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground">
                      expires {new Date(m.expires_at).toLocaleString()}
                    </p>
                    {m.last_resolution_detail && (
                      <p className="text-[9px] text-muted-foreground mt-0.5">
                        {m.last_resolution_detail}
                      </p>
                    )}
                    {m.resolution_reason && (
                      <p className="text-[9px] text-destructive mt-0.5">
                        {m.resolution_reason.replace(/_/g, " ")}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={`text-[9px] ${STATUS_TONE[m.status] || "border-border"}`}
                    >
                      {m.status.toUpperCase()}
                    </Badge>
                    {m.status === "active" && (
                      <Button
                        type="button" size="sm" variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={() => cancel.mutate(m.id)}
                        aria-label={`Cancel ${m.symbol} marking`}
                      >
                        <Trash2 className="h-3 w-3 text-muted-foreground" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
