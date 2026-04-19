import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Wifi, WifiOff } from "lucide-react";
import { paperApi } from "@/lib/api";

export function StatusBar() {
  const [time, setTime] = useState(new Date());
  const [online, setOnline] = useState(navigator.onLine);

  const { data: status } = useQuery({
    queryKey: ["paper-status"],
    queryFn: () => paperApi.status(),
    refetchInterval: 10000,
    retry: false,
  });

  const executionMode = status?.account?.execution_mode || "paper";
  const openPositions = status?.positions?.length ?? 0;
  const isLive = executionMode === "live";

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
    <div className="h-6 bg-card border-t border-border flex items-center justify-between px-3 text-[10px] text-muted-foreground select-none shrink-0">
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1">
          {online ? (
            <><Wifi className="h-2.5 w-2.5 text-success" /> Connected</>
          ) : (
            <><WifiOff className="h-2.5 w-2.5 text-destructive" /> Disconnected</>
          )}
        </span>
        <span className={`font-medium ${isLive ? "text-destructive" : "text-warning"}`}>
          {isLive ? "LIVE MODE" : "PAPER MODE"}
        </span>
        {openPositions > 0 && (
          <span className="text-muted-foreground">{openPositions} open</span>
        )}
      </div>
      <div className="flex items-center gap-4">
        <span>Market Data</span>
        <span className="font-mono">
          {time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
    </div>
  );
}
