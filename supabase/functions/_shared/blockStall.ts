// Silent-stall alert. The scanner can look healthy (a scan every 5 minutes) while one
// skip reason blocks every pair. On 2026-10-28/30 requireUnifiedZone vs the hidden
// unifiedModifiersEnabled switch did exactly that for ~36h before anyone noticed.
//
// After each scan: if EVERY pair was blocked for the SAME reason, keep an active
// `all_pairs_blocked` alert (scanner_operational_alerts) whose evidence accumulates
// blocked market time; at 6h, send one Telegram message. Any scan where a pair gets
// past that reason resolves it. Market-closed and session-off scans change nothing.

export const STALL_ALERT_TYPE = "all_pairs_blocked";
export const STALL_NOTIFY_MINUTES = 360;   // 6h of blocked market time
export const STALL_MAX_STEP_MINUTES = 15;  // a gap between scans (weekend, outage) counts at most this much

export interface ScanPairDetail { pair?: unknown; status?: unknown; reason?: unknown; skipReason?: unknown }
export type ScanBlock =
  | { kind: "benign" }                  // market closed / session off / nothing evaluated: no change
  | { kind: "healthy" }                 // at least one pair got past every block, or pairs differ
  | { kind: "blocked"; key: string; status: string; reason: string; pairs: number };

const BENIGN_REASON = /session not enabled|market closed/i;
const GENERIC = new Set(["skipped", "rejected"]);   // statuses whose reason text says what blocked

const reasonOf = (d: ScanPairDetail) => String(d.skipReason ?? d.reason ?? "");
const isBlocking = (s: string) =>
  s.startsWith("skipped") || s.startsWith("rejected") || s.startsWith("zone_setup_rejected") || s.endsWith("_failed") ||
  ["market_entry_disabled", "dry_run_market_skipped", "attribution_invalid", "below_threshold"].includes(s);

export function classifyScan(details: ScanPairDetail[]): ScanBlock {
  const rows = details.filter((d) => typeof d?.pair === "string" && typeof d?.status === "string");
  if (rows.length === 0) return { kind: "benign" };
  if (rows.some((d) => d.status === "skipped" && BENIGN_REASON.test(reasonOf(d)))) return { kind: "benign" };
  if (!rows.every((d) => isBlocking(d.status as string))) return { kind: "healthy" };
  const keyOf = (d: ScanPairDetail) =>
    GENERIC.has(d.status as string) ? `${d.status}:${reasonOf(d).replace(/[0-9]+(\.[0-9]+)?/g, "#").slice(0, 60)}` : (d.status as string);
  const keys = new Set(rows.map(keyOf));
  if (keys.size !== 1) return { kind: "healthy" };
  return { kind: "blocked", key: [...keys][0], status: rows[0].status as string, reason: reasonOf(rows[0]), pairs: rows.length };
}

export interface ActiveStall { dedupe_key: string; last_detected_at: string; evidence: Record<string, unknown> | null }

export function nextStall(prev: ActiveStall | null, block: Extract<ScanBlock, { kind: "blocked" }>, now: Date) {
  const same = prev && prev.dedupe_key === block.key ? prev : null;
  const before = Number(same?.evidence?.blocked_minutes ?? 0) || 0;
  const step = same ? Math.min(Math.max((now.getTime() - Date.parse(same.last_detected_at)) / 60000, 0), STALL_MAX_STEP_MINUTES) : 0;
  const blockedMinutes = before + (Number.isFinite(step) ? step : 0);
  const notifiedAt = (same?.evidence?.notified_at as string | undefined) ?? null;
  const shouldNotify = !notifiedAt && blockedMinutes >= STALL_NOTIFY_MINUTES;
  return {
    blockedMinutes,
    shouldNotify,
    evidence: {
      status: block.status, reason: block.reason, pairs: block.pairs,
      blocked_minutes: Math.round(blockedMinutes * 10) / 10,
      notified_at: shouldNotify ? now.toISOString() : notifiedAt,
    },
  };
}

const HINTS: Record<string, string> = {
  skipped_require_unified: "Check Bot Config → Strategy → \"Require Unified Zone Confirmation\".",
  market_entry_disabled: "Market entries are disabled (Route 2 only) and no limit entry was available.",
  skipped_no_impulse_zone: "No impulse zone on any pair. If that seems wrong, check candle data.",
};

export function stallMessage(block: Extract<ScanBlock, { kind: "blocked" }>, blockedMinutes: number): string {
  const hours = (blockedMinutes / 60).toFixed(1);
  const hint = HINTS[block.status] ? `\n\n${HINTS[block.status]}` : "";
  return `⚠️ Bot: all ${block.pairs} pairs skipped for ${hours}h of market time — same reason every scan.\n\nReason: ${block.status}${block.reason ? ` (${block.reason.slice(0, 160)})` : ""}${hint}`;
}

/** I/O wrapper. Never throws: a monitoring failure must not fail the scan. */
// deno-lint-ignore no-explicit-any
export async function updateBlockStall(db: any, userId: string, botId: string, details: ScanPairDetail[], notify: (msg: string) => Promise<void>): Promise<void> {
  try {
    const block = classifyScan(details);
    if (block.kind === "benign") return;
    const { data: active, error } = await db.from("scanner_operational_alerts")
      .select("dedupe_key, last_detected_at, evidence")
      .eq("user_id", userId).eq("bot_id", botId).eq("alert_type", STALL_ALERT_TYPE).eq("status", "active");
    if (error) throw new Error(error.message);
    for (const a of (active ?? []) as ActiveStall[]) {
      if (block.kind !== "blocked" || a.dedupe_key !== block.key) {
        await db.rpc("resolve_scanner_operational_alert", { p_user_id: userId, p_bot_id: botId, p_alert_type: STALL_ALERT_TYPE, p_dedupe_key: a.dedupe_key });
      }
    }
    if (block.kind !== "blocked") return;
    const prev = ((active ?? []) as ActiveStall[]).find((a) => a.dedupe_key === block.key) ?? null;
    const s = nextStall(prev, block, new Date());
    const msg = stallMessage(block, s.blockedMinutes);
    const { error: upErr } = await db.rpc("upsert_scanner_operational_alert", {
      p_user_id: userId, p_bot_id: botId, p_alert_type: STALL_ALERT_TYPE, p_dedupe_key: block.key,
      p_severity: s.blockedMinutes >= STALL_NOTIFY_MINUTES ? "critical" : "info",
      p_title: `All pairs blocked: ${block.status}`, p_message: msg, p_evidence: s.evidence,
    });
    if (upErr) throw new Error(upErr.message);
    if (s.shouldNotify) await notify(msg);
  } catch (e) {
    console.warn(`[block-stall] ${userId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
