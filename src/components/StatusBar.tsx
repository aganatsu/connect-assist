import { useState, useEffect } from "react";
import { Wifi, WifiOff } from "lucide-react";

export function StatusBar() {
  const [time, setTime] = useState(new Date());
  const [online, setOnline] = useState(navigator.onLine);

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
        <span className="font-medium text-warning">PAPER MODE</span>
      </div>
      <div className="flex items-center gap-4">
        <span>Yahoo Finance</span>
        <span className="font-mono">
          {time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
    </div>
  );
}
