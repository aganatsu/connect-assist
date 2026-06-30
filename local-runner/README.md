# Local Runner — SMC Trading Bot

Run your trading bot locally (Mac Mini, laptop, VPS) instead of relying on Supabase's pg_cron scheduler.

## What This Does

Replaces Supabase's cron scheduler with a local process that calls your Edge Functions on a timer. Your scanner logic, execution, and everything else stays exactly the same — this just changes **who triggers it**.

## Two Approaches

### Approach 1: Hybrid (Recommended to start)

Local scheduler → calls Supabase Edge Functions via HTTP.

- ✅ Zero code changes to scanner/execution
- ✅ Can run alongside Supabase cron (disable pg_cron first to avoid double-scanning)
- ✅ Easy to switch back if something goes wrong
- ❌ Still depends on Supabase for function execution (but DB is free tier)

### Approach 2: Full Local (Future)

Import scanner logic directly, run everything in-process.

- ✅ No cloud dependency at all (except DB)
- ✅ Faster (no HTTP overhead)
- ❌ Requires refactoring Edge Function wrappers
- ❌ More complex setup

## Quick Start (Approach 1)

```bash
# 1. Copy env template
cp local-runner/.env.local.example local-runner/.env.local

# 2. Fill in your Supabase URL and Service Role Key
#    (find these in Supabase Dashboard → Settings → API)
nano local-runner/.env.local

# 3. IMPORTANT: Disable pg_cron in Supabase first!
#    Otherwise you'll get double-scans.
#    Go to: Supabase Dashboard → Database → Extensions → pg_cron → Disable
#    OR: just pause the scheduled tasks in your dashboard

# 4. Run
cd /path/to/connect-assist
deno run --allow-all local-runner/runner.ts

# 5. (Optional) Run with PM2 for auto-restart
pm2 start "deno run --allow-all local-runner/runner.ts" --name smc-bot
pm2 save
pm2 startup  # auto-start on boot
```

## Mac Mini Setup

```bash
# Install Deno
curl -fsSL https://deno.land/install.sh | sh

# Install PM2 (process manager — auto-restarts on crash)
npm install -g pm2

# Clone your repo
git clone https://github.com/aganatsu/connect-assist.git
cd connect-assist

# Set up env
cp local-runner/.env.local.example local-runner/.env.local
nano local-runner/.env.local

# Start the bot
pm2 start "deno run --allow-all local-runner/runner.ts" --name smc-bot --cwd $(pwd)

# Auto-start on boot
pm2 save
pm2 startup

# Check logs
pm2 logs smc-bot

# Check status
pm2 status
```

## macOS Energy Settings

To prevent your Mac Mini from sleeping:

1. System Settings → Energy → Prevent automatic sleeping when display is off → **ON**
2. System Settings → Energy → Start up automatically after a power failure → **ON**

## Market Hours

The runner automatically skips scanning when forex markets are closed (Saturday, Sunday before 21:00 UTC, Friday after 21:00 UTC). Trade management and analytics tasks still run.

## Monitoring

Set up a free [UptimeRobot](https://uptimerobot.com) ping to check your bot is alive:

1. Create a heartbeat monitor
2. Add a simple health-check endpoint (or just ping your Supabase URL)
3. Get alerts via email/SMS if it goes down

## Disabling Tasks

Edit `runner.ts` and set `enabled: false` on any task you don't want to run locally:

```typescript
{
  name: "Weekly Advisor",
  // ...
  enabled: false,  // ← skip this one
},
```

## Logs

All output goes to stdout. With PM2:
- `pm2 logs smc-bot` — live tail
- `pm2 logs smc-bot --lines 100` — last 100 lines
- Logs are stored in `~/.pm2/logs/`
