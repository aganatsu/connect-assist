import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, Sun, Moon, Monitor } from "lucide-react";
import { paperApi } from "@/lib/api";
import { readExecutionMode } from "@/lib/executionMode";
import { useTheme } from "@/contexts/ThemeContext";

const TITLES: Record<string, string> = {
  "/": "Dashboard",
  "/chart": "Chart",
  "/ict-analysis": "ICT Analysis",
  "/fundamentals": "Fundamentals",
  "/game-plan": "Game Plan",
  "/bot": "Bot",
  "/journal": "Journal",
  "/backtest": "Backtest",
  "/brokers": "Brokers",
  "/trade-replay": "Trade Replay",
  "/prop-firm": "Prop Firm",
  "/rejected-setups": "Rejected Setups",
  "/optimizer": "Optimizer",
  "/settings": "Settings",
};

export function MobileTopBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, setTheme } = useTheme();

  const { data: status, isPending: statusPending, isError: statusError } = useQuery({
    queryKey: ["paper-status"],
    queryFn: () => paperApi.status(),
    refetchInterval: 10000,
    retry: false,
  });

  const path = "/" + (location.pathname.split("/")[1] || "");
  const title = TITLES[path] ?? "SMC";
  const isRoot = path === "/";
  const accountStatusKnown = !statusPending && !statusError && readExecutionMode(status) !== "unknown";
  const isRunning = accountStatusKnown && !!status?.isRunning;

  const cycleTheme = () => {
    const next = theme === "dark" ? "light" : theme === "light" ? "system" : "dark";
    setTheme(next);
  };
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  return (
    <header className="safe-area-top sticky top-0 z-20 bg-card/95 backdrop-blur border-b border-border">
      <div className="h-12 flex items-center justify-between px-3">
        <div className="flex items-center gap-2 min-w-0">
          {!isRoot && (
            <button
              onClick={() => navigate(-1)}
              aria-label="Back"
              className="h-11 w-11 -ml-2 inline-flex items-center justify-center text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
          )}
          <h1 className="text-sm font-bold truncate">{title}</h1>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="flex items-center gap-1.5 text-[10px] font-medium">
            <span className={isRunning ? "status-dot-active" : "w-1.5 h-1.5 rounded-full bg-muted-foreground"} />
            <span className={isRunning ? "text-success" : accountStatusKnown ? "text-muted-foreground" : "text-warning"}>
              {accountStatusKnown ? (isRunning ? "ON" : "OFF") : "UNKNOWN"}
            </span>
          </span>
          <button
            onClick={cycleTheme}
            aria-label="Toggle theme"
            className="h-11 w-11 inline-flex items-center justify-center text-muted-foreground hover:text-foreground"
          >
            <ThemeIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </header>
  );
}
