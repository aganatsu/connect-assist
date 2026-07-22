import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  LayoutDashboard, LineChart, Brain, Bot, BookOpen, FlaskConical,
  Settings, Activity, Search, Calendar, Sun, Moon, Monitor, Server, Play, Shield, ShieldX, Clock,
  PanelLeftClose, PanelLeftOpen,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTheme } from "@/contexts/ThemeContext";

const NAV_ITEMS = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard, shortcut: "1" },
  { title: "Chart", url: "/chart", icon: LineChart, shortcut: "2" },
  { title: "ICT Analysis", url: "/ict-analysis", icon: Brain, shortcut: "3" },
  { title: "Fundamentals", url: "/fundamentals", icon: Calendar, shortcut: "4" },
  { title: "Bot", url: "/bot", icon: Bot, shortcut: "5" },
  { title: "Journal", url: "/journal", icon: BookOpen, shortcut: "6" },
  { title: "Backtest", url: "/backtest", icon: FlaskConical, shortcut: "7" },
  { title: "Brokers", url: "/brokers", icon: Server, shortcut: "8" },
  { title: "Trade Replay", url: "/trade-replay", icon: Play, shortcut: "0" },
  { title: "Prop Firm", url: "/prop-firm", icon: Shield },
  { title: "Rejected Setups", url: "/rejected-setups", icon: ShieldX },
  { title: "Scheduled Tasks", url: "/scheduled-tasks", icon: Clock },
  { title: "Settings", url: "/settings", icon: Settings, shortcut: "9" },
];

interface IconRailProps {
  onSearchToggle: () => void;
}

export function IconRail({ onSearchToggle }: IconRailProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, setTheme } = useTheme();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("iconRail.collapsed") === "1";
  });

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem("iconRail.collapsed", next ? "1" : "0"); } catch {}
      return next;
    });
  };

  const cycleTheme = () => {
    const next = theme === "dark" ? "light" : theme === "light" ? "system" : "dark";
    setTheme(next);
  };
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "/") {
        e.preventDefault();
        onSearchToggle();
        return;
      }

      const idx = parseInt(e.key) - 1;
      if (idx >= 0 && idx < NAV_ITEMS.length) {
        e.preventDefault();
        navigate(NAV_ITEMS[idx].url);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate, onSearchToggle]);

  const rowBase = collapsed
    ? "w-10 h-10 flex items-center justify-center"
    : "w-full h-10 flex items-center gap-3 px-3";

  return (
    <div
      className={`${collapsed ? "w-12" : "w-52"} shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col ${collapsed ? "items-center" : "items-stretch"} py-3 gap-1 transition-[width] duration-200`}
    >
      {/* Brand + collapse toggle */}
      <div className={`mb-3 flex items-center ${collapsed ? "justify-center w-8 h-8" : "justify-between px-3 w-full h-8"}`}>
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          {!collapsed && <span className="text-sm font-semibold text-foreground">SMC</span>}
        </div>
        {!collapsed && (
          <button
            onClick={toggleCollapsed}
            className="text-sidebar-foreground hover:text-foreground p-1"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        )}
      </div>

      {collapsed && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={toggleCollapsed}
              className="w-10 h-10 flex items-center justify-center text-sidebar-foreground hover:text-foreground hover:bg-sidebar-accent transition-colors"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="text-xs">Expand sidebar</TooltipContent>
        </Tooltip>
      )}

      {/* Search */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onSearchToggle}
            className={`${rowBase} text-sidebar-foreground hover:text-foreground hover:bg-sidebar-accent transition-colors`}
          >
            <Search className="h-4 w-4 shrink-0" />
            {!collapsed && (
              <>
                <span className="text-sm">Search</span>
                <kbd className="ml-auto text-[10px] text-muted-foreground">/</kbd>
              </>
            )}
          </button>
        </TooltipTrigger>
        {collapsed && (
          <TooltipContent side="right" className="text-xs">
            Search <kbd className="ml-1 text-muted-foreground">/</kbd>
          </TooltipContent>
        )}
      </Tooltip>

      <div className={`${collapsed ? "w-6" : "w-full"} border-t border-sidebar-border my-1`} />

      {/* Nav items */}
      {NAV_ITEMS.map((item) => {
        const isActive =
          item.url === "/"
            ? location.pathname === "/"
            : location.pathname.startsWith(item.url);

        return (
          <Tooltip key={item.url}>
            <TooltipTrigger asChild>
              <button
                onClick={() => navigate(item.url)}
                className={`relative ${rowBase} transition-colors ${
                  isActive
                    ? "text-primary bg-primary/10"
                    : "text-sidebar-foreground hover:text-foreground hover:bg-sidebar-accent"
                }`}
              >
                {isActive && (
                  <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-primary" />
                )}
                <item.icon className="h-4 w-4 shrink-0" />
                {!collapsed && (
                  <>
                    <span className="text-sm truncate">{item.title}</span>
                    {item.shortcut && (
                      <kbd className="ml-auto text-[10px] text-muted-foreground">{item.shortcut}</kbd>
                    )}
                  </>
                )}
              </button>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right" className="text-xs">
                {item.title} {item.shortcut && <kbd className="ml-1 text-muted-foreground">{item.shortcut}</kbd>}
              </TooltipContent>
            )}
          </Tooltip>
        );
      })}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Theme toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={cycleTheme}
            className={`${rowBase} text-sidebar-foreground hover:text-foreground hover:bg-sidebar-accent transition-colors mb-2`}
          >
            <ThemeIcon className="h-4 w-4 shrink-0" />
            {!collapsed && <span className="text-sm capitalize">{theme}</span>}
          </button>
        </TooltipTrigger>
        {collapsed && (
          <TooltipContent side="right" className="text-xs">Theme: {theme}</TooltipContent>
        )}
      </Tooltip>
    </div>
  );
}
