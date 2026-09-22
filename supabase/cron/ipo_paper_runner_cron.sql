-- Scheduled PAPER mode for the IPO strategy. Run ONCE, by hand.
--
-- PAPER ONLY. This schedules ipo-paper-runner and nothing else. It places no
-- broker order, touches no SMC table, and writes only the three IPO-owned
-- tables plus its own kv_cache rows. There is no LIVE or CANARY path to enable.
--
-- CADENCE: every 15 minutes.
--
-- Latency here is a freshness choice, not a correctness one. The runner
-- processes CLOSED bars and only bars newer than each instrument's own cursor,
-- so a bar processed fifteen minutes late produces exactly the same decision as
-- one processed immediately — the engine is bar-driven, not clock-driven. What
-- the cadence buys is how quickly the UI and the paper record catch up.
--
--   USD/JPY 30min   worst-case 15 min behind the close
--   EUR/USD 1h      worst-case 15 min behind
--   BTC/USD 1h      worst-case 15 min behind
--
-- COST. Each invocation makes ONE provider request per instrument — three per
-- run, 288 per day. That matters here: the SMC scanner is already refusing
-- fetches against the credit budget, so this is deliberately not every 5
-- minutes. Halving to '*/30' halves the spend and costs only freshness.
--
-- A run with no new closed bar is a genuine no-op: it restores, fetches the
-- overlap page, finds nothing after the cursor, and returns without writing.
-- Measured: 0 processed, 0 events, persist 0 ms, both state rows untouched.
--
-- PREREQUISITES, the same three Vault secrets the other jobs use:
--   supabase_url, service_role_key, cron_secret
-- and the engine state must already exist — the runner FAILS CLOSED with
-- BOOTSTRAP_REQUIRED rather than attempting a 1,200-bar rebuild it cannot
-- afford on Edge. Cold start is local-runner/ipo-bootstrap.ts.
--
-- Verify with:  select jobname, schedule, active from cron.job where jobname like 'ipo%';
-- Unschedule with:  select cron.unschedule('ipo-paper-runner-15min');

select cron.schedule('ipo-paper-runner-15min', '*/15 * * * *', $job$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/ipo-paper-runner',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
$job$);

-- NOT SCHEDULED, deliberately:
--   ipo-observation    a pure read surface. Nothing needs to poll it but a
--                      browser, and it advances nothing.
--   ipo-paper-state    likewise.
--   ipo-bootstrap      cold start only, and it runs off-Edge because a
--                      1,200-bar rebuild costs ~17s of CPU. If it ever needs to
--                      be periodic it belongs on the local runner, not here.
