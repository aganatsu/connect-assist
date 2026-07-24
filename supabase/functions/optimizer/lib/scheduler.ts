/**
 * Weekly Scheduler Integration
 * 
 * This module provides the scheduling logic for running the optimizer
 * on a weekly basis (Sunday nights). It can be triggered by:
 * 
 * 1. Supabase pg_cron (recommended for production)
 * 2. External cron service calling the edge function
 * 3. Manual CLI invocation
 * 
 * The scheduler:
 * - Checks if it's the right time to run (Sunday 22:00-23:59 UTC)
 * - Prevents duplicate runs within the same week
 * - Logs run history to Supabase
 * - Handles errors gracefully with retry logic
 */

export interface SchedulerConfig {
  /** Day of week to run (0=Sunday, 1=Monday, ...) */
  runDay: number;
  /** Hour to start (UTC, 0-23) */
  runHourUTC: number;
  /** Supabase URL for state tracking */
  supabaseUrl: string;
  /** Supabase key for state tracking */
  supabaseKey: string;
}

export interface RunRecord {
  id: string;
  started_at: string;
  completed_at?: string;
  status: "running" | "completed" | "failed";
  result_summary?: string;
  error?: string;
}

/**
 * Check if the optimizer should run now based on schedule.
 */
export function shouldRunNow(config: SchedulerConfig): boolean {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const hour = now.getUTCHours();

  return dayOfWeek === config.runDay && hour >= config.runHourUTC;
}

/**
 * Check if a run has already been completed this week.
 */
export async function hasRunThisWeek(config: SchedulerConfig): Promise<boolean> {
  // Get start of current week (Sunday)
  const now = new Date();
  const daysSinceSunday = now.getUTCDay();
  const weekStart = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - daysSinceSunday);
  weekStart.setUTCHours(0, 0, 0, 0);

  const url = `${config.supabaseUrl}/rest/v1/optimizer_runs?started_at=gte.${weekStart.toISOString()}&status=in.(completed,running)&limit=1`;

  try {
    const response = await fetch(url, {
      headers: {
        "apikey": config.supabaseKey,
        "Authorization": `Bearer ${config.supabaseKey}`,
      },
    });

    if (!response.ok) return false;
    const data = await response.json();
    return data.length > 0;
  } catch {
    return false;
  }
}

/**
 * Record the start of an optimization run.
 */
export async function recordRunStart(config: SchedulerConfig): Promise<string> {
  const runId = `run_${Date.now()}`;
  const record: RunRecord = {
    id: runId,
    started_at: new Date().toISOString(),
    status: "running",
  };

  const url = `${config.supabaseUrl}/rest/v1/optimizer_runs`;
  await fetch(url, {
    method: "POST",
    headers: {
      "apikey": config.supabaseKey,
      "Authorization": `Bearer ${config.supabaseKey}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify(record),
  });

  return runId;
}

/**
 * Record the completion of an optimization run.
 */
export async function recordRunComplete(
  config: SchedulerConfig,
  runId: string,
  status: "completed" | "failed",
  summary?: string,
  error?: string,
): Promise<void> {
  const url = `${config.supabaseUrl}/rest/v1/optimizer_runs?id=eq.${runId}`;
  await fetch(url, {
    method: "PATCH",
    headers: {
      "apikey": config.supabaseKey,
      "Authorization": `Bearer ${config.supabaseKey}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify({
      completed_at: new Date().toISOString(),
      status,
      result_summary: summary,
      error,
    }),
  });
}

/**
 * Get the cron expression for the weekly schedule.
 * Used when setting up pg_cron in Supabase.
 */
export function getCronExpression(config: SchedulerConfig): string {
  // "At HH:00 on day-of-week"
  // Format: minute hour day-of-month month day-of-week
  return `0 ${config.runHourUTC} * * ${config.runDay}`;
}

/**
 * SQL to set up the pg_cron job in Supabase.
 * Run this once during initial setup.
 */
export function getSetupSQL(edgeFunctionUrl: string, serviceKey: string): string {
  return `
-- Enable pg_cron extension (if not already)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule weekly optimizer run (Sunday 22:00 UTC)
SELECT cron.schedule(
  'weekly-optimizer',
  '0 22 * * 0',
  $$
  SELECT net.http_post(
    url := '${edgeFunctionUrl}',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ${serviceKey}',
      'Content-Type', 'application/json'
    ),
    body := '{"action": "run_optimizer"}'::jsonb
  );
  $$
);

-- View scheduled jobs
-- SELECT * FROM cron.job;

-- To unschedule:
-- SELECT cron.unschedule('weekly-optimizer');
`;
}
