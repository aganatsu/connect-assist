import React, { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { propFirmApi } from "@/lib/api";
import { toast } from "sonner";
import {
  Shield, ShieldAlert, ShieldCheck, Target, TrendingDown, TrendingUp,
  AlertTriangle, Clock, Activity, Settings, History, BarChart3,
  Lock, Unlock, RefreshCw, Save, Trash2,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PropFirmConfig {
  id?: string;
  firm_type: string;
  account_stage: string;
  initial_balance: number;
  account_currency: string;
  max_daily_loss_pct: number;
  max_overall_loss_pct: number;
  profit_target_pct: number | null;
  best_day_rule_pct: number | null;
  trailing_drawdown: boolean;
  safety_buffer_pct: number;
  emergency_close_pct: number;
  close_on_breach: boolean;
  reduce_size_near_limit: boolean;
  size_reduction_threshold_pct: number;
  day_reset_hour_utc: number;
  is_active: boolean;
}

interface DailyState {
  trading_day: string;
  day_start_balance: number;
  day_start_equity: number;
  highest_equity_today: number;
  lowest_equity_today: number;
  current_equity: number | null;
  end_of_day_balance: number | null;
  highest_eod_balance_ever: number;
  realized_pnl_today: number;
  trade_count_today: number;
  is_locked: boolean;
  locked_at: string | null;
  lock_reason: string | null;
}

interface PropFirmEvent {
  id: string;
  event_type: string;
  severity: string;
  message: string;
  balance_at_event: number;
  equity_at_event: number;
  daily_loss_at_event: number;
  drawdown_at_event: number;
  created_at: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PropFirm() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("overview");
  const [configEditing, setConfigEditing] = useState(false);

  // Queries
  const { data: statusData, isLoading: statusLoading } = useQuery({
    queryKey: ["prop-firm-status"],
    queryFn: () => propFirmApi.status(),
    refetchInterval: 30_000, // Refresh every 30s
  });

  const { data: historyData } = useQuery({
    queryKey: ["prop-firm-history"],
    queryFn: () => propFirmApi.dailyHistory(30),
  });

  const { data: eventsData } = useQuery({
    queryKey: ["prop-firm-events"],
    queryFn: () => propFirmApi.events(50),
  });

  const saveMutation = useMutation({
    mutationFn: (config: any) => propFirmApi.saveConfig(config),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prop-firm-status"] });
      toast.success("Prop firm config saved");
      setConfigEditing(false);
    },
    onError: (e: any) => toast.error(`Save failed: ${e?.message || "Unknown error"}`),
  });

  const deleteMutation = useMutation({
    mutationFn: () => propFirmApi.deleteConfig(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prop-firm-status"] });
      toast.success("Prop firm config deactivated");
    },
  });

  const isActive = statusData?.active === true;
  const config: PropFirmConfig | null = statusData?.config || null;
  const dailyState: DailyState | null = statusData?.dailyState || null;
  const derived = statusData?.derived || {};
  const events: PropFirmEvent[] = eventsData?.events || statusData?.events || [];
  const history = historyData?.history || [];

  return (
    <AppShell>
      <div className="container max-w-6xl py-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Shield className="w-7 h-7 text-primary" />
            <div>
              <h1 className="text-2xl font-bold">Prop Firm Compliance</h1>
              <p className="text-sm text-muted-foreground">FTMO risk management & daily tracking</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isActive && (
              <Badge variant={dailyState?.is_locked ? "destructive" : "default"} className="gap-1">
                {dailyState?.is_locked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                {dailyState?.is_locked ? "LOCKED" : "ACTIVE"}
              </Badge>
            )}
            {!isActive && <Badge variant="secondary">Not Configured</Badge>}
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="overview" className="gap-1">
              <Activity className="w-4 h-4" /> Overview
            </TabsTrigger>
            <TabsTrigger value="history" className="gap-1">
              <History className="w-4 h-4" /> Daily History
            </TabsTrigger>
            <TabsTrigger value="events" className="gap-1">
              <AlertTriangle className="w-4 h-4" /> Events
            </TabsTrigger>
            <TabsTrigger value="config" className="gap-1">
              <Settings className="w-4 h-4" /> Config
            </TabsTrigger>
          </TabsList>

          {/* ─── Overview Tab ─── */}
          <TabsContent value="overview" className="space-y-4">
            {!isActive ? (
              <SetupPrompt onSetup={() => { setActiveTab("config"); setConfigEditing(true); }} />
            ) : (
              <>
                <ComplianceMeters config={config!} dailyState={dailyState} derived={derived} />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <AccountSummary config={config!} dailyState={dailyState} derived={derived} />
                  <RecentEvents events={events.slice(0, 8)} />
                </div>
              </>
            )}
          </TabsContent>

          {/* ─── Daily History Tab ─── */}
          <TabsContent value="history">
            <DailyHistoryTable history={history} config={config} />
          </TabsContent>

          {/* ─── Events Tab ─── */}
          <TabsContent value="events">
            <EventLog events={events} />
          </TabsContent>

          {/* ─── Config Tab ─── */}
          <TabsContent value="config">
            <ConfigPanel
              config={config}
              editing={configEditing}
              setEditing={setConfigEditing}
              onSave={(c) => saveMutation.mutate(c)}
              onDelete={() => deleteMutation.mutate()}
              saving={saveMutation.isPending}
            />
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SetupPrompt({ onSetup }: { onSetup: () => void }) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center justify-center py-12 text-center">
        <Shield className="w-12 h-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-semibold mb-2">No Prop Firm Config Active</h3>
        <p className="text-sm text-muted-foreground mb-4 max-w-md">
          Set up FTMO compliance monitoring to protect your prop firm account with automated
          daily loss limits, max drawdown tracking, and emergency close protection.
        </p>
        <Button onClick={onSetup}>Configure FTMO Compliance</Button>
      </CardContent>
    </Card>
  );
}

function ComplianceMeters({ config, dailyState, derived }: { config: PropFirmConfig; dailyState: DailyState | null; derived: any }) {
  const currentEquity = dailyState?.current_equity ?? derived.currentBalance ?? config.initial_balance;
  const dayStartBalance = dailyState?.day_start_balance ?? config.initial_balance;

  // Daily loss meter
  const dailyLossAbs = Math.max(0, dayStartBalance - currentEquity);
  const dailyLossLimit = derived.dailyLossLimit ?? config.initial_balance * config.max_daily_loss_pct;
  const dailyLossPct = dailyLossLimit > 0 ? (dailyLossAbs / dailyLossLimit) * 100 : 0;

  // Max drawdown meter
  const highestEOD = dailyState?.highest_eod_balance_ever ?? config.initial_balance;
  const drawdownFloor = derived.drawdownFloor ?? config.initial_balance * (1 - config.max_overall_loss_pct);
  const totalDrawdownAllowed = highestEOD - drawdownFloor;
  const currentDrawdown = Math.max(0, highestEOD - currentEquity);
  const drawdownPct = totalDrawdownAllowed > 0 ? (currentDrawdown / totalDrawdownAllowed) * 100 : 0;

  // Profit target meter
  const profitTarget = derived.profitTarget ?? (config.profit_target_pct ? config.initial_balance * (1 + config.profit_target_pct) : null);
  const currentBalance = derived.currentBalance ?? config.initial_balance;
  const profitProgress = profitTarget
    ? Math.max(0, ((currentBalance - config.initial_balance) / (profitTarget - config.initial_balance)) * 100)
    : 0;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {/* Daily Loss */}
      <Card className={dailyLossPct > 80 ? "border-destructive" : dailyLossPct > 60 ? "border-yellow-500" : ""}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <TrendingDown className="w-4 h-4 text-red-500" />
            Daily Loss
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Used</span>
              <span className={dailyLossPct > 80 ? "text-red-500 font-bold" : "font-medium"}>
                ${dailyLossAbs.toFixed(2)} / ${dailyLossLimit.toFixed(2)}
              </span>
            </div>
            <Progress value={Math.min(100, dailyLossPct)} className={dailyLossPct > 80 ? "[&>div]:bg-red-500" : dailyLossPct > 60 ? "[&>div]:bg-yellow-500" : ""} />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{dailyLossPct.toFixed(1)}% of limit</span>
              <span>Limit: {(config.max_daily_loss_pct * 100).toFixed(0)}%</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Max Drawdown */}
      <Card className={drawdownPct > 80 ? "border-destructive" : drawdownPct > 60 ? "border-yellow-500" : ""}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-orange-500" />
            Max Drawdown
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Used</span>
              <span className={drawdownPct > 80 ? "text-red-500 font-bold" : "font-medium"}>
                ${currentDrawdown.toFixed(2)} / ${totalDrawdownAllowed.toFixed(2)}
              </span>
            </div>
            <Progress value={Math.min(100, drawdownPct)} className={drawdownPct > 80 ? "[&>div]:bg-red-500" : drawdownPct > 60 ? "[&>div]:bg-orange-500" : ""} />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{drawdownPct.toFixed(1)}% of limit</span>
              <span>Floor: ${drawdownFloor.toFixed(0)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Profit Target */}
      <Card className={profitProgress >= 100 ? "border-green-500" : ""}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Target className="w-4 h-4 text-green-500" />
            Profit Target
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Progress</span>
              <span className={profitProgress >= 100 ? "text-green-500 font-bold" : "font-medium"}>
                ${(currentBalance - config.initial_balance).toFixed(2)} / ${profitTarget ? (profitTarget - config.initial_balance).toFixed(2) : "N/A"}
              </span>
            </div>
            <Progress value={Math.min(100, profitProgress)} className="[&>div]:bg-green-500" />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{profitProgress.toFixed(1)}%</span>
              <span>Target: ${profitTarget?.toFixed(0) ?? "N/A"}</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AccountSummary({ config, dailyState, derived }: { config: PropFirmConfig; dailyState: DailyState | null; derived: any }) {
  const currentBalance = derived.currentBalance ?? config.initial_balance;
  const currentEquity = dailyState?.current_equity ?? currentBalance;
  const profitFromStart = currentBalance - config.initial_balance;
  const tradingDays = derived.tradingDay ?? "—";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <BarChart3 className="w-4 h-4" /> Account Summary
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex justify-between"><span className="text-muted-foreground">Initial Balance</span><span className="font-mono">${config.initial_balance.toLocaleString()}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Current Balance</span><span className="font-mono">${currentBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Current Equity</span><span className="font-mono">${currentEquity.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">P&L from Start</span>
          <span className={`font-mono ${profitFromStart >= 0 ? "text-green-500" : "text-red-500"}`}>
            {profitFromStart >= 0 ? "+" : ""}${profitFromStart.toFixed(2)}
          </span>
        </div>
        <div className="flex justify-between"><span className="text-muted-foreground">Account Stage</span><Badge variant="outline" className="capitalize">{config.account_stage}</Badge></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Firm Type</span><Badge variant="outline">{config.firm_type.replace("_", " ").toUpperCase()}</Badge></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Trading Day</span><span className="font-mono text-xs">{tradingDays}</span></div>
        {dailyState && (
          <>
            <div className="flex justify-between"><span className="text-muted-foreground">Today's Trades</span><span>{dailyState.trade_count_today}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Today's High</span><span className="font-mono text-green-500">${dailyState.highest_equity_today.toFixed(2)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Today's Low</span><span className="font-mono text-red-500">${dailyState.lowest_equity_today.toFixed(2)}</span></div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RecentEvents({ events }: { events: PropFirmEvent[] }) {
  if (events.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Clock className="w-4 h-4" /> Recent Events
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-4">No events yet</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Clock className="w-4 h-4" /> Recent Events
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 max-h-64 overflow-y-auto">
        {events.map((event) => (
          <div key={event.id} className="flex items-start gap-2 text-xs border-b border-border/50 pb-2 last:border-0">
            <SeverityIcon severity={event.severity} />
            <div className="flex-1 min-w-0">
              <p className="truncate">{event.message}</p>
              <p className="text-muted-foreground">{new Date(event.created_at).toLocaleString()}</p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function SeverityIcon({ severity }: { severity: string }) {
  switch (severity) {
    case "critical": return <ShieldAlert className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />;
    case "warning": return <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 shrink-0 mt-0.5" />;
    default: return <ShieldCheck className="w-3.5 h-3.5 text-green-500 shrink-0 mt-0.5" />;
  }
}

function DailyHistoryTable({ history, config }: { history: any[]; config: PropFirmConfig | null }) {
  if (history.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          No daily history available yet. History will appear after the first trading day completes.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Daily Trading History</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="text-left py-2 px-2">Day</th>
                <th className="text-right py-2 px-2">Start Balance</th>
                <th className="text-right py-2 px-2">EOD Balance</th>
                <th className="text-right py-2 px-2">P&L</th>
                <th className="text-right py-2 px-2">High</th>
                <th className="text-right py-2 px-2">Low</th>
                <th className="text-right py-2 px-2">Trades</th>
                <th className="text-center py-2 px-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {history.map((day: any) => {
                const eod = day.end_of_day_balance ?? day.current_equity ?? day.day_start_balance;
                const pnl = eod - day.day_start_balance;
                return (
                  <tr key={day.trading_day} className="border-b border-border/30 hover:bg-muted/30">
                    <td className="py-2 px-2 font-mono">{day.trading_day}</td>
                    <td className="py-2 px-2 text-right font-mono">${day.day_start_balance.toFixed(2)}</td>
                    <td className="py-2 px-2 text-right font-mono">${eod.toFixed(2)}</td>
                    <td className={`py-2 px-2 text-right font-mono ${pnl >= 0 ? "text-green-500" : "text-red-500"}`}>
                      {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                    </td>
                    <td className="py-2 px-2 text-right font-mono text-green-500">${day.highest_equity_today.toFixed(2)}</td>
                    <td className="py-2 px-2 text-right font-mono text-red-500">${day.lowest_equity_today.toFixed(2)}</td>
                    <td className="py-2 px-2 text-right">{day.trade_count_today}</td>
                    <td className="py-2 px-2 text-center">
                      {day.is_locked ? (
                        <Badge variant="destructive" className="text-[10px]">Locked</Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">OK</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function EventLog({ events }: { events: PropFirmEvent[] }) {
  if (events.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          No events recorded yet. Events will appear when compliance thresholds are crossed.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Event Log</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3 max-h-[600px] overflow-y-auto">
          {events.map((event) => (
            <div key={event.id} className="flex items-start gap-3 p-3 rounded-lg bg-muted/30 border border-border/50">
              <SeverityIcon severity={event.severity} />
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <Badge variant={event.severity === "critical" ? "destructive" : event.severity === "warning" ? "secondary" : "outline"} className="text-[10px]">
                    {event.event_type.replace(/_/g, " ")}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">{new Date(event.created_at).toLocaleString()}</span>
                </div>
                <p className="text-xs">{event.message}</p>
                <div className="flex gap-4 text-[10px] text-muted-foreground">
                  <span>Balance: ${event.balance_at_event.toFixed(2)}</span>
                  <span>Equity: ${event.equity_at_event.toFixed(2)}</span>
                  {event.daily_loss_at_event > 0 && <span className="text-red-400">Daily Loss: ${event.daily_loss_at_event.toFixed(2)}</span>}
                  {event.drawdown_at_event > 0 && <span className="text-orange-400">Drawdown: ${event.drawdown_at_event.toFixed(2)}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ConfigPanel({ config, editing, setEditing, onSave, onDelete, saving }: {
  config: PropFirmConfig | null;
  editing: boolean;
  setEditing: (v: boolean) => void;
  onSave: (c: any) => void;
  onDelete: () => void;
  saving: boolean;
}) {
  const defaults: PropFirmConfig = {
    firm_type: "ftmo_2step",
    account_stage: "challenge",
    initial_balance: 100_000,
    account_currency: "USD",
    max_daily_loss_pct: 0.05,
    max_overall_loss_pct: 0.10,
    profit_target_pct: 0.10,
    best_day_rule_pct: null,
    trailing_drawdown: false,
    safety_buffer_pct: 0.008,
    emergency_close_pct: 0.002,
    close_on_breach: true,
    reduce_size_near_limit: true,
    size_reduction_threshold_pct: 0.60,
    day_reset_hour_utc: 22,
    is_active: true,
  };

  const [form, setForm] = useState<PropFirmConfig>(config || defaults);

  const handleFirmTypeChange = (type: string) => {
    if (type === "ftmo_1step") {
      setForm({ ...form, firm_type: type, max_daily_loss_pct: 0.03, trailing_drawdown: true, best_day_rule_pct: 0.50 });
    } else {
      setForm({ ...form, firm_type: type, max_daily_loss_pct: 0.05, trailing_drawdown: false, best_day_rule_pct: null });
    }
  };

  const handleStageChange = (stage: string) => {
    let target = form.profit_target_pct;
    if (stage === "challenge") target = form.firm_type === "ftmo_1step" ? 0.10 : 0.10;
    else if (stage === "verification") target = 0.05;
    else target = null;
    setForm({ ...form, account_stage: stage, profit_target_pct: target });
  };

  if (!editing && config) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium">Current Configuration</CardTitle>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => { setForm(config); setEditing(true); }}>
              <Settings className="w-3.5 h-3.5 mr-1" /> Edit
            </Button>
            <Button size="sm" variant="destructive" onClick={onDelete}>
              <Trash2 className="w-3.5 h-3.5 mr-1" /> Deactivate
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <ConfigField label="Firm Type" value={config.firm_type.replace("_", " ").toUpperCase()} />
            <ConfigField label="Account Stage" value={config.account_stage} />
            <ConfigField label="Initial Balance" value={`$${config.initial_balance.toLocaleString()}`} />
            <ConfigField label="Max Daily Loss" value={`${(config.max_daily_loss_pct * 100).toFixed(1)}%`} />
            <ConfigField label="Max Drawdown" value={`${(config.max_overall_loss_pct * 100).toFixed(1)}%`} />
            <ConfigField label="Profit Target" value={config.profit_target_pct ? `${(config.profit_target_pct * 100).toFixed(1)}%` : "None"} />
            <ConfigField label="Safety Buffer" value={`${(config.safety_buffer_pct * 100).toFixed(2)}%`} />
            <ConfigField label="Emergency Close" value={`${(config.emergency_close_pct * 100).toFixed(2)}%`} />
            <ConfigField label="Close on Breach" value={config.close_on_breach ? "Yes" : "No"} />
            <ConfigField label="Size Reduction" value={config.reduce_size_near_limit ? `At ${(config.size_reduction_threshold_pct * 100).toFixed(0)}%` : "Off"} />
            <ConfigField label="Trailing Drawdown" value={config.trailing_drawdown ? "Yes" : "No"} />
            <ConfigField label="Reset Hour (UTC)" value={`${config.day_reset_hour_utc}:00`} />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{config ? "Edit Configuration" : "Setup FTMO Compliance"}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Firm Type & Stage */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label>Firm Type</Label>
            <Select value={form.firm_type} onValueChange={handleFirmTypeChange}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ftmo_2step">FTMO 2-Step</SelectItem>
                <SelectItem value="ftmo_1step">FTMO 1-Step</SelectItem>
                <SelectItem value="generic">Generic</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Account Stage</Label>
            <Select value={form.account_stage} onValueChange={handleStageChange}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="challenge">Challenge</SelectItem>
                <SelectItem value="verification">Verification</SelectItem>
                <SelectItem value="funded">Funded</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Initial Balance ($)</Label>
            <Input type="number" value={form.initial_balance} onChange={(e) => setForm({ ...form, initial_balance: parseFloat(e.target.value) || 0 })} />
          </div>
        </div>

        {/* Risk Limits */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label>Max Daily Loss (%)</Label>
            <Input type="number" step="0.1" value={(form.max_daily_loss_pct * 100).toFixed(1)} onChange={(e) => setForm({ ...form, max_daily_loss_pct: parseFloat(e.target.value) / 100 || 0 })} />
          </div>
          <div className="space-y-2">
            <Label>Max Overall Loss (%)</Label>
            <Input type="number" step="0.1" value={(form.max_overall_loss_pct * 100).toFixed(1)} onChange={(e) => setForm({ ...form, max_overall_loss_pct: parseFloat(e.target.value) / 100 || 0 })} />
          </div>
          <div className="space-y-2">
            <Label>Profit Target (%)</Label>
            <Input type="number" step="0.1" value={form.profit_target_pct ? (form.profit_target_pct * 100).toFixed(1) : ""} placeholder="None (funded)" onChange={(e) => setForm({ ...form, profit_target_pct: e.target.value ? parseFloat(e.target.value) / 100 : null })} />
          </div>
        </div>

        {/* Safety Settings */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label>Safety Buffer (%)</Label>
            <Input type="number" step="0.01" value={(form.safety_buffer_pct * 100).toFixed(2)} onChange={(e) => setForm({ ...form, safety_buffer_pct: parseFloat(e.target.value) / 100 || 0 })} />
            <p className="text-[10px] text-muted-foreground">Block entries this far before limit</p>
          </div>
          <div className="space-y-2">
            <Label>Emergency Close (%)</Label>
            <Input type="number" step="0.01" value={(form.emergency_close_pct * 100).toFixed(2)} onChange={(e) => setForm({ ...form, emergency_close_pct: parseFloat(e.target.value) / 100 || 0 })} />
            <p className="text-[10px] text-muted-foreground">Close all positions this far before breach</p>
          </div>
          <div className="space-y-2">
            <Label>Size Reduction Threshold (%)</Label>
            <Input type="number" step="1" value={(form.size_reduction_threshold_pct * 100).toFixed(0)} onChange={(e) => setForm({ ...form, size_reduction_threshold_pct: parseFloat(e.target.value) / 100 || 0 })} />
            <p className="text-[10px] text-muted-foreground">Start reducing size at this % of limit used</p>
          </div>
        </div>

        {/* Toggles */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center justify-between p-3 rounded-lg border">
            <div>
              <Label>Close All on Breach</Label>
              <p className="text-[10px] text-muted-foreground">Emergency close all positions near limit</p>
            </div>
            <Switch checked={form.close_on_breach} onCheckedChange={(v) => setForm({ ...form, close_on_breach: v })} />
          </div>
          <div className="flex items-center justify-between p-3 rounded-lg border">
            <div>
              <Label>Reduce Size Near Limit</Label>
              <p className="text-[10px] text-muted-foreground">Gradually reduce position size as limit approaches</p>
            </div>
            <Switch checked={form.reduce_size_near_limit} onCheckedChange={(v) => setForm({ ...form, reduce_size_near_limit: v })} />
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 justify-end">
          {config && <Button variant="outline" onClick={() => setEditing(false)}>Cancel</Button>}
          <Button onClick={() => onSave(form)} disabled={saving}>
            {saving ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
            {config ? "Update Config" : "Activate Compliance"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ConfigField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className="font-medium capitalize">{value}</p>
    </div>
  );
}
