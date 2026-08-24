import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { botConfigApi } from "@/lib/api";
import {
  STYLE_META,
  TRADING_STYLE_MODES,
  selectTradingStyle,
  type RuntimeStylePolicy,
} from "@/lib/botStyleClassifier";
import { toast } from "sonner";
import { X, Shield, Globe, Search, Bookmark, FolderOpen, ChevronDown, ChevronUp, Trash2, Target, Download, Upload, Flag } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { formatBrokerTime } from "@/lib/formatTime";
import { HighlightContext } from "@/components/config/ConfigShared";
import { ScanTab } from "@/components/config/ScanTab";
import { EnterTab } from "@/components/config/EnterTab";
import { ExitTab } from "@/components/config/ExitTab";
import { RiskTab } from "@/components/config/RiskTab";
import { normalizeBotConfigForEditor } from "@/lib/botConfigEditor";
import { searchBotConfigSettings, type BotConfigTabId } from "@/lib/botConfigSearch";

// ─── Legacy Tab ID → New Tab ID Mapping ───────────────────────────────────────
// Used to translate defaultTab props from other components that still use old IDs.
const TAB_ID_MAP: Record<string, string> = {
  tradingStyle: "scan",
  strategy: "scan",
  instruments: "scan",
  sessions: "scan",
  openingRange: "scan",
  gamePlan: "scan",
  ict2022: "scan",
  smcEnhancements: "scan",
  entry_exit: "exit",
  factorWeights: "enter",
  pairOverrides: "enter",
  risk: "risk",
  protection: "risk",
};

// ─── Component ────────────────────────────────────────────────────────────────
interface BotConfigModalProps {
  open: boolean;
  onClose: () => void;
  connectionId?: string;
  connectionName?: string;
  defaultTab?: string;
  defaultSearch?: string;
  effectiveStylePolicy?: RuntimeStylePolicy | null;
  /**
   * "modal" floats over the page; "page" drops the overlay and the height cap
   * so the same panel can fill a route. Everything inside is identical — the
   * config is one component, rendered two ways, rather than two copies that
   * drift apart.
   */
  variant?: "modal" | "page";
}

export function BotConfigModal({ open, onClose, connectionId, connectionName, defaultTab, defaultSearch, effectiveStylePolicy, variant = "modal" }: BotConfigModalProps) {
  const asPage = variant === "page";
  const queryClient = useQueryClient();
  const queryKey = connectionId ? ["bot-config", connectionId] : ["bot-config"];
  const effectiveQueryKey = connectionId
    ? ["bot-config-effective", connectionId]
    : ["bot-config-effective"];
  const { data: rawConfig } = useQuery({ queryKey, queryFn: () => botConfigApi.get(connectionId), enabled: open });
  const {
    data: effectiveRuntime,
    error: effectiveRuntimeError,
    isLoading: effectiveRuntimeLoading,
  } = useQuery({
    queryKey: effectiveQueryKey,
    queryFn: () => botConfigApi.getEffective(connectionId),
    enabled: open,
    retry: false,
  });
  const [config, setConfig] = useState<any>(null);
  // Map legacy tab IDs to new ones
  const resolvedDefaultTab = defaultTab ? (TAB_ID_MAP[defaultTab] || defaultTab) : "scan";
  const [activeTab, setActiveTab] = useState(resolvedDefaultTab);
  const [search, setSearch] = useState(defaultSearch || "");
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchQuery = search.trim().toLowerCase();

  // Scroll the first highlighted setting into view whenever the search changes.
  useEffect(() => {
    if (!open || !searchQuery) return;
    const t = setTimeout(() => {
      const el = contentRef.current?.querySelector('[data-config-match="true"]');
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
    return () => clearTimeout(t);
  }, [searchQuery, open, activeTab, config]);

  useEffect(() => {
    if (rawConfig && open) {
      setConfig(normalizeBotConfigForEditor(rawConfig));
    }
  }, [rawConfig, open]);

  useEffect(() => {
    if (open) {
      setSearch(defaultSearch || "");
      const tab = defaultTab ? (TAB_ID_MAP[defaultTab] || defaultTab) : "scan";
      setActiveTab(tab);
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open, defaultTab, defaultSearch]);

  // ─── Mutations ───────────────────────────────────────────────────
  const saveMut = useMutation({
    mutationFn: () => {
      if (!config) return Promise.reject(new Error("Config not loaded yet"));
      const clean = JSON.parse(JSON.stringify(config));
      if (clean?.risk) {
        if ("maxOpenPositions" in clean.risk) {
          if (clean.risk.maxConcurrentTrades == null) {
            clean.risk.maxConcurrentTrades = clean.risk.maxOpenPositions;
          }
          delete clean.risk.maxOpenPositions;
        }
      }
      return botConfigApi.update(clean, connectionId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: effectiveQueryKey });
      toast.success("Config saved and runtime-verified");
      onClose();
    },
    onError: (e: any) => {
      const msg = e?.message || "Failed to save config";
      if (msg.toLowerCase().includes("validation") || msg.toLowerCase().includes("invalid") || msg.toLowerCase().includes("must be")) {
        toast.error("Config Validation Error", { description: msg, duration: 8000 });
      } else {
        toast.error(msg);
      }
    },
  });

  const resetMut = useMutation({
    mutationFn: () => botConfigApi.reset(connectionId),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: effectiveQueryKey });
      if (data && typeof data === "object") {
        setConfig(normalizeBotConfigForEditor(data));
      }
      toast.success("Config reset to defaults");
    },
    onError: (e: any) => { toast.error(e?.message || "Failed to reset config"); },
  });

  const copyFromGlobalMut = useMutation({
    mutationFn: async () => {
      const globalConfig = await botConfigApi.get();
      return globalConfig;
    },
    onSuccess: (data: any) => { setConfig(normalizeBotConfigForEditor(data)); toast.success("Copied from global config"); },
  });

  const updateField = (section: string, key: string, value: any) => {
    setConfig((prev: any) => ({ ...prev, [section]: { ...(prev?.[section] || {}), [key]: value } }));
  };

  // ─── Custom Presets ───────────────────────────────────────────────
  const [showSavePresetDialog, setShowSavePresetDialog] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetDescription, setPresetDescription] = useState("");
  const [showMyPresets, setShowMyPresets] = useState(true);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const { data: customPresets = [], refetch: refetchPresets } = useQuery({
    queryKey: ["config-presets"],
    queryFn: () => botConfigApi.listPresets(),
    enabled: open,
  });

  const savePresetMut = useMutation({
    mutationFn: () => botConfigApi.savePreset(presetName.trim(), config, presetDescription.trim() || undefined),
    onSuccess: (result: any) => {
      refetchPresets();
      setShowSavePresetDialog(false);
      setPresetName("");
      setPresetDescription("");
      toast.success(result.updated ? `Preset "${presetName}" updated` : `Preset "${presetName}" saved`);
    },
    onError: (e: any) => {
      const msg = e?.message || "Failed to save preset";
      if (msg.toLowerCase().includes("maximum") || msg.toLowerCase().includes("limit")) {
        toast.error("Preset limit reached", { description: "You can save up to 20 presets. Delete an existing preset to make room." });
      } else {
        toast.error(msg);
      }
    },
  });

  const deletePresetMut = useMutation({
    mutationFn: (id: string) => botConfigApi.deletePreset(id),
    onSuccess: () => {
      refetchPresets();
      setDeleteConfirmId(null);
      toast.success("Preset deleted");
    },
    onError: (e: any) => toast.error(e.message),
  });

  // ─── Active Preset Detection ────────────────────────────────────
  const deepMatch = (saved: any, preset: any): boolean => {
    if (preset === saved) return true;
    if (preset == null || saved == null) return preset == saved;
    if (typeof preset !== typeof saved) return false;
    if (typeof preset !== "object") return String(preset) === String(saved);
    if (Array.isArray(preset)) {
      if (!Array.isArray(saved) || preset.length !== saved.length) return false;
      return preset.every((v: any, i: number) => deepMatch(saved[i], v));
    }
    for (const key of Object.keys(preset)) {
      if (!deepMatch(saved[key], preset[key])) return false;
    }
    return true;
  };

  const isPresetActive = (presetConfig: any): boolean => {
    if (!presetConfig) return false;
    const compareTarget = config || rawConfig;
    if (!compareTarget) return false;
    const sections = ["strategy", "risk", "entry", "exit", "instruments", "sessions", "protection"];
    for (const section of sections) {
      if (!presetConfig[section]) continue;
      if (!deepMatch(compareTarget[section], presetConfig[section])) return false;
    }
    return true;
  };

  // ─── Export / Import ─────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = () => {
    if (!config) return;
    const bundle = {
      _meta: { version: 1, exportedAt: new Date().toISOString(), source: "smc-trading-bot", connectionId: connectionId || null },
      config,
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const suffix = connectionId ? `-${connectionName || connectionId}` : "-global";
    a.download = `smc-bot-config${suffix}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Config exported");
  };

  const handleImportClick = () => { fileInputRef.current?.click(); };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string);
        const configPayload = parsed.config || parsed;
        const meta = parsed._meta;
        if (!configPayload || typeof configPayload !== "object") {
          toast.error("Invalid config file", { description: "No valid configuration found in the file." });
          return;
        }
        const knownSections = ["strategy", "risk", "entry", "exit", "instruments", "sessions", "notifications", "protection", "account"];
        const foundSections = knownSections.filter(s => s in configPayload);
        if (foundSections.length === 0) {
          toast.error("Invalid config file", { description: "File does not contain any recognized config sections." });
          return;
        }
        const exportInfo = meta?.exportedAt ? ` (exported ${meta.exportedAt.slice(0, 10)})` : "";
        if (confirm(`Import config${exportInfo}?\n\nThis will load ${foundSections.length} sections into the editor.\nYou still need to click "Save Config" to apply.`)) {
          setConfig(normalizeBotConfigForEditor(configPayload));
          toast.success(`Config loaded from file`, { description: `${foundSections.length} sections imported. Click Save to apply.` });
        }
      } catch {
        toast.error("Invalid file", { description: "Could not parse JSON. Make sure this is a valid config file." });
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const applyPresetConfig = (presetConfig: any, label: string) => {
    if (!config) return;
    // Handle case where config_json might be a string
    const parsed = typeof presetConfig === 'string' ? JSON.parse(presetConfig) : presetConfig;
    setConfig(normalizeBotConfigForEditor(parsed));
    toast.info(`Applied preset: ${label}`);
  };

  // ─── Tabs & Search ──────────────────────────────────────────────
  if (!open) return null;

  const tabs: { id: BotConfigTabId; label: string; icon: typeof Globe }[] = [
    { id: "scan", label: "SCAN", icon: Globe },
    { id: "enter", label: "ENTER", icon: Target },
    { id: "exit", label: "EXIT", icon: Flag },
    { id: "risk", label: "RISK", icon: Shield },
  ];

  const query = search.trim().toLowerCase();
  const matches = searchBotConfigSettings(query);
  const matchedTabIds = new Set(matches.map(m => m.tab));
  const matchedLabels = new Set(matches.map(m => m.label.toLowerCase()));
  const filteredTabs = query ? tabs.filter(t => matchedTabIds.has(t.id)) : tabs;

  const effectiveActiveTab =
    query && filteredTabs.length > 0 && !matchedTabIds.has(activeTab as BotConfigTabId)
      ? filteredTabs[0].id
      : activeTab;

  // ─── Render ─────────────────────────────────────────────────────
  return (
    <div
      className={asPage
        ? ""
        : "fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-0 md:p-4"}
    >
      <div
        className={asPage
          ? "bg-card border border-border w-full flex flex-col overflow-visible"
          : "bg-card border border-border w-full max-w-4xl h-full md:h-auto md:max-h-[85vh] flex flex-col shadow-2xl overflow-hidden"}
      >
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 md:px-6 py-2 md:py-4 border-b border-border">
          <div className="min-w-0">
            {asPage ? (
              <p className="font-mono text-[10px] font-semibold uppercase text-muted-foreground">
                {connectionName ? `Connection · ${connectionName}` : "Global settings"}
              </p>
            ) : (
              <>
                <h2 className="truncate text-sm font-bold md:text-base">{connectionName ? `Config: ${connectionName}` : "Global Bot Configuration"}</h2>
                {connectionName && <p className="text-[10px] text-muted-foreground">Settings specific to this broker connection</p>}
              </>
            )}
          </div>
          <div className="flex items-center justify-end gap-1 md:gap-2 shrink-0">
            {connectionId && (
              <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => copyFromGlobalMut.mutate()}>Copy from Global</Button>
            )}
            <Button variant="ghost" size="sm" className="h-10 w-10 md:h-8 md:w-auto p-0 md:px-3 text-xs text-muted-foreground gap-1" onClick={handleExport} title="Export config as JSON file" aria-label="Export configuration">
              <Download className="h-4 w-4 md:h-3 md:w-3" /><span className="hidden md:inline">Export</span>
            </Button>
            <Button variant="ghost" size="sm" className="h-10 w-10 md:h-8 md:w-auto p-0 md:px-3 text-xs text-muted-foreground gap-1" onClick={handleImportClick} title="Import config from JSON file" aria-label="Import configuration">
              <Upload className="h-4 w-4 md:h-3 md:w-3" /><span className="hidden md:inline">Import</span>
            </Button>
            <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleFileChange} />
            <Button variant="ghost" size="sm" className="hidden md:inline-flex text-xs text-muted-foreground" onClick={() => resetMut.mutate()}>Reset Defaults</Button>
            <Button variant="outline" size="sm" className="hidden md:inline-flex text-xs gap-1" onClick={() => { setPresetName(""); setPresetDescription(""); setShowSavePresetDialog(true); }}>
              <Bookmark className="h-3 w-3" /> Save as Preset
            </Button>
            <Button size="sm" className="h-10 md:h-8 text-xs" onClick={() => saveMut.mutate()}>Save</Button>
            {!asPage && (
              <button onClick={onClose} className="h-10 w-10 inline-flex items-center justify-center text-muted-foreground hover:text-foreground" aria-label="Close configuration"><X className="h-4 w-4" /></button>
            )}
          </div>
        </div>

        <div className="px-3 md:px-6 py-2 border-b border-border bg-muted/20 max-h-20 overflow-y-auto">
          {effectiveRuntimeError ? (
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-destructive">
                Runtime configuration unavailable. Automated entries will fail
                closed until the saved configuration can be verified.
              </span>
              <Badge variant="destructive">NOT VERIFIED</Badge>
            </div>
          ) : effectiveRuntime ? (
            <details className="text-[11px] text-muted-foreground">
              <summary className="flex cursor-pointer list-none items-center gap-2">
                <Badge variant="outline" className="text-emerald-500 border-emerald-500/40">
                  RUNTIME VERIFIED
                </Badge>
                <span>Saved settings are valid and ready for the scanner.</span>
                <ChevronDown className="ml-auto h-3.5 w-3.5" />
              </summary>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-border/60 pt-2">
                <span>Source: {effectiveRuntime.provenance.source.replace(/_/g, " ")}</span>
                <span>Style: {effectiveRuntime.provenance.criticalSettings.tradingStyle}</span>
                <span>
                  Require sweep:{" "}
                  <strong className={effectiveRuntime.provenance.criticalSettings.requireLiquiditySweep ? "text-emerald-500" : "text-amber-500"}>
                    {effectiveRuntime.provenance.criticalSettings.requireLiquiditySweep ? "ON" : "OFF"}
                  </strong>
                </span>
                <span>Config: {effectiveRuntime.provenance.effectiveConfigHash.slice(0, 12)}</span>
              </div>
            </details>
          ) : (
            <div className="text-[11px] text-muted-foreground">
              {effectiveRuntimeLoading ? "Verifying runtime configuration…" : "Runtime verification pending"}
            </div>
          )}
        </div>

        {/* Save Preset Dialog */}
        <Dialog open={showSavePresetDialog} onOpenChange={setShowSavePresetDialog}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-sm">Save as Preset</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Save the current configuration as a reusable preset.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div>
                <label className="text-xs font-medium">Name</label>
                <Input value={presetName} onChange={e => setPresetName(e.target.value)} placeholder="My Config" className="h-8 text-sm mt-1" />
              </div>
              <div>
                <label className="text-xs font-medium">Description (optional)</label>
                <Textarea value={presetDescription} onChange={e => setPresetDescription(e.target.value)} placeholder="What makes this preset special..." className="text-sm mt-1 h-16 resize-none" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => setShowSavePresetDialog(false)}>Cancel</Button>
              <Button size="sm" className="text-xs" onClick={() => savePresetMut.mutate()} disabled={!presetName.trim() || savePresetMut.isPending}>
                {savePresetMut.isPending ? "Saving..." : "Save Preset"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Preset Confirm Dialog */}
        <Dialog open={!!deleteConfirmId} onOpenChange={() => setDeleteConfirmId(null)}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-sm">Delete Preset</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                This preset will be permanently deleted. This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => setDeleteConfirmId(null)}>Cancel</Button>
              <Button variant="destructive" size="sm" className="text-xs gap-1" onClick={() => { if (deleteConfirmId) deletePresetMut.mutate(deleteConfirmId); }} disabled={deletePresetMut.isPending}>
                <Trash2 className="h-3 w-3" /> {deletePresetMut.isPending ? "Deleting..." : "Delete"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Presets Bar */}
        {customPresets.length > 0 && (
          <div className="px-6 py-3 border-b border-border bg-secondary/30 shrink-0 max-h-[30vh] overflow-y-auto">
            <div>
              <button
                onClick={() => setShowMyPresets(!showMyPresets)}
                className="flex items-center gap-1 text-[10px] text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors w-full"
              >
                <FolderOpen className="h-3 w-3 text-primary" />
                My Presets ({customPresets.length})
                {showMyPresets ? <ChevronUp className="h-3 w-3 ml-auto" /> : <ChevronDown className="h-3 w-3 ml-auto" />}
              </button>
              {showMyPresets && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2 max-h-[22vh] overflow-y-auto">
                  {customPresets.map((cp: any) => (
                    <div
                      key={cp.id}
                      className={`group relative p-2.5 border-2 text-left transition-all cursor-pointer ${isPresetActive(cp.config_json ?? cp.config) ? "border-primary bg-primary/10 ring-1 ring-primary/30 shadow-[0_0_8px_rgba(0,255,255,0.15)]" : "border-border hover:border-border/80"}`}
                      onClick={() => applyPresetConfig(cp.config_json ?? cp.config, cp.name)}
                    >
                      <div className="flex items-center justify-between">
                        <span className={`text-xs font-medium truncate ${isPresetActive(cp.config_json ?? cp.config) ? "text-primary" : ""}`}>
                          {isPresetActive(cp.config_json ?? cp.config) && <span className="inline-block mr-1">✓</span>}
                          {cp.name}
                        </span>
                        <button
                          onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(cp.id); }}
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                      {cp.description && <p className="text-[9px] text-muted-foreground mt-0.5 line-clamp-1">{cp.description}</p>}
                      <p className="text-[9px] text-muted-foreground/60 mt-1">{formatBrokerTime(cp.updated_at)}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Trading Style Quick-Select */}
        {effectiveActiveTab === "scan" && config && (
          <div className="px-6 py-2.5 border-b border-border bg-secondary/20">
            <div className="flex items-center justify-between gap-2 mb-2">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Trading Style</p>
              <span className="text-[9px] text-muted-foreground">Selection only — explicit overrides stay intact</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {TRADING_STYLE_MODES.map(mode => {
                const isActive = (config.tradingStyle?.mode || "day_trader") === mode;
                const meta = STYLE_META[mode];
                return (
                  <button
                    key={mode}
                    onClick={() => {
                      setConfig((previous: unknown) => selectTradingStyle(previous, mode));
                      toast.info(`${meta.label} selected`, {
                        description: "Save Config to apply it. The next scan will show the effective runtime policy.",
                      });
                    }}
                    className={`p-2.5 border text-left transition-colors ${isActive ? "border-primary bg-primary/5" : "border-border hover:border-border/80"}`}
                  >
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-sm">{meta.icon}</span>
                      <span className="text-[10px] font-bold">{meta.label}</span>
                    </div>
                    <p className="text-[8px] leading-tight text-muted-foreground">{meta.description}</p>
                  </button>
                );
              })}
            </div>
            {effectiveStylePolicy ? (() => {
              const effectiveMeta = STYLE_META[effectiveStylePolicy.style];
              const selectedMode = config.tradingStyle?.mode || "day_trader";
              const pendingChange = selectedMode !== effectiveStylePolicy.style;
              const management = effectiveStylePolicy.management;
              return (
                <div className="mt-2.5 border border-primary/30 bg-background/60 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-primary">
                      Effective runtime policy
                    </span>
                    <span className="text-[9px] font-mono text-muted-foreground">
                      {effectiveStylePolicy.contractVersion} · {effectiveStylePolicy.basePolicyHash.slice(0, 12)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-muted-foreground">
                    <span>Style: <strong className="text-foreground">{effectiveMeta.icon} {effectiveMeta.label}</strong></span>
                    <span>Scan: <strong className="text-foreground">{effectiveStylePolicy.cadence.scanIntervalMinutes}m</strong></span>
                    <span>Gameplan: <strong className="text-foreground">{effectiveStylePolicy.lifecycle.gamePlanValidityMinutes >= 60 ? `${effectiveStylePolicy.lifecycle.gamePlanValidityMinutes / 60}h` : `${effectiveStylePolicy.lifecycle.gamePlanValidityMinutes}m`}</strong></span>
                    <span>Entry / HTF: <strong className="text-foreground">{effectiveStylePolicy.timeframes.runtimeEntry} / {effectiveStylePolicy.timeframes.runtimeHTF}</strong></span>
                    <span>Gate: <strong className="text-foreground">≥{effectiveStylePolicy.qualification.effectiveMinConfluence}%</strong></span>
                    <span>Target: <strong className="text-foreground">{effectiveStylePolicy.risk.tpRatio}:1</strong></span>
                    <span>Risk: <strong className="text-foreground">{effectiveStylePolicy.risk.riskPerTrade}%</strong></span>
                    <span>
                      Management: <strong className="text-foreground">
                        {[
                          management.breakEvenEnabled && "BE",
                          management.trailingStopEnabled && "trail",
                          management.partialTPEnabled && "partial",
                        ].filter(Boolean).join(" + ") || "fixed exit"}
                      </strong>
                    </span>
                  </div>
                  <p className={`mt-1.5 text-[9px] ${pendingChange ? "text-warning" : "text-success"}`}>
                    {pendingChange
                      ? `Pending: save ${STYLE_META[selectedMode as keyof typeof STYLE_META]?.label || selectedMode}, then wait for the next scan.`
                      : `Selected style matches the last resolved scan. ${effectiveStylePolicy.provenance.userOverridesPreserved.length} explicit override(s) preserved.`}
                  </p>
                </div>
              );
            })() : (
              <p className="mt-2 text-[9px] text-muted-foreground">
                No resolved policy snapshot is available here yet. Save your selection and check again after the next scan.
              </p>
            )}
          </div>
        )}

        {/* Search Bar */}
        <div className="px-3 md:px-6 py-2.5 border-b border-border bg-background/40">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              ref={searchRef}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search settings..."
              className="h-8 pl-8 text-xs bg-secondary/40 border-border"
            />
            {query && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {query && (
            <p className="text-[10px] text-muted-foreground mt-1.5">
              {matches.length === 0
                ? `No settings match "${search}"`
                : `${matches.length} setting${matches.length === 1 ? "" : "s"} across ${filteredTabs.length} tab${filteredTabs.length === 1 ? "" : "s"}`}
            </p>
          )}
        </div>

        {/* Body: Tab nav + content */}
        <div className={`flex flex-col md:flex-row flex-1 ${asPage ? "" : "min-h-0"}`}>
          {/* Vertical Tab Nav */}
          <div className="md:w-44 border-b md:border-b-0 md:border-r border-border py-1 md:py-2 shrink-0 overflow-x-auto md:overflow-y-auto flex md:flex-col">
            {filteredTabs.length === 0 && (
              <p className="px-4 py-3 text-[10px] text-muted-foreground italic">No matching tabs</p>
            )}
            {filteredTabs.map(tab => {
              const isActive = effectiveActiveTab === tab.id;
              const matchCount = query ? matches.filter(m => m.tab === tab.id).length : 0;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`shrink-0 w-auto md:w-full min-h-11 flex items-center gap-2 px-4 py-2.5 text-xs transition-colors ${isActive ? "bg-primary/10 text-primary border-b-2 md:border-b-0 md:border-l-2 border-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-secondary/30 border-b-2 md:border-b-0 md:border-l-2 border-transparent"}`}
                >
                  <tab.icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1 text-left">{tab.label}</span>
                  {matchCount > 0 && (
                    <Badge variant="secondary" className="h-4 px-1.5 text-[9px] font-mono">{matchCount}</Badge>
                  )}
                </button>
              );
            })}
          </div>

          {/* Tab Content */}
          <div
            ref={contentRef}
            className={`flex-1 p-3 pb-[calc(5rem+env(safe-area-inset-bottom))] md:p-6 ${
              asPage ? "overflow-visible" : "min-h-0 overflow-y-auto overscroll-contain"
            }`}
          >
            <HighlightContext.Provider value={matchedLabels}>
              {config && filteredTabs.length > 0 && (
                <>
                  {effectiveActiveTab === "scan" && <ScanTab config={config} setConfig={setConfig} updateField={updateField} />}
                  {effectiveActiveTab === "enter" && <EnterTab config={config} setConfig={setConfig} updateField={updateField} />}
                  {effectiveActiveTab === "exit" && <ExitTab config={config} setConfig={setConfig} updateField={updateField} />}
                  {effectiveActiveTab === "risk" && <RiskTab config={config} setConfig={setConfig} updateField={updateField} />}
                </>
              )}
              {config && filteredTabs.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-center py-12">
                  <Search className="h-8 w-8 text-muted-foreground/40 mb-3" />
                  <p className="text-sm text-muted-foreground">No settings match "{search}"</p>
                  <button
                    onClick={() => setSearch("")}
                    className="text-xs text-primary hover:underline mt-2"
                  >
                    Clear search
                  </button>
                </div>
              )}
            </HighlightContext.Provider>
          </div>
        </div>
      </div>
    </div>
  );
}
