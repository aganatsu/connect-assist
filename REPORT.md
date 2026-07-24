# Task: Autonomous Optimizer (Part B)

## Branch: manus/autonomous-optimizer

## Behavior changes

none — pure addition (new module). No existing files modified. The optimizer is a standalone Deno CLI tool that reads from and writes to Supabase; it does not alter any live scanner, backtest engine, or broker execution code.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/optimizer/lib/tpe.ts` | Tree-structured Parzen Estimator algorithm — seeded PRNG, KDE, l/g split, EI maximization |
| `supabase/functions/optimizer/lib/parameterSpace.ts` | Full 65-parameter space definition (25 factor weights + 40 core), bounds, paramsToConfig/configToParams converters, validateParams, enforceMaxDelta safety rail |
| `supabase/functions/optimizer/lib/optimizationLoop.ts` | OptimizationLoop class — samples from TPE, runs backtest, evaluates composite score, tracks best trial, determines auto-apply eligibility |
| `supabase/functions/optimizer/lib/backtestRunner.ts` | Bridge between optimizer and backtest engine — createBacktestRunner factory, extractBacktestResult normalizer, prefetchCandleData, fetchCurrentConfig |
| `supabase/functions/optimizer/lib/autoApply.ts` | Auto-apply logic — safety gates (walk-forward robust, >15% improvement), config backup, Supabase write, Telegram notification, rollback support |
| `supabase/functions/optimizer/lib/scheduler.ts` | Weekly scheduler — shouldRunNow, hasRunThisWeek dedup, run recording, pg_cron setup SQL |
| `supabase/functions/optimizer/cli.ts` | CLI entry point — argument parsing, config loading, progress display, result persistence |
| `supabase/functions/optimizer/config.json` | Default optimizer configuration |
| `supabase/functions/optimizer/optimizer.test.ts` | 33 tests covering TPE, parameter space, composite scoring, optimization loop, backtest runner |
| `REPORT.md` | This report |

## Tests added

| Test | Assertion |
|------|-----------|
| TPE: uniform sampling during startup phase | All params within bounds during random phase |
| TPE: categorical sampling respects choices | Only valid choices returned |
| TPE: tell records trials correctly | Trial ID, params, score stored |
| TPE: getBest returns highest scoring trial | Correct trial identified |
| TPE: loadTrials enables warm-starting | Historical trials loaded, TPE uses informed sampling |
| TPE: converges toward optimum with simple quadratic | Best x within 1.5 of true optimum (x=3) |
| TPE: deterministic with same seed | Identical outputs with same seed |
| ParameterSpace: full space has ~65+ parameters | Count within expected range |
| ParameterSpace: core space is smaller than full | Core subset properly filtered |
| ParameterSpace: all specs have valid bounds | low < high, choices >= 2 |
| ParameterSpace: factor weight params have fw_ prefix | Naming convention enforced |
| ParameterSpace: paramsToConfig correctly maps factor weights | fw_ to factorWeights object |
| ParameterSpace: configToParams extracts factor weights | Inverse mapping works |
| ParameterSpace: paramsToConfig to configToParams roundtrip | Lossless conversion |
| ParameterSpace: validateParams catches minRR > tpRatio | Constraint violation detected |
| ParameterSpace: validateParams catches conflictThresholdRaise >= conflictBlockAt | Constraint violation detected |
| ParameterSpace: validateParams catches trending <= ranging | Constraint violation detected |
| ParameterSpace: validateParams passes valid config | No false positives |
| ParameterSpace: enforceMaxDelta clamps within +/-50% | Numerical clamping correct |
| ParameterSpace: enforceMaxDelta preserves categorical values | Non-numeric values untouched |
| CompositeScore: returns 0 for fewer than 5 trades | Guard against low sample size |
| CompositeScore: returns 0 for negative expectancy | Guard against losing configs |
| CompositeScore: returns 0 for zero profit factor | Guard against division issues |
| CompositeScore: correct formula for healthy result | Exact formula verification |
| CompositeScore: drawdown penalty kicks in above 15% | Penalty factor = 0.7 at 30% DD |
| CompositeScore: trade count bonus penalizes few trades | 15 trades = 0.5x multiplier |
| CompositeScore: uses 0.5 default when no walk-forward data | Graceful degradation |
| OptimizationLoop: runs with mock backtest and finds improvement | End-to-end loop execution |
| OptimizationLoop: rejects configs that fail walk-forward | Fragile configs hard-rejected |
| OptimizationLoop: handles backtest errors gracefully | Errors caught, recorded as score 0 |
| extractBacktestResult: maps engine output correctly | All fields extracted + stddev computed |
| extractBacktestResult: handles missing walk-forward | Undefined when no WF data |
| Integration: optimizer improves over baseline with deterministic mock | TPE finds better config |

## Tests run

```
# Optimizer tests
ok | 33 passed | 0 failed (31ms)

# Backtest engine tests (regression check)
ok | 209 passed | 0 failed (1s)

# Bot scanner tests (regression check)
ok | 131 passed | 0 failed (1s)

# TypeScript type checking — all 6 modules pass with 0 errors
Check supabase/functions/optimizer/lib/tpe.ts
Check supabase/functions/optimizer/lib/parameterSpace.ts
Check supabase/functions/optimizer/lib/optimizationLoop.ts
Check supabase/functions/optimizer/lib/backtestRunner.ts
Check supabase/functions/optimizer/lib/autoApply.ts
Check supabase/functions/optimizer/lib/scheduler.ts
```

## Regression check

- All 209 backtest-engine tests pass (unchanged)
- All 131 bot-scanner tests pass (unchanged)
- Zero TypeScript errors in all new optimizer modules
- No existing files were modified — this is a pure addition

## Open questions

1. **Backtest engine integration**: The `backtestRunner.ts` currently has a placeholder for the actual backtest engine import. The real integration requires importing the backtest engine's `runBacktest` function directly. This needs to be wired once the backtest engine exposes a clean importable function (currently it's an HTTP handler). Should we create a wrapper that extracts the core logic, or should the optimizer call the edge function via HTTP?

2. **Supabase tables**: The optimizer assumes two tables exist:
   - `config_backups` (for storing config snapshots before auto-apply)
   - `optimizer_runs` (for tracking run history and dedup)
   These need to be created via migration. Should I add the SQL migration in a follow-up commit?

3. **Telegram credentials**: The bot token and chat ID need to be configured. Should these go in the optimizer config.json or as environment variables on the machine running the optimizer?

4. **pg_cron vs external cron**: The scheduler module provides SQL for pg_cron setup. Alternatively, the CLI can be triggered by an external cron job (e.g., systemd timer on a VPS). Which approach do you prefer?

## Suggested PR title and description

**Title:** `feat: Add autonomous TPE optimizer with walk-forward validation`

**Description:**
Adds a standalone Deno CLI optimizer that uses Tree-structured Parzen Estimation (TPE) to find better trading configurations.

**Key features:**
- TPE algorithm with seeded PRNG for reproducibility
- Full 65-parameter search space (25 factor weights + 40 core strategy params)
- Composite scoring: Expectancy x sqrt(ProfitFactor) x ConsistencyScore x drawdownPenalty x tradeCountBonus
- Walk-forward validation gate: "fragile" configs hard-rejected, "robust" auto-applied
- Safety rails: +/-50% max delta per cycle, config backup before apply, constraint validation
- Semi-automatic approval: auto-applies if >15% improvement + walk-forward robust
- Telegram notifications for apply/reject decisions
- Weekly scheduler with dedup (pg_cron or external cron)
- CLI with --dry-run, --trials, --core-only, --verbose options
- 33 new tests, all passing

**Architecture:**
```
optimizer/
├── cli.ts              # Entry point
├── config.json         # Default config
├── optimizer.test.ts   # 33 tests
└── lib/
    ├── tpe.ts              # TPE algorithm
    ├── parameterSpace.ts   # 65 tunable params
    ├── optimizationLoop.ts # Core loop
    ├── backtestRunner.ts   # Backtest bridge
    ├── autoApply.ts        # Apply + notify
    └── scheduler.ts        # Weekly scheduling
```

**Next steps:**
- Wire backtest engine integration (import vs HTTP)
- Create Supabase migration for config_backups + optimizer_runs tables
- Configure Telegram bot credentials
- Set up weekly cron trigger
