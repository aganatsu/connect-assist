import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/marketData";
import {
  Bot, Activity, Clock, TrendingUp, TrendingDown,
  AlertTriangle, CheckCircle, XCircle, Pause, Play,
} from "lucide-react";

// Demo bot data — read-only display, NO execution logic
const DEMO_BOT_STATUS = {
  isRunning: true,
  uptime: 14523,
  strategy: "SMC BOS + OB Confluence",
  mode: "Paper Trading",
  balance: 12450.75,
  equity: 12620.30,
  dailyPnl: 185.30,
  openPositions: 3,
  todayTrades: 4,
  todayWins: 3,
  todayLosses: 1,
  maxDrawdown: 3.2,
  currentDrawdown: 0.8,
};

const DEMO_LOG = [
  { time: "14:32:05", type: "trade", message: "LONG EUR/USD @ 1.0842 — OB + BOS confluence, 1:3 RR" },
  { time: "14:30:12", type: "signal", message: "Signal detected: EUR/USD BOS above 1.0835 on 4H" },
  { time: "14:15:00", type: "scan", message: "Scanning 10 instruments on 4H timeframe" },
  { time: "13:45:22", type: "reject", message: "GBP/USD signal rejected — outside London KZ" },
  { time: "13:30:00", type: "scan", message: "Scanning 10 instruments on 1H timeframe" },
  { time: "13:12:18", type: "trade", message: "CLOSED SHORT GBP/JPY @ 189.42 — TP hit, +$280" },
  { time: "12:55:44", type: "signal", message: "Signal detected: XAU/USD FVG fill on 15M" },
  { time: "12:30:00", type: "scan", message: "Scanning 10 instruments on 4H timeframe" },
];

const DEMO_ACTIVE_POSITIONS = [
  { symbol: "EUR/USD", direction: "long", entry: 1.0842, current: 1.0867, pnl: 250, duration: "2h 15m", rr: "1.8:1" },
  { symbol: "GBP/USD", direction: "short", entry: 1.2715, current: 1.2698, pnl: 170, duration: "4h 30m", rr: "2.1:1" },
  { symbol: "XAU/USD", direction: "long", entry: 2345.50, current: 2362.80, pnl: 1730, duration: "1h 45m", rr: "1.2:1" },
];

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export default function BotView() {
  const d = DEMO_BOT_STATUS;

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Bot Monitor</h1>
            <p className="text-sm text-muted-foreground">Read-only status — bot runs externally</p>
          </div>
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
              d.isRunning ? 'bg-success/20 text-success' : 'bg-destructive/20 text-destructive'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${d.isRunning ? 'bg-success animate-pulse' : 'bg-destructive'}`} />
              {d.isRunning ? 'Running' : 'Stopped'}
            </span>
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" /> Uptime: {formatUptime(d.uptime)}
            </span>
          </div>
        </div>

        {/* KPI Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
          {[
            { label: "Strategy", value: d.strategy, small: true },
            { label: "Mode", value: d.mode },
            { label: "Balance", value: formatMoney(d.balance) },
            { label: "Today P&L", value: formatMoney(d.dailyPnl, true), color: d.dailyPnl >= 0 ? 'text-success' : 'text-destructive' },
            { label: "Win/Loss", value: `${d.todayWins}W / ${d.todayLosses}L` },
            { label: "Drawdown", value: `${d.currentDrawdown}% / ${d.maxDrawdown}%`, color: d.currentDrawdown > 5 ? 'text-destructive' : 'text-muted-foreground' },
          ].map(kpi => (
            <Card key={kpi.label}>
              <CardContent className="pt-3 pb-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{kpi.label}</p>
                <p className={`text-sm font-bold mt-0.5 ${kpi.color || ''} ${kpi.small ? 'text-xs' : ''}`}>{kpi.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Active Positions */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Active Positions ({DEMO_ACTIVE_POSITIONS.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {DEMO_ACTIVE_POSITIONS.map(p => (
                  <div key={p.symbol} className="flex items-center justify-between p-2 rounded bg-secondary/30 text-xs">
                    <div className="flex items-center gap-2">
                      <span className={`${p.direction === 'long' ? 'text-success' : 'text-destructive'}`}>
                        {p.direction === 'long' ? '▲' : '▼'}
                      </span>
                      <span className="font-medium">{p.symbol}</span>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-muted-foreground">{p.duration}</span>
                      <span className="text-muted-foreground">RR {p.rr}</span>
                      <span className={`font-medium ${p.pnl >= 0 ? 'text-success' : 'text-destructive'}`}>
                        {formatMoney(p.pnl, true)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Activity Log */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Activity Log</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {DEMO_LOG.map((log, i) => {
                  const icons = {
                    trade: <CheckCircle className="h-3 w-3 text-success" />,
                    signal: <Activity className="h-3 w-3 text-primary" />,
                    scan: <Clock className="h-3 w-3 text-muted-foreground" />,
                    reject: <XCircle className="h-3 w-3 text-destructive" />,
                  };
                  return (
                    <div key={i} className="flex items-start gap-2 text-xs py-1.5 border-b border-border/30 last:border-0">
                      {icons[log.type as keyof typeof icons]}
                      <span className="text-muted-foreground w-14 shrink-0">{log.time}</span>
                      <span>{log.message}</span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
