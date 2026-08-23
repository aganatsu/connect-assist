import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Settings, Link2, Palette, Info, Plus, Trash2, Zap, Sun, Moon, Monitor } from "lucide-react";
import { settingsApi } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/contexts/ThemeContext";
import { BotConfigModal } from "@/components/BotConfigModal";
import { supabase } from "@/integrations/supabase/client";

type SettingsTab = "bot" | "preferences" | "about";

const TABS: { id: SettingsTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "bot", label: "Bot Configuration", icon: Zap },
  { id: "preferences", label: "Preferences", icon: Palette },
  { id: "about", label: "About", icon: Info },
];


export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("bot");
  const { signOut } = useAuth();

  return (
    <AppShell>
      <div className="flex flex-col md:flex-row gap-4 md:gap-6 min-h-[calc(100vh-7rem)]">
        <div className="w-full md:w-56 shrink-0">
          <h1 className="hidden md:flex text-lg font-bold mb-4 items-center gap-2"><Settings className="h-5 w-5" /> Settings</h1>
          <div className="md:space-y-1 flex md:flex-col gap-1 overflow-x-auto -mx-3 px-3 md:mx-0 md:px-0 md:overflow-visible pb-2 md:pb-0">
          {TABS.map(tab => {
            const Icon = tab.icon;
            return (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`shrink-0 md:w-full flex items-center gap-2 px-3 py-2 text-sm rounded transition-colors whitespace-nowrap ${
                  activeTab === tab.id ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                }`}><Icon className="h-4 w-4" />{tab.label}</button>
            );
          })}
          <a href="/brokers" className="shrink-0 md:w-full flex items-center gap-2 px-3 py-2 text-sm rounded text-muted-foreground hover:text-foreground hover:bg-secondary/50 whitespace-nowrap">
            <Link2 className="h-4 w-4" />Broker Connections →
          </a>
          <button onClick={() => signOut()} className="shrink-0 md:w-full flex items-center gap-2 px-3 py-2 text-sm rounded text-destructive hover:bg-destructive/10 md:mt-4 whitespace-nowrap">Sign out</button>
          </div>
        </div>
        <div className="flex-1 md:max-w-2xl min-w-0">
          {activeTab === "bot" && <BotConfigSettings />}
          {activeTab === "preferences" && <PreferencesSettings />}
          {activeTab === "about" && <AboutSettings />}
        </div>
      </div>
    </AppShell>
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

  // Notification category toggles — stored in preferences_json.telegramNotifyCategories
  const NOTIFICATION_CATEGORIES = [
    { key: "trade_opened", label: "Trade Opened", description: "Market fill at zone", emoji: "🔴" },
    { key: "zone_setup_active", label: "Zone Setup Active", description: "Pending order placed", emoji: "📍" },
    { key: "zone_touched", label: "Zone Touched", description: "Hunting confirmation", emoji: "🎯" },
    { key: "confirmed_entry", label: "Confirmed Entry", description: "CHoCH/BOS fill", emoji: "✅" },
    { key: "trade_closed", label: "Trade Closed", description: "TP/SL hit", emoji: "📊" },
    { key: "trade_management", label: "Trade Management", description: "BE, trailing, partial TP", emoji: "🛡️" },
    { key: "thesis_invalidated", label: "Thesis Invalidated", description: "Order cancelled", emoji: "⚠️" },
    { key: "prop_firm_alert", label: "Prop Firm Alerts", description: "Emergency close, lockout", emoji: "🚨" },
    { key: "daily_review", label: "Daily Review", description: "End-of-day summary", emoji: "📋" },
    { key: "weekly_advisor", label: "Weekly Advisor", description: "Weekly performance report", emoji: "📈" },
    { key: "gate_effectiveness", label: "Gate Effectiveness", description: "Gate performance alerts", emoji: "📊" },
    { key: "game_plan", label: "Game Plan", description: "Session game plan summary", emoji: "🗺️" },
  ] as const;

  // Load saved toggles (default all ON)
  const savedToggles: Record<string, boolean> = prefs.telegramNotifyCategories || {};
  const getCategoryEnabled = (key: string) => savedToggles[key] !== false; // default true

  const saveNotifToggleMutation = useMutation({
    mutationFn: (nextToggles: Record<string, boolean>) => settingsApi.upsert(undefined, {
      ...prefs,
      telegramNotifyCategories: nextToggles,
    }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["user-settings"] }); toast.success("Notification preferences saved"); },
    onError: (e: any) => toast.error(e.message),
  });

  const toggleCategory = (key: string, enabled: boolean) => {
    const next = { ...savedToggles, [key]: enabled };
    saveNotifToggleMutation.mutate(next);
  };

  const toggleAll = (enabled: boolean) => {
    const next: Record<string, boolean> = {};
    NOTIFICATION_CATEGORIES.forEach(c => { next[c.key] = enabled; });
    saveNotifToggleMutation.mutate(next);
  };

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

      {/* Notification Categories */}
      {chats.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">Notification Categories</CardTitle>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={() => toggleAll(true)}>All On</Button>
                <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={() => toggleAll(false)}>All Off</Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-xs text-muted-foreground mb-3">Choose which notifications to receive on Telegram. Disabled categories will be silently skipped.</p>
            <div className="space-y-2">
              {NOTIFICATION_CATEGORIES.map(cat => (
                <div key={cat.key} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-secondary/30 transition-colors">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm flex-shrink-0">{cat.emoji}</span>
                    <div className="min-w-0">
                      <span className="text-xs font-medium block">{cat.label}</span>
                      <span className="text-[10px] text-muted-foreground block">{cat.description}</span>
                    </div>
                  </div>
                  <Switch
                    checked={getCategoryEnabled(cat.key)}
                    onCheckedChange={(checked) => toggleCategory(cat.key, checked)}
                    className="flex-shrink-0 ml-2"
                  />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

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
