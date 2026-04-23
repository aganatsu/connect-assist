import { useState, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Plus, Trash2, Wand2, List, Wrench, Activity, CheckCircle2, XCircle,
  Server, KeyRound, Hash, Copy, RadioTower, ChevronRight, ChevronDown, Zap, Ban,
  Pencil, Check, X as XIcon,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { brokerApi } from "@/lib/api";
import { BotConfigModal } from "@/components/BotConfigModal";
import { supabase } from "@/integrations/supabase/client";

type Connection = {
  id: string;
  broker_type: string;
  display_name: string;
  account_id: string;
  is_live: boolean;
  is_active: boolean;
  symbol_suffix: string;
  symbol_overrides: Record<string, string>;
  created_at?: string;
  commission_per_lot?: number;
  detected_commission_per_lot?: number;
};

type ProbedCandidate = {
  brokerSymbol: string;
  prefix: string;
  suffix: string;
  tradeMode?: string;
  hasLivePrice?: boolean;
  score: number;
};
type ProbeDetails = Record<string, { picked: string; candidates: ProbedCandidate[] }>;

const normalizeOverrideKey = (s: string) => s.trim().toUpperCase().replace(/[\s/._-]/g, "");

export default function BrokersPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [symbolsDialogOpen, setSymbolsDialogOpen] = useState(false);
  const [symbolsData, setSymbolsData] = useState<any>(null);
  const [symbolsFilter, setSymbolsFilter] = useState("");
  // Per-connection probe results from latest auto-map (in-memory only)
  const [probeByConn, setProbeByConn] = useState<Record<string, ProbeDetails>>({});

  const { data: connections = [] } = useQuery<Connection[]>({
    queryKey: ["broker-connections"],
    queryFn: () => brokerApi.list(),
  });

  const selected = useMemo(
    () => connections.find((c) => c.id === selectedId) ?? connections[0] ?? null,
    [connections, selectedId],
  );

  // Auto-select first connection on first load
  if (!selectedId && connections.length > 0 && !showAddForm) {
    setSelectedId(connections[0].id);
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) => brokerApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["broker-connections"] });
      toast.success("Connection removed");
      setSelectedId(null);
    },
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => brokerApi.test(id),
    onSuccess: (data: any) => {
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
      if (data.balance !== undefined) {
        toast.success(`Connected! Balance: ${data.balance} ${data.currency || ""}`);
        return;
      }
      if (data.success === false) {
        toast.error(`✗ ${data.error || "Test failed"}`, { description: data.hint, duration: 12000 });
        return;
      }
      toast.success(`Connected! ${data.name || ""} — ${data.connectionStatus || data.state || "OK"}`);
    },
    onError: (e: any) => toast.error(`Test failed: ${e.message}`),
  });

  const autoMapMutation = useMutation({
    mutationFn: (id: string) => brokerApi.autoMapSymbols(id).then((d: any) => ({ ...d, _connId: id })),
    onSuccess: (data: any) => {
      if (!data?.success) {
        toast.error("Auto-map failed", { description: data?.error || "Unknown error" });
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["broker-connections"] });
      if (data.details && data._connId) {
        setProbeByConn((prev) => ({ ...prev, [data._connId]: data.details as ProbeDetails }));
      }
      const variantsFound = data.details
        ? Object.values(data.details as ProbeDetails).filter((d) => d.candidates.length > 1).length
        : 0;
      toast.success(`Mapped ${data.mapped} pairs`, {
        description: [
          data.unmapped?.length
            ? `Unmapped: ${data.unmapped.slice(0, 5).join(", ")}${data.unmapped.length > 5 ? "…" : ""}`
            : "All canonical pairs found on broker",
          variantsFound > 0 ? `${variantsFound} pair${variantsFound !== 1 ? "s have" : " has"} alternates — pick from dropdown` : null,
        ].filter(Boolean).join(" · "),
        duration: 8000,
      });
    },
    onError: (e: any) => toast.error(`Auto-map failed: ${e.message}`),
  });

  const listSymbolsMutation = useMutation({
    mutationFn: (id: string) => brokerApi.listSymbols(id),
    onSuccess: (data: any) => {
      if (!data?.success) {
        toast.error("Symbols list failed", { description: data?.error || "Unknown error" });
        return;
      }
      setSymbolsData(data);
      setSymbolsDialogOpen(true);
    },
    onError: (e: any) => toast.error(`Symbols list failed: ${e.message}`),
  });

  const checkStatus = async (connectionId: string, name: string) => {
    const t = toast.loading(`Checking ${name}…`);
    try {
      const { data, error } = await supabase.functions.invoke("broker-execute", {
        body: { action: "connection_status", connectionId },
      });
      if (error) throw error;
      toast.dismiss(t);
      if (!data?.ok) {
        toast.error(`✗ ${name}: ${data?.error || "status check failed"}`, { duration: 8000 });
        return;
      }
      const { state, connectionStatus, ready, region, server } = data;
      const meta = [region && `region: ${region}`, server && `server: ${server}`].filter(Boolean).join(" · ");
      if (ready) toast.success(`✓ ${name} — DEPLOYED + CONNECTED${meta ? ` (${meta})` : ""}`);
      else if (state === "DEPLOYED") toast.warning(`⚠ ${name} — Deployed but ${connectionStatus}.`);
      else toast.error(`✗ ${name} — state: ${state}, connection: ${connectionStatus}.`);
    } catch (e: any) {
      toast.dismiss(t);
      toast.error(`Status check failed: ${e.message}`);
    }
  };

  return (
    <AppShell>
      <div className="h-full flex flex-col">
        {/* Page header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <Server className="h-5 w-5 text-primary" /> Brokers
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Manage broker connections and symbol mappings
            </p>
          </div>
          <Button size="sm" onClick={() => { setShowAddForm(true); setSelectedId(null); }}>
            <Plus className="h-4 w-4 mr-1.5" /> Add Connection
          </Button>
        </div>

        {/* Split view */}
        <div className="flex-1 flex flex-col md:flex-row gap-4 min-h-0">
          {/* LEFT: connection list */}
          <Card className="w-full md:w-64 shrink-0 flex flex-col overflow-hidden max-h-48 md:max-h-none">
            <div className="px-3 py-2 border-b border-border">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Connections ({connections.length})
              </p>
            </div>
            <ScrollArea className="flex-1">
              <div className="p-1.5 space-y-0.5">
                {connections.length === 0 && !showAddForm && (
                  <div className="p-6 text-center text-xs text-muted-foreground">
                    No brokers yet. Click <span className="text-foreground font-medium">Add Connection</span> to get started.
                  </div>
                )}
                {connections.map((c) => {
                  const isSelected = !showAddForm && selected?.id === c.id;
                  return (
                    <button
                      key={c.id}
                      onClick={() => { setShowAddForm(false); setSelectedId(c.id); }}
                      className={`w-full text-left px-2.5 py-2 rounded transition-colors group ${
                        isSelected
                          ? "bg-primary/10 text-primary"
                          : "hover:bg-secondary/50 text-foreground"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                          c.is_active ? "bg-success" : "bg-muted-foreground"
                        }`} />
                        <span className="text-sm font-medium truncate flex-1">{c.display_name}</span>
                        <ChevronRight className={`h-3 w-3 transition-opacity ${isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-50"}`} />
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-0.5 ml-3.5">
                        {c.broker_type.toUpperCase()} · {c.is_live ? "Live" : "Demo"}
                      </p>
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          </Card>

          {/* RIGHT: detail panel */}
          <div className="flex-1 min-w-0 overflow-auto min-h-0">
            {showAddForm || connections.length === 0 ? (
              <AddConnectionForm
                onCreated={(newId) => {
                  setShowAddForm(false);
                  setSelectedId(newId);
                }}
                onCancel={() => setShowAddForm(false)}
              />
            ) : selected ? (
              <ConnectionDetail
                connection={selected}
                probeDetails={probeByConn[selected.id]}
                onTest={() => testMutation.mutate(selected.id)}
                onCheckStatus={() => checkStatus(selected.id, selected.display_name)}
                onAutoMap={() => autoMapMutation.mutate(selected.id)}
                onListSymbols={() => listSymbolsMutation.mutate(selected.id)}
                onConfigOpen={() => setConfigModalOpen(true)}
                onDelete={() => {
                  if (confirm(`Delete "${selected.display_name}"?`)) deleteMutation.mutate(selected.id);
                }}
                isAutoMapping={autoMapMutation.isPending}
                isListing={listSymbolsMutation.isPending}
                isTesting={testMutation.isPending}
              />
            ) : null}
          </div>
        </div>

        {/* Per-broker bot config */}
        {selected && (
          <BotConfigModal
            open={configModalOpen}
            onClose={() => setConfigModalOpen(false)}
            connectionId={selected.id}
            connectionName={selected.display_name}
          />
        )}

        {/* Symbols dialog */}
        <Dialog open={symbolsDialogOpen} onOpenChange={(o) => { setSymbolsDialogOpen(o); if (!o) setSymbolsData(null); }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Broker symbols — {selected?.display_name}</DialogTitle>
              <DialogDescription>
                {symbolsData && (
                  <>Loaded <span className="font-medium text-foreground">{symbolsData.total}</span> symbols from <span className="font-medium text-foreground">{symbolsData.region}</span>. Click any to copy.</>
                )}
              </DialogDescription>
            </DialogHeader>
            {symbolsData && (
              <div className="space-y-3">
                <Input placeholder="Filter (e.g. BTC, EUR, XAU)" value={symbolsFilter} onChange={(e) => setSymbolsFilter(e.target.value)} className="h-8 text-sm" />
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
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </AppShell>
  );
}

// ─── Connection detail panel ─────────────────────────────────────────
function ConnectionDetail({
  connection: c, probeDetails, onTest, onCheckStatus, onAutoMap, onListSymbols,
  onConfigOpen, onDelete, isAutoMapping, isListing, isTesting,
}: {
  connection: Connection;
  probeDetails?: ProbeDetails;
  onTest: () => void;
  onCheckStatus: () => void;
  onAutoMap: () => void;
  onListSymbols: () => void;
  onConfigOpen: () => void;
  onDelete: () => void;
  isAutoMapping: boolean;
  isListing: boolean;
  isTesting: boolean;
}) {
  const queryClient = useQueryClient();
  const [editSuffix, setEditSuffix] = useState(c.symbol_suffix || "");
  const [editOverrides, setEditOverrides] = useState<Record<string, string>>(c.symbol_overrides || {});
  const [newSym, setNewSym] = useState("");
  const [newBrokerSym, setNewBrokerSym] = useState("");
  const [editCommission, setEditCommission] = useState<string>(String(c.commission_per_lot || 0));
  const [editCustomCommission, setEditCustomCommission] = useState("");
  const [dirty, setDirty] = useState(false);
  // Probe results for manually-typed broker symbols (keyed by broker symbol string).
  // Auto-populated by validate-on-save; merged with auto-map probe data for badge rendering.
  const [manualProbes, setManualProbes] = useState<Record<string, { tradeMode?: string; hasLivePrice?: boolean } | null>>({});
  // Tracks which rows the user manually edited/added since last save (so we know what to validate).
  const [manuallyTouched, setManuallyTouched] = useState<Set<string>>(new Set());
  // Confirm dialog state for "save anyway" when probe finds bad symbols.
  const [warnDialog, setWarnDialog] = useState<{ open: boolean; bad: { sym: string; brokerSym: string; reason: string }[] }>({ open: false, bad: [] });
  const [validating, setValidating] = useState(false);
  // Inline edit state: which symbol row is being edited, and the current input value
  const [editingSymbol, setEditingSymbol] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  // Reset local state when selection changes
  useMemo(() => {
    setEditSuffix(c.symbol_suffix || "");
    setEditOverrides(c.symbol_overrides || {});
    setEditCommission(String(c.commission_per_lot || 0));
    setEditCustomCommission("");
    setManualProbes({});
    setManuallyTouched(new Set());
    setEditingSymbol(null);
    setEditingValue("");
    setDirty(false);
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id]);

  const commissionValue = editCommission === "custom" ? parseFloat(editCustomCommission || "0") : parseFloat(editCommission);

  const updateMutation = useMutation({
    mutationFn: () => brokerApi.update({ id: c.id, symbol_suffix: editSuffix, symbol_overrides: editOverrides, commission_per_lot: commissionValue }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["broker-connections"] });
      toast.success("Saved");
      setDirty(false);
      setManuallyTouched(new Set());
    },
    onError: (e: any) => toast.error(e.message),
  });

  const isMetaApi = c.broker_type === "metaapi";

  // Build a lookup: broker symbol → probe info (from auto-map probe details OR manual probe).
  const probeBySymbol = useMemo(() => {
    const out: Record<string, { tradeMode?: string; hasLivePrice?: boolean }> = {};
    if (probeDetails) {
      for (const info of Object.values(probeDetails)) {
        for (const cand of info.candidates) {
          out[cand.brokerSymbol] = { tradeMode: cand.tradeMode, hasLivePrice: cand.hasLivePrice };
        }
      }
    }
    for (const [sym, info] of Object.entries(manualProbes)) {
      if (info) out[sym] = info;
    }
    return out;
  }, [probeDetails, manualProbes]);

  // Save flow: probe any unprobed/manually-touched rows, warn on bad, then save.
  async function handleSave() {
    if (!isMetaApi) { updateMutation.mutate(); return; }

    // Symbols we don't yet have probe data for (or rows the user just edited).
    const toValidate = Array.from(new Set(
      Object.entries(editOverrides)
        .filter(([sym, brokerSym]) =>
          brokerSym && (manuallyTouched.has(sym) || !probeBySymbol[brokerSym])
        )
        .map(([, brokerSym]) => brokerSym)
    ));

    let freshProbes: Record<string, { tradeMode?: string; hasLivePrice?: boolean } | null> = {};
    if (toValidate.length) {
      setValidating(true);
      try {
        const res: any = await brokerApi.probeSymbols(c.id, toValidate);
        if (res?.success) {
          freshProbes = res.results || {};
          setManualProbes((prev) => ({ ...prev, ...freshProbes }));
        } else {
          toast.warning("Couldn't validate symbols", { description: res?.error || "Saving without validation" });
        }
      } catch (e: any) {
        toast.warning("Validation failed", { description: e.message });
      } finally {
        setValidating(false);
      }
    }

    // Merge fresh + existing probe data and check for bad symbols across ALL rows.
    const fullProbeMap = { ...probeBySymbol, ...freshProbes };
    const bad: { sym: string; brokerSym: string; reason: string }[] = [];
    for (const [sym, brokerSym] of Object.entries(editOverrides)) {
      if (!brokerSym) continue;
      const info = fullProbeMap[brokerSym];
      if (!info) continue; // unknown — don't block
      const mode = (info.tradeMode || "").toUpperCase();
      const modeBad = mode === "DISABLED" || mode === "CLOSE_ONLY";
      const noQuote = info.hasLivePrice === false;
      if (modeBad || noQuote) {
        bad.push({
          sym, brokerSym,
          reason: [modeBad && `tradeMode=${mode || "?"}`, noQuote && "no live quote"].filter(Boolean).join(", "),
        });
      }
    }

    if (bad.length) {
      setWarnDialog({ open: true, bad });
      return;
    }
    updateMutation.mutate();
  }

  const overrideCount = Object.keys(editOverrides).length;

  return (
    <div className="space-y-4">
      {/* Header card */}
      <Card>
        <CardContent className="pt-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-lg font-bold truncate">{c.display_name}</h2>
                {c.is_live ? (
                  <Badge variant="destructive" className="h-5 text-[10px]">LIVE</Badge>
                ) : (
                  <Badge variant="secondary" className="h-5 text-[10px]">DEMO</Badge>
                )}
                {c.is_active ? (
                  <Badge variant="outline" className="h-5 text-[10px] gap-1">
                    <CheckCircle2 className="h-2.5 w-2.5 text-success" /> Active
                  </Badge>
                ) : (
                  <Badge variant="outline" className="h-5 text-[10px] gap-1">
                    <XCircle className="h-2.5 w-2.5 text-muted-foreground" /> Inactive
                  </Badge>
                )}
              </div>
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
                <Field icon={Server} label="Broker" value={c.broker_type.toUpperCase()} />
                <Field icon={Hash} label="Account" value={c.account_id} mono />
                <Field icon={KeyRound} label="Suffix" value={c.symbol_suffix || "—"} mono />
                <Field icon={RadioTower} label="Mappings" value={`${overrideCount} symbol${overrideCount !== 1 ? "s" : ""}`} />
                <Field icon={Zap} label="Commission" value={
                  c.commission_per_lot
                    ? `$${c.commission_per_lot}/lot (manual)`
                    : c.detected_commission_per_lot
                      ? `$${c.detected_commission_per_lot.toFixed(2)}/lot (auto-detected)`
                      : "$0 (spread-only)"
                } />
              </div>
            </div>
          </div>

          {/* Action toolbar */}
          <div className="mt-4 flex flex-wrap gap-2 pt-4 border-t border-border">
            <Button size="sm" variant="outline" onClick={onTest} disabled={isTesting}>
              <Activity className="h-3.5 w-3.5 mr-1.5" /> Test
            </Button>
            <Button size="sm" variant="outline" onClick={onCheckStatus}>
              <RadioTower className="h-3.5 w-3.5 mr-1.5" /> Status
            </Button>
            {isMetaApi && (
              <>
                <Button size="sm" variant="outline" onClick={onAutoMap} disabled={isAutoMapping}>
                  <Wand2 className="h-3.5 w-3.5 mr-1.5" />
                  {isAutoMapping ? "Mapping…" : "Auto-map symbols"}
                </Button>
                <Button size="sm" variant="outline" onClick={onListSymbols} disabled={isListing}>
                  <List className="h-3.5 w-3.5 mr-1.5" /> Browse symbols
                </Button>
              </>
            )}
            <Button size="sm" variant="outline" onClick={onConfigOpen}>
              <Wrench className="h-3.5 w-3.5 mr-1.5" /> Bot config
            </Button>
            <div className="flex-1" />
            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive hover:bg-destructive/10" onClick={onDelete}>
              <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Delete
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Symbol mapping editor */}
      <Card>
        <CardContent className="pt-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold">Symbol Configuration</h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Maps app symbols (EUR/USD) to broker-specific symbols (EURUSDb, #BTCUSDr).
              Use <span className="text-foreground font-medium">Auto-map</span> above to fill these in automatically.
            </p>
          </div>

          <div>
            <Label className="text-xs">Default suffix</Label>
            <Input
              value={editSuffix}
              onChange={(e) => { setEditSuffix(e.target.value); setDirty(true); }}
              placeholder="e.g. b, .raw, .pro"
              className="mt-1 h-8 text-sm font-mono"
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              Appended to symbols not explicitly mapped. EURUSD → EURUSD<span className="text-foreground">{editSuffix || "<suffix>"}</span>
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Symbol mappings ({overrideCount})</Label>
            </div>
            {overrideCount > 0 ? (
              <div className="border border-border rounded overflow-hidden">
                <div className="grid grid-cols-[28px_1fr_1fr_64px] gap-2 px-3 py-1.5 bg-secondary/40 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  <span>#</span><span>App</span><span>Broker</span><span></span>
                </div>
                <ScrollArea className="h-72">
                  {Object.entries(editOverrides).map(([sym, brokerSym], idx) => {
                    // Find probe candidates for this row by matching normalized keys
                    const candidates = (() => {
                      if (!probeDetails) return [];
                      for (const [canonical, info] of Object.entries(probeDetails)) {
                        if (normalizeOverrideKey(canonical) === normalizeOverrideKey(sym)) {
                          return info.candidates;
                        }
                      }
                      return [];
                    })();
                    const hasAlternates = candidates.length > 1;

                    return (
                      <div key={sym} className="grid grid-cols-[28px_1fr_1fr_64px] gap-2 px-3 py-1.5 text-xs items-center border-t border-border">
                        <span className="font-mono text-[10px] text-muted-foreground tabular-nums">{idx + 1}</span>
                        <span className="font-mono font-medium">{sym}</span>
                        {editingSymbol === sym ? (
                          /* ── Inline edit mode ── */
                          <div className="flex items-center gap-1 min-w-0">
                            <Input
                              ref={editInputRef}
                              value={editingValue}
                              onChange={(e) => setEditingValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && editingValue.trim()) {
                                  setEditOverrides((prev) => ({ ...prev, [sym]: editingValue.trim() }));
                                  setManuallyTouched((prev) => new Set(prev).add(sym));
                                  setDirty(true);
                                  setEditingSymbol(null);
                                } else if (e.key === "Escape") {
                                  setEditingSymbol(null);
                                }
                              }}
                              className="h-6 text-xs font-mono flex-1 min-w-0 px-1.5"
                              autoFocus
                            />
                            <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-success hover:text-success" onClick={() => {
                              if (editingValue.trim()) {
                                setEditOverrides((prev) => ({ ...prev, [sym]: editingValue.trim() }));
                                setManuallyTouched((prev) => new Set(prev).add(sym));
                                setDirty(true);
                              }
                              setEditingSymbol(null);
                            }}>
                              <Check className="h-3 w-3" />
                            </Button>
                            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setEditingSymbol(null)}>
                              <XIcon className="h-3 w-3" />
                            </Button>
                          </div>
                        ) : hasAlternates ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button className="flex items-center gap-1.5 font-mono text-primary truncate hover:bg-secondary/50 rounded px-1.5 py-0.5 -mx-1.5 text-left">
                                <span className="truncate">{brokerSym}</span>
                                <Badge variant="outline" className="h-4 px-1 text-[9px] shrink-0">
                                  {candidates.length}
                                </Badge>
                                <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="w-64">
                              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                Variants for {sym}
                              </DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              {candidates.map((cand) => {
                                const isPicked = cand.brokerSymbol === brokerSym;
                                return (
                                  <DropdownMenuItem
                                    key={cand.brokerSymbol}
                                    onClick={() => {
                                      if (cand.brokerSymbol === brokerSym) return;
                                      setEditOverrides((prev) => ({ ...prev, [sym]: cand.brokerSymbol }));
                                      setDirty(true);
                                    }}
                                    className="flex items-center justify-between gap-2 cursor-pointer"
                                  >
                                    <div className="flex items-center gap-1.5 min-w-0">
                                      {isPicked && <CheckCircle2 className="h-3 w-3 text-success shrink-0" />}
                                      <span className={`font-mono text-xs truncate ${isPicked ? "font-semibold" : ""}`}>
                                        {cand.brokerSymbol}
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0">
                                      <TradeModeBadge tradeMode={cand.tradeMode} />
                                      {cand.hasLivePrice ? (
                                        <Badge variant="outline" className="h-4 px-1 text-[9px] gap-0.5 border-success/40 text-success">
                                          <Zap className="h-2 w-2" /> live
                                        </Badge>
                                      ) : (
                                        <Badge variant="outline" className="h-4 px-1 text-[9px] gap-0.5 text-muted-foreground">
                                          <Ban className="h-2 w-2" /> no quote
                                        </Badge>
                                      )}
                                    </div>
                                  </DropdownMenuItem>
                                );
                              })}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : (
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="font-mono text-primary truncate">{brokerSym}</span>
                            {(() => {
                              const info = probeBySymbol[brokerSym];
                              if (!info) return null;
                              return (
                                <div className="flex items-center gap-1 shrink-0">
                                  <TradeModeBadge tradeMode={info.tradeMode} />
                                  {info.hasLivePrice ? (
                                    <Badge variant="outline" className="h-4 px-1 text-[9px] gap-0.5 border-success/40 text-success">
                                      <Zap className="h-2 w-2" /> live
                                    </Badge>
                                  ) : (
                                    <Badge variant="outline" className="h-4 px-1 text-[9px] gap-0.5 text-muted-foreground">
                                      <Ban className="h-2 w-2" /> no quote
                                    </Badge>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        )}
                        {/* Action buttons: edit + delete */}
                        <div className="flex items-center gap-0.5">
                          {editingSymbol !== sym && (
                            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" title="Edit broker symbol" onClick={() => {
                              setEditingSymbol(sym);
                              setEditingValue(brokerSym);
                            }}>
                              <Pencil className="h-3 w-3" />
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => {
                            const next = { ...editOverrides }; delete next[sym]; setEditOverrides(next); setDirty(true);
                            if (editingSymbol === sym) setEditingSymbol(null);
                          }}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </ScrollArea>
              </div>
            ) : (
              <div className="border border-dashed border-border rounded p-4 text-center text-xs text-muted-foreground">
                No mappings yet. Click <span className="text-foreground font-medium">Auto-map symbols</span> to discover them automatically.
              </div>
            )}
            <div className="flex gap-2">
              <Input value={newSym} onChange={(e) => setNewSym(e.target.value)} placeholder="App symbol (EUR/USD)" className="h-8 text-xs flex-1 font-mono" />
              <Input value={newBrokerSym} onChange={(e) => setNewBrokerSym(e.target.value)} placeholder="Broker symbol (EURUSDb)" className="h-8 text-xs flex-1 font-mono" />
              <Button
                variant="outline" size="sm" className="h-8"
                disabled={!newSym.trim() || !newBrokerSym.trim()}
                onClick={() => {
                  const key = normalizeOverrideKey(newSym);
                  setEditOverrides((prev) => ({ ...prev, [key]: newBrokerSym.trim() }));
                  setManuallyTouched((prev) => new Set(prev).add(key));
                  setNewSym(""); setNewBrokerSym(""); setDirty(true);
                }}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {dirty && (
            <div className="flex gap-2 pt-2 border-t border-border">
              <Button size="sm" onClick={handleSave} disabled={updateMutation.isPending || validating}>
                {validating ? "Validating…" : updateMutation.isPending ? "Saving…" : isMetaApi ? "Validate & save" : "Save changes"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => {
                setEditSuffix(c.symbol_suffix || "");
                setEditOverrides(c.symbol_overrides || {});
                setManuallyTouched(new Set());
                setDirty(false);
              }}>Discard</Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Commission settings */}
      <Card>
        <CardContent className="pt-5 space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Commission Settings</h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Round-trip commission per standard lot. Set to 0 for spread-only accounts.
              {c.detected_commission_per_lot ? (
                <span className="block mt-1 text-primary">Auto-detected: ${c.detected_commission_per_lot.toFixed(2)}/lot from last trade</span>
              ) : null}
            </p>
          </div>
          <div>
            <Label className="text-xs">Commission preset</Label>
            <select
              value={["0", "5", "7", "10"].includes(editCommission) ? editCommission : "custom"}
              onChange={(e) => {
                setEditCommission(e.target.value);
                if (e.target.value !== "custom") setEditCustomCommission("");
                setDirty(true);
              }}
              className="w-full mt-1 bg-secondary border border-border rounded px-3 py-2 text-sm"
            >
              <option value="0">Spread-only ($0/lot)</option>
              <option value="5">ECN Low ($5/lot round-trip)</option>
              <option value="7">ECN Standard ($7/lot round-trip)</option>
              <option value="10">ECN High ($10/lot round-trip)</option>
              <option value="custom">Custom...</option>
            </select>
            {!["0", "5", "7", "10"].includes(editCommission) && (
              <Input
                type="number"
                step="0.5"
                min="0"
                max="50"
                value={editCommission === "custom" ? editCustomCommission : editCommission}
                onChange={(e) => {
                  setEditCommission("custom");
                  setEditCustomCommission(e.target.value);
                  setDirty(true);
                }}
                placeholder="e.g. 6.50"
                className="mt-2 font-mono text-xs"
              />
            )}
          </div>
        </CardContent>
      </Card>

      {/* Warn-confirm dialog: bad symbols detected by tradability probe */}
      <Dialog open={warnDialog.open} onOpenChange={(o) => setWarnDialog((prev) => ({ ...prev, open: o }))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Ban className="h-4 w-4 text-destructive" /> Untradable symbols detected
            </DialogTitle>
            <DialogDescription>
              The following broker symbols may not work for live trading. Save anyway, or go back and fix them?
            </DialogDescription>
          </DialogHeader>
          <div className="border border-border rounded divide-y divide-border max-h-64 overflow-auto">
            {warnDialog.bad.map((b) => (
              <div key={b.sym} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                <div className="min-w-0">
                  <div className="font-mono font-medium truncate">{b.sym} → <span className="text-primary">{b.brokerSym}</span></div>
                  <div className="text-[10px] text-destructive mt-0.5">{b.reason}</div>
                </div>
              </div>
            ))}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" size="sm" onClick={() => setWarnDialog({ open: false, bad: [] })}>
              Go back
            </Button>
            <Button variant="destructive" size="sm" onClick={() => {
              setWarnDialog({ open: false, bad: [] });
              updateMutation.mutate();
            }} disabled={updateMutation.isPending}>
              Save anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TradeModeBadge({ tradeMode }: { tradeMode?: string }) {
  if (!tradeMode) {
    return (
      <Badge variant="outline" className="h-4 px-1 text-[9px] text-muted-foreground">?</Badge>
    );
  }
  const m = tradeMode.toUpperCase();
  if (m === "FULL") {
    return (
      <Badge variant="outline" className="h-4 px-1 text-[9px] border-success/40 text-success">FULL</Badge>
    );
  }
  if (m === "DISABLED") {
    return (
      <Badge variant="outline" className="h-4 px-1 text-[9px] border-destructive/40 text-destructive">OFF</Badge>
    );
  }
  return (
    <Badge variant="outline" className="h-4 px-1 text-[9px] text-warning">{m.slice(0, 6)}</Badge>
  );
}

function Field({ icon: Icon, label, value, mono }: { icon: any; label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <Icon className="h-3 w-3 text-muted-foreground shrink-0" />
      <span className="text-muted-foreground">{label}:</span>
      <span className={`truncate ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

// ─── Add connection form ─────────────────────────────────────────────
function AddConnectionForm({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const [brokerType, setBrokerType] = useState<"oanda" | "metaapi">("metaapi");
  const [displayName, setDisplayName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [isLive, setIsLive] = useState(false);
  const [commissionPreset, setCommissionPreset] = useState<string>("0");
  const [customCommission, setCustomCommission] = useState("");

  const createMutation = useMutation({
    mutationFn: () => brokerApi.create({
      broker_type: brokerType,
      display_name: displayName || brokerType,
      api_key: apiKey,
      account_id: accountId,
      is_live: isLive,
      commission_per_lot: commissionPreset === "custom" ? parseFloat(customCommission || "0") : parseFloat(commissionPreset),
    }),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["broker-connections"] });
      const info = data?.auto_map_info;
      toast.success("Connection saved", {
        description: info ? `Auto-mapped ${info.mapped} pairs${info.unmapped?.length ? ` · ${info.unmapped.length} unmapped` : ""}` : undefined,
      });
      if (data?.id) onCreated(data.id);
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Card>
      <CardContent className="pt-5 space-y-4 max-w-xl">
        <div>
          <h2 className="text-lg font-bold">New connection</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Symbols will be auto-mapped on save (MetaAPI only).
          </p>
        </div>

        <div>
          <Label className="text-xs">Broker</Label>
          <select
            value={brokerType}
            onChange={(e) => setBrokerType(e.target.value as any)}
            className="w-full mt-1 bg-secondary border border-border rounded px-3 py-2 text-sm"
          >
            <option value="metaapi">MetaAPI (MT4 / MT5)</option>
            <option value="oanda">OANDA</option>
          </select>
        </div>

        <div>
          <Label className="text-xs">Display name</Label>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="My HFMarkets account" className="mt-1" />
        </div>

        <div>
          <Label className="text-xs">{brokerType === "metaapi" ? "MetaAPI auth token (JWT)" : "API key / token"}</Label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={brokerType === "metaapi" ? "eyJhbGci..." : ""}
            className="mt-1 font-mono text-xs"
          />
        </div>

        <div>
          <Label className="text-xs">{brokerType === "metaapi" ? "MetaAPI account ID (UUID)" : "Account ID"}</Label>
          <Input
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            placeholder={brokerType === "metaapi" ? "5e83d5a3-cbd9-..." : ""}
            className="mt-1 font-mono text-xs"
          />
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Switch checked={isLive} onCheckedChange={setIsLive} />
          <Label className="text-sm">Live account</Label>
        </div>

        <div>
          <Label className="text-xs">Commission (round-trip per standard lot)</Label>
          <p className="text-[10px] text-muted-foreground mb-1">Set to 0 for spread-only accounts. Auto-detected after first trade if left at 0.</p>
          <select
            value={commissionPreset}
            onChange={(e) => setCommissionPreset(e.target.value)}
            className="w-full mt-1 bg-secondary border border-border rounded px-3 py-2 text-sm"
          >
            <option value="0">Spread-only ($0/lot)</option>
            <option value="5">ECN Low ($5/lot round-trip)</option>
            <option value="7">ECN Standard ($7/lot round-trip)</option>
            <option value="10">ECN High ($10/lot round-trip)</option>
            <option value="custom">Custom...</option>
          </select>
          {commissionPreset === "custom" && (
            <Input
              type="number"
              step="0.5"
              min="0"
              max="50"
              value={customCommission}
              onChange={(e) => setCustomCommission(e.target.value)}
              placeholder="e.g. 6.50"
              className="mt-2 font-mono text-xs"
            />
          )}
        </div>

        <div className="flex gap-2 pt-2">
          <Button onClick={() => createMutation.mutate()} disabled={!apiKey || !accountId || createMutation.isPending}>
            {createMutation.isPending ? "Saving & mapping symbols…" : "Save Connection"}
          </Button>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );
}
