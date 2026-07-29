# Redeploy All Edge Functions

Redeploy all 24 edge functions in the project to pick up the latest code.

## Functions to deploy

advisor, backtest-engine, bot-config, bot-daily-review, bot-scanner, bot-weekly-advisor, broker-connections, broker-execute, data-cleanup, fundamentals, game-plan-refresh, market-data, optimizer, outcome-tracker, paper-trading, prop-firm, prop-firm-daily-reset, scheduled-tasks, smc-analysis, strategy-advisor, telegram-notify, trades, user-settings, zone-confirmation-scanner

## Technical

Single `supabase--deploy_edge_functions` call with all 24 function names. No code changes.
