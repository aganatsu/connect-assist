import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Settings, Link2, Shield, Palette, Info, Plus, Trash2, Zap, Sun, Moon, Monitor } from "lucide-react";
import { brokerApi, settingsApi } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/contexts/ThemeContext";
import { BotConfigModal } from "@/components/BotConfigModal";

type SettingsTab = "broker" | "risk" | "bot" | "preferences" | "about";

const TABS: { id: SettingsTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "broker", label: "Broker Connection", icon: Link2 },
  { id: "risk", label: "Risk Management", icon: Shield },
  { id: "bot", label: "Bot Configuration", icon: Zap },
  { id: "preferences", label: "Preferences", icon: Palette },
  { id: "about", label: "About", icon: Info },
];


export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("broker");
  const { signOut } = useAuth();

  return (
    <AppShell>
      <div className="flex gap-6 min-h-[calc(100vh-7rem)]">
        <div className="w-56 shrink-0 space-y-1">
          <h1 className="text-lg font-bold mb-4 flex items-center gap-2"><Settings className="h-5 w-5" /> Settings</h1>
          {TABS.map(tab => {
            const Icon = tab.icon;
            return (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded transition-colors ${
                  activeTab === tab.id ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                }`}><Icon className="h-4 w-4" />{tab.label}</button>
            );
          })}
          <button onClick={() => signOut()} className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded text-destructive hover:bg-destructive/10 mt-4">Sign out</button>
        </div>
        <div className="flex-1 max-w-2xl">
          {activeTab === "broker" && <BrokerSettings />}
          {activeTab === "risk" && <RiskSettings />}
          {activeTab === "bot" && <BotConfigSettings />}
          {activeTab === "preferences" && <PreferencesSettings />}
          {activeTab === "about" && <AboutSettings />}
        </div>
      </div>
    </AppShell>
  );
}

function BrokerSettings() {
  const queryClient = useQueryClient();
  const [brokerType, setBrokerType] = useState<"oanda" | "metaapi">("metaapi");
  const [displayName, setDisplayName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [isLive, setIsLive] = useState(false);

  const { data: connections = [] } = useQuery({ queryKey: ["broker-connections"], queryFn: () => brokerApi.list() });

  const createMutation = useMutation({
    mutationFn: () => brokerApi.create({ broker_type: brokerType, display_name: displayName || brokerType, api_key: apiKey, account_id: accountId, is_live: isLive }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["broker-connections"] }); toast.success("Connection saved"); setApiKey(""); setAccountId(""); setDisplayName(""); },
    onError: (e: any) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => brokerApi.delete(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["broker-connections"] }); toast.success("Connection removed"); },
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => brokerApi.test(id),
    onSuccess: (data: any) => {
      if (data.balance !== undefined) {
        toast.success(`Connected! Balance: ${data.balance} ${data.currency || ""}`);
      } else if (data.name || data.connectionStatus) {
        toast.success(`Connected! ${data.name || ""} — ${data.connectionStatus || data.state || "OK"}`);
      } else {
        toast.success("Connection verified!");
      }
    },
    onError: (e: any) => toast.error(`Test failed: ${e.message}`),
  });

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Broker Connections</h2>
      {(connections as any[]).map((c: any) => (
        <Card key={c.id}>
          <CardContent className="pt-4 flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-sm truncate">{c.display_name}</p>
              <p className="text-xs text-muted-foreground truncate">{c.broker_type.toUpperCase()} · {c.account_id} · {c.is_live ? "Live" : "Demo"}</p>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button size="sm" variant="outline" onClick={() => testMutation.mutate(c.id)}>Test</Button>
              <Button size="sm" variant="destructive" onClick={() => deleteMutation.mutate(c.id)}><Trash2 className="h-3 w-3" /></Button>
            </div>
          </CardContent>
        </Card>
      ))}
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Plus className="h-4 w-4" /> Add Connection</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div><Label className="text-xs">Broker Type</Label>
            <select value={brokerType} onChange={e => setBrokerType(e.target.value as any)} className="w-full mt-1 bg-secondary border border-border rounded px-3 py-2 text-sm">
              <option value="metaapi">MetaAPI (MT4/MT5)</option><option value="oanda">OANDA</option>
            </select></div>
          <div><Label className="text-xs">Display Name</Label><Input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="My Account" className="mt-1" /></div>
          <div><Label className="text-xs">{brokerType === "metaapi" ? "MetaApi Auth Token (JWT)" : "API Key / Token"}</Label><Input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={brokerType === "metaapi" ? "eyJhbGci..." : ""} className="mt-1" /></div>
          <div><Label className="text-xs">{brokerType === "metaapi" ? "MetaApi Account ID (UUID)" : "Account ID"}</Label><Input value={accountId} onChange={e => setAccountId(e.target.value)} placeholder={brokerType === "metaapi" ? "5e83d5a3-cbd9-..." : ""} className="mt-1" /></div>
          <div className="flex items-center gap-2"><Switch checked={isLive} onCheckedChange={setIsLive} /><Label className="text-sm">Live account</Label></div>
          <Button onClick={() => createMutation.mutate()} disabled={!apiKey || !accountId}>Save Connection</Button>
        </CardContent>
      </Card>
    </div>
  );
}

function RiskSettings() {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ["user-settings"], queryFn: () => settingsApi.get() });
  const risk = settings?.risk_settings_json || {};
  const [maxRisk, setMaxRisk] = useState(risk.maxRiskPerTrade ?? 1);
  const [maxDD, setMaxDD] = useState(risk.maxDailyDrawdown ?? 3);
  const [maxPos, setMaxPos] = useState(risk.maxOpenPositions ?? 5);
  const [defaultRR, setDefaultRR] = useState(risk.defaultRR ?? 3);

  useEffect(() => {
    if (settings?.risk_settings_json) {
      const r = settings.risk_settings_json;
      setMaxRisk(r.maxRiskPerTrade ?? 1);
      setMaxDD(r.maxDailyDrawdown ?? 3);
      setMaxPos(r.maxOpenPositions ?? 5);
      setDefaultRR(r.defaultRR ?? 3);
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: () => settingsApi.upsert({ maxRiskPerTrade: maxRisk, maxDailyDrawdown: maxDD, maxOpenPositions: maxPos, defaultRR }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["user-settings"] }); toast.success("Risk settings saved"); },
  });

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Risk Management</h2>
      <Card><CardContent className="pt-4 space-y-4">
        {[
          { label: "Max Risk per Trade (%)", value: maxRisk, set: setMaxRisk },
          { label: "Max Daily Drawdown (%)", value: maxDD, set: setMaxDD },
          { label: "Max Open Positions", value: maxPos, set: setMaxPos },
          { label: "Default Risk:Reward", value: defaultRR, set: setDefaultRR },
        ].map(f => (<div key={f.label}><Label className="text-xs">{f.label}</Label><Input type="number" value={f.value} onChange={e => f.set(parseFloat(e.target.value) || 0)} className="mt-1" /></div>))}
        <Button onClick={() => saveMutation.mutate()}>Save Risk Settings</Button>
      </CardContent></Card>
    </div>
  );
}

function BotConfigSettings() {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Bot Configuration</h2>
      <Card>
        <CardContent className="pt-6 space-y-4">
          <p className="text-sm text-muted-foreground">
            All bot settings — strategy toggles, risk parameters, instruments, sessions, entry/exit rules, and protection — are managed in one place.
          </p>
          <Button onClick={() => setModalOpen(true)} className="w-full flex items-center gap-2">
            <Settings className="h-4 w-4" /> Open Full Bot Configuration
          </Button>
        </CardContent>
      </Card>
      <BotConfigModal open={modalOpen} onOpenChange={setModalOpen} />
    </div>
  );
}

function PreferencesSettings() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Preferences</h2>

      {/* Theme */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Theme</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-2">
            {([
              { id: "dark" as const, label: "Dark", icon: Moon },
              { id: "light" as const, label: "Light", icon: Sun },
              { id: "system" as const, label: "System", icon: Monitor },
            ]).map(opt => (
              <button
                key={opt.id}
                onClick={() => setTheme(opt.id)}
                className={`flex items-center gap-2 px-4 py-3 border text-sm transition-colors ${theme === opt.id ? "border-primary bg-primary/10 text-primary font-medium" : "border-border text-muted-foreground hover:text-foreground hover:border-border/80"}`}
              >
                <opt.icon className="h-4 w-4" />
                {opt.label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Other Preferences */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Notifications & Display</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {[
            { label: "Show desktop notifications", defaultChecked: true },
            { label: "Sound alerts on trade execution", defaultChecked: true },
            { label: "Auto-refresh dashboard", defaultChecked: true },
            { label: "Compact mode", defaultChecked: false },
          ].map(pref => (
            <div key={pref.label} className="flex items-center justify-between">
              <Label className="text-sm">{pref.label}</Label><Switch defaultChecked={pref.defaultChecked} />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function AboutSettings() {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">About</h2>
      <Card><CardContent className="pt-4 space-y-3">
        {[["App", "SMC Trading Dashboard"], ["Version", "2.0.0"], ["Stack", "React + Lovable Cloud"], ["Strategy", "Smart Money Concepts (ICT)"]].map(([k, v]) => (
          <div key={k} className="flex justify-between text-sm"><span className="text-muted-foreground">{k}</span><span>{v}</span></div>
        ))}
      </CardContent></Card>
    </div>
  );
}
