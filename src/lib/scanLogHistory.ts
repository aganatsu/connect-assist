export type ScanDetailWithHistory = Record<string, unknown> & {
  pair: string;
  scanObservedAt: string | null;
  inLatestScan: boolean;
};

type ScanLogLike = {
  scanned_at?: unknown;
  created_at?: unknown;
  details_json?: unknown;
};

function parseDetailsJson(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function timestampFor(log: ScanLogLike): string | null {
  if (typeof log.scanned_at === "string") return log.scanned_at;
  if (typeof log.created_at === "string") return log.created_at;
  return null;
}

/**
 * Scan logs are newest-first and each rotating scan contains only its selected
 * symbols. Keep the first observation for each pair so the UI represents the
 * latest known analysis across the complete rotation, not just one scan slice.
 */
export function collectLatestScanDetails(scanLogs: unknown): {
  meta: Record<string, unknown> | null;
  details: ScanDetailWithHistory[];
} {
  const logs = Array.isArray(scanLogs) ? scanLogs : [];
  const byPair = new Map<string, ScanDetailWithHistory>();
  let meta: Record<string, unknown> | null = null;

  logs.forEach((rawLog, logIndex) => {
    if (!rawLog || typeof rawLog !== "object") return;
    const log = rawLog as ScanLogLike;
    const rows = parseDetailsJson(log.details_json);

    if (logIndex === 0) {
      const newestMeta = rows.find(
        (row): row is Record<string, unknown> =>
          Boolean(row && typeof row === "object" && (row as Record<string, unknown>).__meta),
      );
      meta = newestMeta ?? null;
    }

    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const detail = row as Record<string, unknown>;
      if (detail.__meta) continue;

      const pair = typeof detail.pair === "string" ? detail.pair.trim() : "";
      if (!pair || byPair.has(pair)) continue;

      byPair.set(pair, {
        ...detail,
        pair,
        scanObservedAt: timestampFor(log),
        inLatestScan: logIndex === 0,
      });
    }
  });

  return { meta, details: Array.from(byPair.values()) };
}
