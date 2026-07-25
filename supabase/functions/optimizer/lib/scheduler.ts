/**
 * Scheduler — Deduplication and timing logic for the optimizer.
 * 
 * The actual cron trigger is set up via Supabase pg_cron migration
 * (see: migrations/20260724120001_add_optimizer_weekly_cron.sql).
 * 
 * This module provides:
 * - Deduplication helpers (has it run this week?)
 * - Run lifecycle tracking (start/complete/fail)
 * - Schedule info for the CLI
 * 
 * Trigger options:
 * 1. Supabase pg_cron (production — migration already applied)
 * 2. External cron service calling the edge function
 * 3. Manual CLI invocation
 */

// ─── Types ───

export interface OptimizerRunRecord {
  id: string;
  user_id: string;
  status: "running" | "completed" | "failed";
  started_at: string;
  completed_at?: string;
  trials_count?: number;
  baseline_score?: number;
  best_score?: number;
  improvement_percent?: number;
  auto_applied?: boolean;
  reject_reason?: string;
  config_snapshot?: Record<string, any>;
  result_summary?: Record<string, any>;
  error_message?: string;
}

// ─── Deduplication ───

/**
 * Check if the optimizer has already run this week for the given user.
 * Returns the most recent run if found, null otherwise.
 */
export async function getRecentRun(
  supabaseUrl: string,
  supabaseKey: string,
  userId: string,
): Promise<OptimizerRunRecord | null> {
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  const url = `${supabaseUrl}/rest/v1/optimizer_runs?user_id=eq.${userId}&started_at=gte.${oneWeekAgo}&status=in.(running,completed)&order=started_at.desc&limit=1`;

  const response = await fetch(url, {
    headers: {
      "apikey": supabaseKey,
    },
  });

  if (!response.ok) return null;

  const data = await response.json();
  return data.length > 0 ? data[0] : null;
}

/**
 * Check if it's a valid time to run (Sunday 20:00-23:59 UTC).
 * Provides a wider window than the exact cron time for manual triggers.
 */
export function isValidRunWindow(): boolean {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday
  const hour = now.getUTCHours();
  return day === 0 && hour >= 20;
}

/**
 * Should the optimizer run now? Combines time check + dedup.
 * Used by the CLI for manual scheduling decisions.
 */
export async function shouldRunNow(
  supabaseUrl: string,
  supabaseKey: string,
  userId: string,
  ignoreTimeWindow = false,
): Promise<{ shouldRun: boolean; reason: string }> {
  // Check time window (skip for manual/forced runs)
  if (!ignoreTimeWindow && !isValidRunWindow()) {
    return { shouldRun: false, reason: "Outside valid run window (Sunday 20:00-23:59 UTC)" };
  }

  // Check deduplication
  const recentRun = await getRecentRun(supabaseUrl, supabaseKey, userId);
  if (recentRun) {
    if (recentRun.status === "running") {
      return { shouldRun: false, reason: `Run already in progress (${recentRun.id})` };
    }
    return { shouldRun: false, reason: `Already completed this week (${recentRun.id} at ${recentRun.started_at})` };
  }

  return { shouldRun: true, reason: "Ready to run" };
}

// ─── Run Lifecycle ───

/**
 * Record the start of an optimizer run.
 */
export async function recordRunStart(
  supabaseUrl: string,
  supabaseKey: string,
  userId: string,
  configSnapshot?: Record<string, any>,
): Promise<string | null> {
  const url = `${supabaseUrl}/rest/v1/optimizer_runs`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "apikey": supabaseKey,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
    },
    body: JSON.stringify({
      user_id: userId,
      status: "running",
      config_snapshot: configSnapshot ?? null,
    }),
  });

  if (!response.ok) return null;

  const data = await response.json();
  return data[0]?.id ?? null;
}

/**
 * Record the completion of an optimizer run.
 */
export async function recordRunComplete(
  supabaseUrl: string,
  supabaseKey: string,
  runId: string,
  summary: {
    trialsCount: number;
    baselineScore: number;
    bestScore: number | null;
    improvementPercent: number;
    autoApplied: boolean;
    rejectReason?: string;
    resultSummary?: Record<string, any>;
  },
): Promise<void> {
  const url = `${supabaseUrl}/rest/v1/optimizer_runs?id=eq.${runId}`;
  await fetch(url, {
    method: "PATCH",
    headers: {
      "apikey": supabaseKey,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify({
      status: "completed",
      completed_at: new Date().toISOString(),
      trials_count: summary.trialsCount,
      baseline_score: summary.baselineScore,
      best_score: summary.bestScore,
      improvement_percent: summary.improvementPercent,
      auto_applied: summary.autoApplied,
      reject_reason: summary.rejectReason ?? null,
      result_summary: summary.resultSummary ?? null,
    }),
  });
}

/**
 * Record a failed optimizer run.
 */
export async function recordRunFailed(
  supabaseUrl: string,
  supabaseKey: string,
  runId: string,
  errorMessage: string,
): Promise<void> {
  const url = `${supabaseUrl}/rest/v1/optimizer_runs?id=eq.${runId}`;
  await fetch(url, {
    method: "PATCH",
    headers: {
      "apikey": supabaseKey,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: errorMessage,
    }),
  });
}

// ─── Schedule Info ───

/**
 * Get the cron expression for the optimizer schedule.
 * Used for display purposes in the CLI.
 */
export function getCronExpression(): string {
  return "0 22 * * 0"; // Every Sunday at 22:00 UTC
}

/**
 * Get the next scheduled run time.
 */
export function getNextRunTime(): Date {
  const now = new Date();
  const daysUntilSunday = (7 - now.getUTCDay()) % 7 || 7;
  const nextSunday = new Date(now);
  nextSunday.setUTCDate(now.getUTCDate() + daysUntilSunday);
  nextSunday.setUTCHours(22, 0, 0, 0);
  if (nextSunday <= now) {
    nextSunday.setUTCDate(nextSunday.getUTCDate() + 7);
  }
  return nextSunday;
}
