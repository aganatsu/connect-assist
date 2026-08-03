const NEWS_WINDOW_PATTERN = /within\s+(\d+)\s*(?:min|minutes)/i;
const SCHEDULED_TIME_PATTERN = /\s*\(scheduled\s+([^\)]+)\)/i;

function minuteDistance(milliseconds: number): number {
  return milliseconds >= 0
    ? Math.max(0, Math.ceil(milliseconds / 60_000))
    : Math.max(0, Math.floor(Math.abs(milliseconds) / 60_000));
}

export function formatNewsGateCountdown(
  reason: string,
  now: number,
  observedAt?: string | null,
): string {
  const windowMatch = reason.match(NEWS_WINDOW_PATTERN);
  if (!windowMatch || !/high-impact (?:event|news)/i.test(reason)) {
    return reason;
  }

  const scheduledMatch = reason.match(SCHEDULED_TIME_PATTERN);
  if (scheduledMatch) {
    const eventTime = new Date(scheduledMatch[1]).getTime();
    if (Number.isFinite(eventTime)) {
      const difference = eventTime - now;
      const timing = difference >= 0
        ? `in ${minuteDistance(difference)}min`
        : `${minuteDistance(difference)}min since release`;
      return reason
        .replace(NEWS_WINDOW_PATTERN, timing)
        .replace(SCHEDULED_TIME_PATTERN, "");
    }
  }

  const observedTime = observedAt ? new Date(observedAt).getTime() : Number.NaN;
  if (!Number.isFinite(observedTime)) return reason;

  const originalWindow = Number(windowMatch[1]);
  const elapsed = Math.max(0, Math.floor((now - observedTime) / 60_000));
  const remaining = Math.max(0, originalWindow - elapsed);
  const timing = remaining > 0
    ? `approximately ${remaining}min remaining`
    : "news window elapsed";
  return reason.replace(NEWS_WINDOW_PATTERN, timing);
}
