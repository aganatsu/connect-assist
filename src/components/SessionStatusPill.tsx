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

  // CASE 1: at least one pair scanned in latest log → green pill
  if (enabled || (counts && counts.scanned > 0)) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 h-5 rounded text-[10px] font-medium bg-success/10 text-success border border-success/30 ${className}`}
        title={`Bot is scanning during ${current.name} session`}
      >
        <Activity className="h-2.5 w-2.5" />
        Scanning · {current.name}
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
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 h-5 rounded text-[10px] font-medium bg-muted text-muted-foreground border border-border ${className}`}
        title="No sessions enabled in bot config"
      >
        <Clock className="h-2.5 w-2.5" />
        Paused · No sessions enabled
      </span>
    );
  }

  // CASE 3: paused, countdown to next enabled session
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 h-5 rounded text-[10px] font-medium bg-warning/10 text-warning border border-warning/30 ${className}`}
      title={`Currently ${current.name}. Next enabled session: ${next.name} at ${formatNYTime(next.startsAt)} NY`}
    >
      <Clock className="h-2.5 w-2.5" />
      Paused · {current.name} · resumes in {formatCountdown(next.msUntil)} ({next.name} @ {formatNYTime(next.startsAt)} NY)
    </span>
  );
}
