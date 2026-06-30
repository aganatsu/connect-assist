/**
 * Local Standalone Runner for SMC Trading Bot
 * 
 * Replaces Supabase Edge Functions + pg_cron with a single local process.
 * Run with: deno run --allow-all local-runner/runner.ts
 * 
 * This does NOT modify any scanner/execution logic — it simply calls the same
 * functions on a timer, exactly like Supabase's cron does in the cloud.
 * 
 * Prerequisites:
 *   1. Copy .env.local.example → .env.local and fill in your keys
 *   2. Ensure PostgreSQL is running (local or remote Supabase)
 *   3. Run: deno run --allow-all local-runner/runner.ts
 */

import "https://deno.land/std@0.224.0/dotenv/load.ts";

// ─── Configuration ────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment");
  console.error("   Copy .env.local.example → .env.local and fill in your values");
  Deno.exit(1);
}

// ─── Schedule Definition ──────────────────────────────────────────────────────

interface ScheduledTask {
  name: string;
  functionName: string;
  action: string;
  intervalMs: number;
  lastRun: number;
  enabled: boolean;
}

const tasks: ScheduledTask[] = [
  {
    name: "Bot Scanner",
    functionName: "bot-scanner",
    action: "scan",
    intervalMs: 5 * 60 * 1000,  // every 5 minutes
    lastRun: 0,
    enabled: true,
  },
  {
    name: "Trade Management",
    functionName: "bot-scanner",
    action: "manage",
    intervalMs: 1 * 60 * 1000,  // every 1 minute
    lastRun: 0,
    enabled: true,
  },
  {
    name: "Zone Confirmation (Fast)",
    functionName: "zone-confirmation-scanner",
    action: "scan",
    intervalMs: 1 * 60 * 1000,  // every 1 minute
    lastRun: 0,
    enabled: true,
  },
  {
    name: "Outcome Tracker",
    functionName: "outcome-tracker",
    action: "track",
    intervalMs: 60 * 60 * 1000,  // every 1 hour
    lastRun: 0,
    enabled: true,
  },
  {
    name: "Daily Review",
    functionName: "bot-daily-review",
    action: "review",
    intervalMs: 24 * 60 * 60 * 1000,  // every 24 hours
    lastRun: 0,
    enabled: true,
  },
  {
    name: "Weekly Advisor",
    functionName: "bot-weekly-advisor",
    action: "advise",
    intervalMs: 7 * 24 * 60 * 60 * 1000,  // every 7 days
    lastRun: 0,
    enabled: true,
  },
  {
    name: "Prop Firm Daily Reset",
    functionName: "prop-firm-daily-reset",
    action: "reset",
    intervalMs: 24 * 60 * 60 * 1000,  // every 24 hours
    lastRun: 0,
    enabled: true,
  },
  {
    name: "Data Cleanup",
    functionName: "data-cleanup",
    action: "cleanup",
    intervalMs: 24 * 60 * 60 * 1000,  // every 24 hours
    lastRun: 0,
    enabled: true,
  },
];

// ─── Task Executor ────────────────────────────────────────────────────────────

async function invokeFunction(functionName: string, action: string): Promise<void> {
  const url = `${SUPABASE_URL}/functions/v1/${functionName}`;
  
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ action }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`  ❌ ${functionName}/${action} failed (${response.status}): ${text.slice(0, 200)}`);
    } else {
      const data = await response.json().catch(() => ({}));
      console.log(`  ✅ ${functionName}/${action} completed`, data.message || "");
    }
  } catch (error) {
    console.error(`  ❌ ${functionName}/${action} network error:`, (error as Error).message);
  }
}

// ─── Main Loop ────────────────────────────────────────────────────────────────

function formatTime(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function isMarketOpen(): boolean {
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  
  // Forex market: Sunday 21:00 UTC → Friday 21:00 UTC
  if (day === 6) return false; // Saturday — fully closed
  if (day === 0 && hour < 21) return false; // Sunday before open
  if (day === 5 && hour >= 21) return false; // Friday after close
  
  return true;
}

console.log("═══════════════════════════════════════════════════════");
console.log("  SMC Trading Bot — Local Runner");
console.log("═══════════════════════════════════════════════════════");
console.log(`  Supabase: ${SUPABASE_URL}`);
console.log(`  Tasks: ${tasks.filter(t => t.enabled).length} active`);
console.log(`  Market: ${isMarketOpen() ? "🟢 OPEN" : "🔴 CLOSED"}`);
console.log("═══════════════════════════════════════════════════════");
console.log("");
console.log("  Schedule:");
for (const task of tasks) {
  console.log(`    ${task.enabled ? "●" : "○"} ${task.name} — every ${formatTime(task.intervalMs)}`);
}
console.log("");
console.log("  Press Ctrl+C to stop.");
console.log("───────────────────────────────────────────────────────");
console.log("");

// Main tick — runs every 10 seconds, checks if any task is due
const TICK_INTERVAL = 10_000; // 10 seconds

setInterval(async () => {
  const now = Date.now();
  
  for (const task of tasks) {
    if (!task.enabled) continue;
    
    // Skip scanning tasks when market is closed (management/analytics still run)
    if (!isMarketOpen() && task.functionName === "bot-scanner" && task.action === "scan") {
      continue;
    }
    
    if (now - task.lastRun >= task.intervalMs) {
      task.lastRun = now;
      const timestamp = new Date().toLocaleTimeString();
      console.log(`[${timestamp}] Running: ${task.name}`);
      
      // Run async — don't block other tasks
      invokeFunction(task.functionName, task.action).catch((err) => {
        console.error(`[${timestamp}] Unhandled error in ${task.name}:`, err);
      });
    }
  }
}, TICK_INTERVAL);

// Keep process alive
await new Promise(() => {});
