import { useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  LayoutDashboard, LineChart, Brain, Bot, BookOpen, FlaskConical,
  Settings, Activity, Search, Calendar, Sun, Moon, Monitor,
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
  { title: "Settings", url: "/settings", icon: Settings, shortcut: "8" },
];

interface IconRailProps {
  onSearchToggle: () => void;
}

export function IconRail({ onSearchToggle }: IconRailProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, setTheme } = useTheme();

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

  return (
    <div className="w-12 shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col items-center py-3 gap-1">
      {/* Brand mark */}
      <div className="w-8 h-8 flex items-center justify-center mb-3">
        <Activity className="h-5 w-5 text-primary" />
      </div>

      {/* Search */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onSearchToggle}
            className="w-10 h-10 flex items-center justify-center text-sidebar-foreground hover:text-foreground hover:bg-sidebar-accent transition-colors"
          >
            <Search className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="text-xs">
          Search <kbd className="ml-1 text-muted-foreground">/</kbd>
        </TooltipContent>
      </Tooltip>

      <div className="w-6 border-t border-sidebar-border my-1" />

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
                className={`relative w-10 h-10 flex items-center justify-center transition-colors ${
                  isActive
                    ? "text-primary bg-primary/10"
                    : "text-sidebar-foreground hover:text-foreground hover:bg-sidebar-accent"
                }`}
              >
                {isActive && (
                  <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-primary" />
                )}
                <item.icon className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              {item.title} <kbd className="ml-1 text-muted-foreground">{item.shortcut}</kbd>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
