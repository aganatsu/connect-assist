import { useEffect, useState } from "react";
import { Activity, Clock } from "lucide-react";
import {
  detectSession,
  isSessionEnabled,
  getNextEnabledSession,
  formatCountdown,
  formatNYTime,
  type EnabledSessions,
} from "@/lib/sessionSchedule";

interface Props {
  sessions?: EnabledSessions | null;
  className?: string;
}

export default function SessionStatusPill({ sessions, className = "" }: Props) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const tick = () => setNow(new Date());
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  const current = detectSession(now);
  const enabled = isSessionEnabled(current, sessions);

  if (enabled) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 h-5 rounded text-[10px] font-medium bg-success/10 text-success border border-success/30 ${className}`}
        title={`Bot is scanning during ${current} session`}
      >
        <Activity className="h-2.5 w-2.5" />
        Scanning · {current}
      </span>
    );
  }

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

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 h-5 rounded text-[10px] font-medium bg-warning/10 text-warning border border-warning/30 ${className}`}
      title={`Currently ${current}. Next enabled session: ${next.name} at ${formatNYTime(next.startsAt)} NY`}
    >
      <Clock className="h-2.5 w-2.5" />
      Paused · {current} · resumes in {formatCountdown(next.msUntil)} ({next.name} @ {formatNYTime(next.startsAt)} NY)
    </span>
  );
}
