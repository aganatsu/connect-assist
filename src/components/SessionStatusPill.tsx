import { useEffect, useState } from "react";
import { Activity, Clock, AlertCircle } from "lucide-react";
import {
  detectSession,
  isCurrentSessionEnabled,
  getNextEnabledSession,
  formatCountdown,
  formatNYTime,
  type SessionsConfig,
} from "@/lib/sessionSchedule";

interface ScanCounts {
  total: number;
  scanned: number;
  sessionSkipped: number;
}

interface Props {
  sessions?: SessionsConfig | null;
  scanDetails?: any[] | null;
  className?: string;
}

function countFromDetails(details: any[] | null | undefined): ScanCounts | null {
  if (!Array.isArray(details) || details.length === 0) return null;
  const rows = details.filter((d) => !d?.__meta);
  let scanned = 0;
  let sessionSkipped = 0;
  for (const r of rows) {
    const reason: string = String(r?.reason || "");
    if (r?.status === "skipped" && /session not enabled/i.test(reason)) {
      sessionSkipped++;
    } else if (r?.status !== "skipped") {
      scanned++;
    }
  }
  return { total: rows.length, scanned, sessionSkipped };
}

export default function SessionStatusPill({ sessions, scanDetails, className = "" }: Props) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const current = detectSession(now);
  const enabled = isCurrentSessionEnabled(now, sessions);
  const counts = countFromDetails(scanDetails);

  // Weekend: FX shut Fri 17:00 ET → Sun 17:00 ET. Bot switches to crypto-only when enabled.
  const nyParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const nyWeekday = nyParts.find((p) => p.type === "weekday")?.value ?? "";
  const nyHour = Number(nyParts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const fxClosed =
    nyWeekday === "Sat" ||
    (nyWeekday === "Sun" && nyHour < 17) ||
    (nyWeekday === "Fri" && nyHour >= 17);
  const weekendCryptoOn = (sessions as any)?.weekendCryptoEnabled ?? true;

  if (fxClosed) {
    return weekendCryptoOn ? (
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 h-5 rounded text-[10px] font-medium bg-success/10 text-success border border-success/30 overflow-hidden whitespace-nowrap ${className}`}
        title="FX market is closed — bot is scanning BTC/USD and ETH/USD only"
      >
        <Activity className="h-2.5 w-2.5" />
        <span className="min-w-0 truncate">Weekend · crypto only</span>
      </span>
    ) : (
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 h-5 rounded text-[10px] font-medium bg-muted text-muted-foreground border border-border overflow-hidden whitespace-nowrap ${className}`}
        title="FX market is closed and weekend crypto trading is off"
      >
        <Clock className="h-2.5 w-2.5" />
        <span className="min-w-0 truncate">Weekend · market closed</span>
      </span>
    );
  }

  // CASE 1: at least one pair scanned in latest log → green pill
  if (enabled || (counts && counts.scanned > 0)) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 h-5 rounded text-[10px] font-medium bg-success/10 text-success border border-success/30 overflow-hidden whitespace-nowrap ${className}`}
        title={`Bot is scanning during ${current.name} session`}
      >
        <Activity className="h-2.5 w-2.5" />
        <span className="min-w-0 truncate">Scanning · {current.name}</span>
        {counts && (
          <span className="text-success/80">
            · {counts.scanned}/{counts.total} pairs
          </span>
        )}
        {counts && counts.sessionSkipped > 0 && (
          <span
            className="ml-1 inline-flex items-center gap-0.5 px-1 rounded bg-warning/15 text-warning border border-warning/30"
            title={`${counts.sessionSkipped} pair(s) skipped: not in their allowed session`}
          >
            <AlertCircle className="h-2 w-2" />
            {counts.sessionSkipped} off-session
          </span>
        )}
      </span>
    );
  }

  // CASE 2: nothing scanning + no enabled sessions configured
  const next = getNextEnabledSession(sessions, now);
  if (!next) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 h-5 rounded text-[10px] font-medium bg-muted text-muted-foreground border border-border overflow-hidden whitespace-nowrap ${className}`}
        title="No sessions enabled in bot config"
      >
        <Clock className="h-2.5 w-2.5" />
        <span className="min-w-0 truncate">Paused · No sessions enabled</span>
      </span>
    );
  }

  // CASE 3: paused, countdown to next enabled session
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 h-5 rounded text-[10px] font-medium bg-warning/10 text-warning border border-warning/30 overflow-hidden whitespace-nowrap ${className}`}
      title={`Currently ${current.name}. Next enabled session: ${next.name} at ${formatNYTime(next.startsAt)} NY`}
    >
      <Clock className="h-2.5 w-2.5" />
      <span className="min-w-0 truncate">Paused · {current.name} · resumes in {formatCountdown(next.msUntil)} ({next.name} @ {formatNYTime(next.startsAt)} NY)</span>
    </span>
  );
}
