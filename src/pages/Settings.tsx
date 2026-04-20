import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Settings, Link2, Shield, Palette, Info, Plus, Trash2, Zap, Sun, Moon, Monitor, Wrench, List, Copy, Wand2 } from "lucide-react";
import { brokerApi, settingsApi } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/contexts/ThemeContext";
import { BotConfigModal } from "@/components/BotConfigModal";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";

type SettingsTab = "risk" | "bot" | "preferences" | "about";

const TABS: { id: SettingsTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "risk", label: "Risk Management", icon: Shield },
  { id: "bot", label: "Bot Configuration", icon: Zap },
  { id: "preferences", label: "Preferences", icon: Palette },
  { id: "about", label: "About", icon: Info },
];


export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("risk");
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
          <a href="/brokers" className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded text-muted-foreground hover:text-foreground hover:bg-secondary/50">
            <Link2 className="h-4 w-4" />Broker Connections →
          </a>
          <button onClick={() => signOut()} className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded text-destructive hover:bg-destructive/10 mt-4">Sign out</button>
        </div>
        <div className="flex-1 max-w-2xl">
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
  const [symbolSuffix, setSymbolSuffix] = useState("");
  const [symbolOverrides, setSymbolOverrides] = useState<Record<string, string>>({});
  const [newOverrideSymbol, setNewOverrideSymbol] = useState("");
  const [newOverrideSuffix, setNewOverrideSuffix] = useState("");
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState<any>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSuffix, setEditSuffix] = useState("");
  const [editOverrides, setEditOverrides] = useState<Record<string, string>>({});
  const [editNewSymbol, setEditNewSymbol] = useState("");
  const [editNewSuffix, setEditNewSuffix] = useState("");
  const [symbolsDialogOpen, setSymbolsDialogOpen] = useState(false);
  const [symbolsConnName, setSymbolsConnName] = useState("");
  const [symbolsData, setSymbolsData] = useState<any>(null);
  const [symbolsFilter, setSymbolsFilter] = useState("");
  const [commissionPreset, setCommissionPreset] = useState<string>("0");
  const [customCommission, setCustomCommission] = useState("");

  const { data: connections = [] } = useQuery({ queryKey: ["broker-connections"], queryFn: () => brokerApi.list() });

  const createMutation = useMutation({
    mutationFn: () => brokerApi.create({ broker_type: brokerType, display_name: displayName || brokerType, api_key: apiKey, account_id: accountId, is_live: isLive, symbol_suffix: symbolSuffix, symbol_overrides: symbolOverrides, commission_per_lot: commissionPreset === "custom" ? parseFloat(customCommission || "0") : parseFloat(commissionPreset) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["broker-connections"] }); toast.success("Connection saved"); setApiKey(""); setAccountId(""); setDisplayName(""); setSymbolSuffix(""); setSymbolOverrides({}); setCommissionPreset("0"); setCustomCommission(""); },
    onError: (e: any) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => brokerApi.delete(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["broker-connections"] }); toast.success("Connection removed"); },
  });

  const updateMutation = useMutation({
    mutationFn: (data: { id: string; symbol_suffix: string; symbol_overrides: Record<string, string> }) =>
      brokerApi.update(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["broker-connections"] }); toast.success("Connection updated"); setEditingId(null); },
    onError: (e: any) => toast.error(e.message),
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => brokerApi.test(id),
    onSuccess: (data: any) => {
      // OANDA flow
      if (data.balance !== undefined) {
        toast.success(`Connected! Balance: ${data.balance} ${data.currency || ""}`);
        return;
      }
      // MetaAPI multi-region report
      if (Array.isArray(data.regions)) {
        const lines = data.regions.map((r: any) =>
          `${r.ok ? "✓" : "✗"} ${r.region}${r.ok ? ` (${r.candleCount} candle)` : ` — ${r.error || `HTTP ${r.status}`}`}`
        ).join("\n");
        const header = data.success
          ? `✓ ${data.name || "MetaAPI"} reachable on "${data.reachableRegion}"`
          : `✗ ${data.name || "Account exists"} but no region serves data`;
        const meta = [data.state, data.connectionStatus, data.configuredRegion && `cfg: ${data.configuredRegion}`].filter(Boolean).join(" · ");
        const body = `${meta ? meta + "\n" : ""}${lines}${data.hint ? `\n\n${data.hint}` : ""}`;
        if (data.success) toast.success(header, { description: body, duration: 12000 });
        else toast.error(header, { description: body, duration: 15000 });
        return;
      }
      // Generic fallback
      if (data.success === false) {
        toast.error(`✗ ${data.error || "Test failed"}`, { description: data.hint, duration: 12000 });
        return;
      }
      toast.success(`Connected! ${data.name || ""} — ${data.connectionStatus || data.state || "OK"}`);
    },
    onError: (e: any) => toast.error(`Test failed: ${e.message}`),
  });

  const listSymbolsMutation = useMutation({
    mutationFn: (id: string) => brokerApi.listSymbols(id),
    onSuccess: (data: any) => {
      if (!data?.success) {
        toast.error(`Symbols list failed`, { description: data?.error || "Unknown error", duration: 10000 });
        return;
      }
      setSymbolsData(data);
      setSymbolsDialogOpen(true);
    },
    onError: (e: any) => toast.error(`Symbols list failed: ${e.message}`),
  });

  const autoMapMutation = useMutation({
    mutationFn: (id: string) => brokerApi.autoMapSymbols(id),
    onSuccess: (data: any) => {
      if (!data?.success) {
        toast.error("Auto-map failed", { description: data?.error || "Unknown error" });
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["broker-connections"] });
      toast.success(`Mapped ${data.mapped} pairs`, {
        description: data.unmapped?.length
          ? `Unmapped: ${data.unmapped.slice(0, 5).join(", ")}${data.unmapped.length > 5 ? "…" : ""}`
          : "All canonical pairs found on broker",
        duration: 8000,
      });
    },
    onError: (e: any) => toast.error(`Auto-map failed: ${e.message}`),
  });

  const openSymbols = (id: string, name: string) => {
    setSymbolsConnName(name);
    setSymbolsFilter("");
    setSymbolsData(null);
    setSymbolsDialogOpen(true);
    listSymbolsMutation.mutate(id);
  };


  const checkStatus = async (connectionId: string, name: string) => {
    const t = toast.loading(`Checking ${name}...`);
    try {
      const { data, error } = await supabase.functions.invoke("broker-execute", {
        body: { action: "connection_status", connectionId },
      });
      if (error) throw error;
      toast.dismiss(t);
      if (!data?.ok) {
        toast.error(`✗ ${name}: ${data?.error || "status check failed"}${data?.details ? ` — ${data.details}` : ""}`, { duration: 8000 });
        return;
      }
      const { state, connectionStatus, ready, region, server } = data;
      const meta = [region && `region: ${region}`, server && `server: ${server}`].filter(Boolean).join(" · ");
      if (ready) {
        toast.success(`✓ ${name} — DEPLOYED + CONNECTED${meta ? ` (${meta})` : ""}`, { duration: 6000 });
      } else if (state === "DEPLOYED") {
        toast.warning(`⚠ ${name} — Deployed but ${connectionStatus}. Check broker login/credentials.${meta ? ` (${meta})` : ""}`, { duration: 10000 });
      } else {
        toast.error(`✗ ${name} — state: ${state}, connection: ${connectionStatus}. Deploy the account in your MetaAPI dashboard.`, { duration: 10000 });
      }
    } catch (e: any) {
      toast.dismiss(t);
      toast.error(`Status check failed: ${e.message}`);
    }
  };

  // Normalize override KEYS consistently (uppercase, strip slashes/spaces/dots/dashes/underscores).
  // VALUES (broker symbol) are kept exactly as the user typed them.
  const normalizeOverrideKey = (s: string) => s.trim().toUpperCase().replace(/[\s/._-]/g, "");

  const validateBrokerSymbol = async (connectionId: string, appSymbol: string, brokerSymbol?: string) => {
    const t = toast.loading(`Validating ${brokerSymbol || appSymbol}...`);
    try {
      const { data, error } = await supabase.functions.invoke("broker-execute", {
        body: { action: "validate_symbol", connectionId, symbol: appSymbol, brokerSymbol },
      });
      if (error) throw error;
      toast.dismiss(t);
      if (data?.ok) toast.success(`✓ ${appSymbol} → ${data.brokerSymbol}`);
      else toast.error(`✗ ${data?.brokerSymbol || brokerSymbol || appSymbol}: ${data?.error || "not found at broker"}`);
    } catch (e: any) {
      toast.dismiss(t);
      toast.error(`Validation failed: ${e.message}`);
    }
  };

  const addOverride = () => {
    if (!newOverrideSymbol.trim() || !newOverrideSuffix.trim()) return;
    setSymbolOverrides(prev => ({ ...prev, [normalizeOverrideKey(newOverrideSymbol)]: newOverrideSuffix.trim() }));
    setNewOverrideSymbol("");
    setNewOverrideSuffix("");
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Broker Connections</h2>
      {(connections as any[]).map((c: any) => {
        const isEditing = editingId === c.id;
        return (
        <Card key={c.id}>
          <CardContent className="pt-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-sm truncate">{c.display_name}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {c.broker_type.toUpperCase()} · {c.account_id} · {c.is_live ? "Live" : "Demo"}
                  {c.symbol_suffix ? ` · Suffix: "${c.symbol_suffix}"` : ""}
                </p>
                {!isEditing && c.symbol_overrides && Object.keys(c.symbol_overrides).length > 0 && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Mappings: {Object.entries(c.symbol_overrides).map(([sym, brokerSym]) => `${sym} → ${brokerSym as string}`).join(", ")}
                  </p>
                )}
              </div>
              <div className="flex gap-2 shrink-0">
                {!isEditing && (
                  <Button size="sm" variant="outline" onClick={() => { setEditingId(c.id); setEditSuffix(c.symbol_suffix || ""); setEditOverrides(c.symbol_overrides || {}); }} title="Edit symbol suffix">
                    Edit
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => { setSelectedConnection(c); setConfigModalOpen(true); }} title="Edit bot config for this connection">
                  <Wrench className="h-3 w-3" />
                </Button>
                <Button size="sm" variant="outline" onClick={() => checkStatus(c.id, c.display_name)} title="Check broker connection state">Status</Button>
                <Button size="sm" variant="outline" onClick={() => testMutation.mutate(c.id)}>Test</Button>
                {c.broker_type === "metaapi" && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => autoMapMutation.mutate(c.id)} title="Auto-map symbols from broker (strict matcher)" disabled={autoMapMutation.isPending}>
                      <Wand2 className="h-3 w-3 mr-1" />
                      {autoMapMutation.isPending && autoMapMutation.variables === c.id ? "Mapping…" : "Re-map"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => openSymbols(c.id, c.display_name)} title="List all symbols this broker exposes" disabled={listSymbolsMutation.isPending}>
                      <List className="h-3 w-3" />
                    </Button>
                  </>
                )}
                <Button size="sm" variant="destructive" onClick={() => deleteMutation.mutate(c.id)}><Trash2 className="h-3 w-3" /></Button>
              </div>
            </div>

            {isEditing && (
              <div className="space-y-3 border-t border-border pt-3">
                <div>
                  <Label className="text-xs">Default Symbol Suffix</Label>
                  <Input value={editSuffix} onChange={e => setEditSuffix(e.target.value)} placeholder="e.g. .pro" className="mt-1 h-8 text-sm" />
                  <p className="text-[10px] text-muted-foreground mt-1">Appended to all symbols unless remapped below. E.g. EURUSD → EURUSD{editSuffix || '.pro'}</p>
                </div>

                {/* Symbol Mappings */}
                <div className="space-y-2">
                  <Label className="text-xs">Symbol Mappings</Label>
                  <p className="text-[10px] text-muted-foreground">Map app symbols to exact broker symbols. These override the default suffix entirely.</p>
                  {Object.keys(editOverrides).length > 0 && (
                    <div className="border border-border rounded overflow-hidden">
                      <div className="grid grid-cols-[1fr_1fr_32px] gap-2 px-3 py-1.5 bg-secondary/50 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                        <span>App Symbol</span><span>Broker Symbol</span><span></span>
                      </div>
                      {Object.entries(editOverrides).map(([sym, brokerSym]) => (
                        <div key={sym} className="grid grid-cols-[1fr_1fr_auto_32px] gap-2 px-3 py-2 text-xs items-center border-t border-border">
                          <span className="font-mono font-medium">{sym}</span>
                          <span className="font-mono text-primary">{brokerSym as string}</span>
                          <Button variant="outline" size="sm" className="h-6 px-2 text-[10px]" onClick={() => validateBrokerSymbol(c.id, sym, String(brokerSym))}>Validate</Button>
                          <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={() => { const next = { ...editOverrides }; delete next[sym]; setEditOverrides(next); }}><Trash2 className="h-3 w-3" /></Button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Input value={editNewSymbol} onChange={e => setEditNewSymbol(e.target.value)} placeholder="App symbol (e.g. NAS100)" className="h-7 text-xs flex-1" />
                    <Input value={editNewSuffix} onChange={e => setEditNewSuffix(e.target.value)} placeholder="Broker symbol (e.g. USA100)" className="h-7 text-xs flex-1" />
                    <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!editNewSymbol.trim() || !editNewSuffix.trim()} onClick={() => {
                      setEditOverrides(prev => ({ ...prev, [normalizeOverrideKey(editNewSymbol)]: editNewSuffix.trim() }));
                      setEditNewSymbol(""); setEditNewSuffix("");
                    }}>Add</Button>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button size="sm" onClick={() => updateMutation.mutate({ id: c.id, symbol_suffix: editSuffix, symbol_overrides: editOverrides })}>
                    Save Changes
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>Cancel</Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        );
      })}
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
          <div>
            <Label className="text-xs">Default Symbol Suffix (e.g. '.pro', '.raw', 'r')</Label>
            <Input value={symbolSuffix} onChange={e => setSymbolSuffix(e.target.value)} placeholder=".pro" className="mt-1" />
            <p className="text-[10px] text-muted-foreground mt-1">Appended to all symbols unless remapped below. E.g. EURUSD → EURUSD{symbolSuffix || '.pro'}</p>
          </div>
          
          {/* Symbol Mappings */}
          <div className="space-y-2">
            <Label className="text-xs">Symbol Mappings</Label>
            <p className="text-[10px] text-muted-foreground">Map app symbols to exact broker symbols. These override the default suffix entirely.</p>
            
            {Object.keys(symbolOverrides).length > 0 && (
              <div className="border border-border rounded overflow-hidden">
                <div className="grid grid-cols-[1fr_1fr_40px] gap-2 px-3 py-1.5 bg-secondary/50 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  <span>App Symbol</span><span>Broker Symbol</span><span></span>
                </div>
                {Object.entries(symbolOverrides).map(([sym, brokerSym]) => (
                  <div key={sym} className="grid grid-cols-[1fr_1fr_40px] gap-2 px-3 py-2 text-xs items-center border-t border-border">
                    <span className="font-mono font-medium">{sym}</span>
                    <span className="font-mono text-primary">{brokerSym as string}</span>
                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => {
                      const next = { ...symbolOverrides };
                      delete next[sym];
                      setSymbolOverrides(next);
                    }}><Trash2 className="h-3 w-3" /></Button>
                  </div>
                ))}
              </div>
            )}
            
            <div className="flex gap-2">
              <Input value={newOverrideSymbol} onChange={e => setNewOverrideSymbol(e.target.value)} placeholder="App symbol (e.g. NAS100)" className="h-8 text-xs flex-1" />
              <Input value={newOverrideSuffix} onChange={e => setNewOverrideSuffix(e.target.value)} placeholder="Broker symbol (e.g. USA100)" className="h-8 text-xs flex-1" />
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={addOverride} disabled={!newOverrideSymbol.trim() || !newOverrideSuffix.trim()}>Add</Button>
            </div>
          </div>

          <div className="flex items-center gap-2"><Switch checked={isLive} onCheckedChange={setIsLive} /><Label className="text-sm">Live account</Label></div>
          <div>
            <Label className="text-xs">Commission (round-trip per standard lot)</Label>
            <p className="text-[10px] text-muted-foreground mb-1">Set to 0 for spread-only accounts. Auto-detected after first trade if left at 0.</p>
            <select value={commissionPreset} onChange={e => setCommissionPreset(e.target.value)} className="w-full mt-1 bg-secondary border border-border rounded px-3 py-2 text-sm">
              <option value="0">Spread-only ($0/lot)</option>
              <option value="5">ECN Low ($5/lot round-trip)</option>
              <option value="7">ECN Standard ($7/lot round-trip)</option>
              <option value="10">ECN High ($10/lot round-trip)</option>
              <option value="custom">Custom...</option>
            </select>
            {commissionPreset === "custom" && (
              <Input type="number" step="0.5" min="0" max="50" value={customCommission} onChange={e => setCustomCommission(e.target.value)} placeholder="e.g. 6.50" className="mt-2 font-mono text-xs" />
            )}
          </div>
          <Button onClick={() => createMutation.mutate()} disabled={!apiKey || !accountId}>Save Connection</Button>
        </CardContent>
      </Card>

      {/* Per-broker config modal */}
      {selectedConnection && (
        <BotConfigModal
          open={configModalOpen}
          onClose={() => { setConfigModalOpen(false); setSelectedConnection(null); }}
          connectionId={selectedConnection.id}
          connectionName={selectedConnection.display_name}
        />
      )}

      {/* MetaAPI symbols list dialog */}
      <Dialog open={symbolsDialogOpen} onOpenChange={(o) => { setSymbolsDialogOpen(o); if (!o) setSymbolsData(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Broker symbols — {symbolsConnName}</DialogTitle>
            <DialogDescription>
              {listSymbolsMutation.isPending && "Loading symbols from MetaAPI…"}
              {symbolsData && (
                <>Loaded <span className="font-medium text-foreground">{symbolsData.total}</span> symbols from <span className="font-medium text-foreground">{symbolsData.region}</span>. Click any symbol to copy.</>
              )}
            </DialogDescription>
          </DialogHeader>

          {symbolsData && (
            <div className="space-y-3">
              <Input
                placeholder="Filter (e.g. BTC, EUR, XAU)"
                value={symbolsFilter}
                onChange={(e) => setSymbolsFilter(e.target.value)}
                className="h-8 text-sm"
              />
              <ScrollArea className="h-[400px] pr-3">
                {(["crypto", "metals", "indices", "fx", "other"] as const).map((group) => {
                  const list: string[] = (symbolsData.grouped?.[group] || []).filter((s: string) =>
                    !symbolsFilter || s.toLowerCase().includes(symbolsFilter.toLowerCase())
                  );
                  if (list.length === 0) return null;
                  return (
                    <div key={group} className="mb-4">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                        {group} ({list.length})
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {list.map((sym) => (
                          <Badge
                            key={sym}
                            variant="outline"
                            className="cursor-pointer hover:bg-secondary text-xs font-mono gap-1"
                            onClick={() => { navigator.clipboard.writeText(sym); toast.success(`Copied "${sym}"`); }}
                          >
                            {sym}
                            <Copy className="h-2.5 w-2.5 opacity-50" />
                          </Badge>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </ScrollArea>
              <p className="text-[10px] text-muted-foreground">
                💡 Found the right symbol? Add it as a Symbol Mapping (e.g. "BTC/USD" → "{symbolsData.grouped?.crypto?.[0] || "BTCUSD"}") in the connection's Edit panel.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
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
      <BotConfigModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}

type TgChat = { id: string; label: string };

function PreferencesSettings() {
  const { theme, setTheme } = useTheme();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ["user-settings"], queryFn: () => settingsApi.get() });
  const prefs = settings?.preferences_json || {};

  // Normalise: support legacy `telegramChatId` and new `telegramChatIds[]`
  const initialChats: TgChat[] = (() => {
    const list = Array.isArray(prefs.telegramChatIds) ? prefs.telegramChatIds : [];
    if (list.length > 0) return list.map((c: any) => typeof c === "string" ? { id: c, label: "" } : { id: String(c.id ?? ""), label: c.label ?? "" }).filter((c: TgChat) => c.id);
    if (prefs.telegramChatId) return [{ id: String(prefs.telegramChatId), label: "Default" }];
    return [];
  })();

  const [chats, setChats] = useState<TgChat[]>(initialChats);
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");

  useEffect(() => {
    const p = settings?.preferences_json;
    if (!p) return;
    const list = Array.isArray(p.telegramChatIds) ? p.telegramChatIds : [];
    if (list.length > 0) {
      setChats(list.map((c: any) => typeof c === "string" ? { id: c, label: "" } : { id: String(c.id ?? ""), label: c.label ?? "" }).filter((c: TgChat) => c.id));
    } else if (p.telegramChatId) {
      setChats([{ id: String(p.telegramChatId), label: "Default" }]);
    }
  }, [settings]);

  const saveTelegramMutation = useMutation({
    mutationFn: (next: TgChat[]) => settingsApi.upsert(undefined, {
      ...prefs,
      telegramChatIds: next,
      telegramChatId: next[0]?.id || "", // keep legacy field in sync (first ID)
    }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["user-settings"] }); toast.success("Telegram chats saved"); },
    onError: (e: any) => toast.error(e.message),
  });

  const addChat = () => {
    const id = newId.trim();
    if (!id) return;
    if (chats.some(c => c.id === id)) { toast.error("Chat ID already added"); return; }
    const next = [...chats, { id, label: newLabel.trim() || `Chat ${chats.length + 1}` }];
    setChats(next);
    setNewId(""); setNewLabel("");
    saveTelegramMutation.mutate(next);
  };

  const removeChat = (id: string) => {
    const next = chats.filter(c => c.id !== id);
    setChats(next);
    saveTelegramMutation.mutate(next);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Preferences</h2>

      {/* Telegram Notifications */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Telegram Notifications</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">Get trade alerts on Telegram. Send <code>/start</code> to <a href="https://t.me/smc007_bot" target="_blank" className="text-primary underline">@smc007_bot</a>, then add one or more Chat IDs below. Notifications are sent to all of them.</p>

          {chats.length > 0 && (
            <div className="border border-border rounded overflow-hidden">
              <div className="grid grid-cols-[1fr_1.5fr_auto_auto] gap-2 px-3 py-1.5 bg-secondary/50 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                <span>Label</span><span>Chat ID</span><span>Test</span><span></span>
              </div>
              {chats.map(c => (
                <div key={c.id} className="grid grid-cols-[1fr_1.5fr_auto_auto] gap-2 px-3 py-2 text-xs items-center border-t border-border">
                  <span className="font-medium truncate">{c.label || "—"}</span>
                  <span className="font-mono text-primary truncate">{c.id}</span>
                  <TestNotificationButton chatId={c.id} compact />
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => removeChat(c.id)}><Trash2 className="h-3 w-3" /></Button>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2">
            <Label className="text-xs">Add Chat ID</Label>
            <div className="flex gap-2">
              <Input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Label (e.g. Phone)" className="h-8 text-xs flex-1" />
              <Input value={newId} onChange={e => setNewId(e.target.value)} placeholder="Chat ID (e.g. 123456789)" className="h-8 text-xs flex-1" />
              <Button size="sm" className="h-8" onClick={addChat} disabled={!newId.trim()}><Plus className="h-3 w-3" /></Button>
            </div>
          </div>
        </CardContent>
      </Card>

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

function TestNotificationButton({ chatId, compact = false }: { chatId: string; compact?: boolean }) {
  const [isSending, setIsSending] = useState(false);

  const sendTestNotification = async () => {
    setIsSending(true);
    try {
      const { error } = await supabase.functions.invoke('telegram-notify', {
        body: { chat_id: chatId, message: '🔔 <b>Test Notification</b>\n\nYour Telegram notifications are working! You will receive alerts here when trades are placed.' }
      });
      if (error) throw error;
      toast.success(`Test sent to ${chatId}`);
    } catch (e: any) {
      toast.error(`Failed to send: ${e.message}`);
    } finally {
      setIsSending(false);
    }
  };

  if (compact) {
    return (
      <Button variant="outline" size="sm" className="h-6 px-2 text-[10px]" onClick={sendTestNotification} disabled={isSending}>
        {isSending ? '…' : 'Test'}
      </Button>
    );
  }

  return (
    <Button variant="outline" size="sm" onClick={sendTestNotification} disabled={isSending} className="w-full">
      {isSending ? 'Sending...' : '🔔 Send Test Notification'}
    </Button>
  );
}
