import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Wifi, WifiOff } from "lucide-react";
import { paperApi } from "@/lib/api";
import { readExecutionMode, type ExecutionModeState } from "@/lib/executionMode";

export function getExecutionMode(status: any): ExecutionModeState {
  return readExecutionMode(status);
}

export function StatusBar() {
  const [time, setTime] = useState(new Date());
  const [online, setOnline] = useState(navigator.onLine);

  const { data: status, isPending: statusPending, isError: statusError, error } = useQuery({
    queryKey: ["paper-status"],
    queryFn: () => paperApi.status(),
    refetchInterval: 10000,
    retry: false,
  });

  const executionMode = statusPending || statusError ? "unknown" : getExecutionMode(status);
  const openPositions = executionMode === "unknown" ? null : status.positions.length;
  const isLive = executionMode === "live";
  const modeLabel = executionMode === "unknown" ? "STATUS UNKNOWN" : executionMode === "live" ? "LIVE MODE" : "PAPER MODE";

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 60000);
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  return (
    <div className="h-6 bg-card border-t border-border flex items-center justify-between px-2 md:px-3 text-[10px] text-muted-foreground select-none shrink-0">
      <div className="flex items-center gap-2 md:gap-4">
        <span className="flex items-center gap-1">
          {online ? (
            <><Wifi className="h-2.5 w-2.5 text-success" /><span className="hidden sm:inline"> Connected</span></>
          ) : (
            <><WifiOff className="h-2.5 w-2.5 text-destructive" /><span className="hidden sm:inline"> Disconnected</span></>
          )}
        </span>
        <span
          className={`font-medium ${executionMode === "unknown" ? "text-warning" : isLive ? "text-destructive" : "text-warning"}`}
          title={executionMode === "unknown" ? (error instanceof Error ? error.message : "Trading account status is unavailable") : undefined}
        >
          {modeLabel}
        </span>
        {openPositions !== null && openPositions > 0 && (
          <span className="text-muted-foreground">{openPositions} open</span>
        )}
      </div>
      <div className="flex items-center gap-2 md:gap-4">
        <span className="hidden sm:inline">Market Data</span>
        <span className="font-mono">
          {time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
    </div>
  );
}
