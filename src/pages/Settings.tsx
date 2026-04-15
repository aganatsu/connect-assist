import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import {
  Settings, Link2, Shield, Palette, Keyboard, Info,
} from "lucide-react";

type SettingsTab = "broker" | "risk" | "preferences" | "shortcuts" | "about";

const TABS: { id: SettingsTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "broker", label: "Broker Connection", icon: Link2 },
  { id: "risk", label: "Risk Management", icon: Shield },
  { id: "preferences", label: "Preferences", icon: Palette },
  { id: "shortcuts", label: "Keyboard Shortcuts", icon: Keyboard },
  { id: "about", label: "About", icon: Info },
];

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("broker");

  return (
    <AppShell>
      <div className="flex gap-6 min-h-[calc(100vh-7rem)]">
        {/* Settings Sidebar */}
        <div className="w-56 shrink-0 space-y-1">
          <h1 className="text-lg font-bold mb-4 flex items-center gap-2">
            <Settings className="h-5 w-5" /> Settings
          </h1>
          {TABS.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded transition-colors ${
                  activeTab === tab.id
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 max-w-2xl">
          {activeTab === "broker" && <BrokerSettings />}
          {activeTab === "risk" && <RiskSettings />}
          {activeTab === "preferences" && <PreferencesSettings />}
          {activeTab === "shortcuts" && <ShortcutsSettings />}
          {activeTab === "about" && <AboutSettings />}
        </div>
      </div>
    </AppShell>
  );
}

function BrokerSettings() {
  const [brokerType, setBrokerType] = useState<"oanda" | "metaapi">("metaapi");

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Broker Connection</h2>
      <Card>
        <CardContent className="pt-4 space-y-4">
          <div>
            <Label className="text-xs">Broker Type</Label>
            <select value={brokerType} onChange={e => setBrokerType(e.target.value as any)} className="w-full mt-1 bg-secondary border border-border rounded px-3 py-2 text-sm">
              <option value="metaapi">MetaAPI (MT4/MT5)</option>
              <option value="oanda">OANDA</option>
            </select>
          </div>
          <div>
            <Label className="text-xs">API Key / Token</Label>
            <Input type="password" placeholder="Enter your API key" className="mt-1" />
          </div>
          <div>
            <Label className="text-xs">Account ID</Label>
            <Input placeholder="Enter account ID" className="mt-1" />
          </div>
          <button
            onClick={() => toast.success("Connection settings saved")}
            className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm font-medium hover:bg-primary/90"
          >
            Save Connection
          </button>
        </CardContent>
      </Card>
    </div>
  );
}

function RiskSettings() {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Risk Management</h2>
      <Card>
        <CardContent className="pt-4 space-y-4">
          {[
            { label: "Max Risk per Trade (%)", defaultVal: "1.0" },
            { label: "Max Daily Drawdown (%)", defaultVal: "3.0" },
            { label: "Max Open Positions", defaultVal: "5" },
            { label: "Default Risk:Reward", defaultVal: "3.0" },
          ].map(f => (
            <div key={f.label}>
              <Label className="text-xs">{f.label}</Label>
              <Input type="number" defaultValue={f.defaultVal} className="mt-1" />
            </div>
          ))}
          <button
            onClick={() => toast.success("Risk settings saved")}
            className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm font-medium hover:bg-primary/90"
          >
            Save Risk Settings
          </button>
        </CardContent>
      </Card>
    </div>
  );
}

function PreferencesSettings() {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Preferences</h2>
      <Card>
        <CardContent className="pt-4 space-y-4">
          {[
            { label: "Show desktop notifications", defaultChecked: true },
            { label: "Sound alerts on trade execution", defaultChecked: true },
            { label: "Auto-refresh dashboard", defaultChecked: true },
            { label: "Compact mode", defaultChecked: false },
          ].map(pref => (
            <div key={pref.label} className="flex items-center justify-between">
              <Label className="text-sm">{pref.label}</Label>
              <Switch defaultChecked={pref.defaultChecked} />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function ShortcutsSettings() {
  const shortcuts = [
    { key: "Ctrl + D", action: "Go to Dashboard" },
    { key: "Ctrl + C", action: "Go to Chart" },
    { key: "Ctrl + J", action: "Go to Journal" },
    { key: "Ctrl + B", action: "Go to Backtest" },
    { key: "Ctrl + S", action: "Go to Settings" },
    { key: "Ctrl + /", action: "Toggle sidebar" },
    { key: "Esc", action: "Close modal / panel" },
  ];

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Keyboard Shortcuts</h2>
      <Card>
        <CardContent className="pt-4">
          <div className="space-y-2">
            {shortcuts.map(s => (
              <div key={s.key} className="flex items-center justify-between py-2 border-b border-border/30 last:border-0">
                <span className="text-sm text-muted-foreground">{s.action}</span>
                <kbd className="px-2 py-1 bg-secondary rounded text-xs font-mono">{s.key}</kbd>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AboutSettings() {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">About</h2>
      <Card>
        <CardContent className="pt-4 space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">App</span>
            <span>SMC Trading Dashboard</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Version</span>
            <span>2.0.0</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Stack</span>
            <span>React + Lovable Cloud</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Strategy</span>
            <span>Smart Money Concepts (ICT)</span>
          </div>
          <p className="text-xs text-muted-foreground mt-4 pt-4 border-t border-border">
            Built for professional forex & crypto traders using ICT/SMC methodologies.
            This dashboard provides real-time monitoring, analysis, and journaling — the trading bot runs independently.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
