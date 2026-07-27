# Task: GP Hard Gate Stopgap
## Branch: manus/gp-hard-gate-stopgap
## Behavior changes
1. **Trades opposing the game plan bias at >=75% confidence are now hard-blocked.** Previously, all counter-bias trades were allowed through with only a soft scoring penalty. Now, when the game plan's bias confidence for a symbol is >= the `gpHardBlockThreshold` (default: 75%) and the signal direction opposes that bias, the trade is rejected at the gate level.
2. **Trades opposing the game plan bias at <75% confidence are unchanged.** They still pass with a soft penalty logged, exactly as before.
3. **The gate can be disabled** by setting `gpHardBlockThreshold: 0` in config.

## Files modified
- `supabase/functions/_shared/configMapper.ts` — Added `gpHardBlockThreshold` field to RUNTIME_DEFAULTS (default: 75) and mapping in `mapNestedToFlat()` (reads from `strategy.gpHardBlockThreshold ?? raw.gpHardBlockThreshold ?? 75`).
- `supabase/functions/bot-scanner/index.ts` — Replaced the always-pass GP filter gate (lines 5589–5635) with a conditional hard/soft gate. When `gpHardBlockThreshold > 0` and `biasConf >= threshold`, the gate pushes `passed: false`. Includes a 25-line architecture comment documenting: (a) why this is a stopgap, (b) the data justification, (c) what to monitor, (d) when to remove it.
- `supabase/functions/_shared/configMapper.test.ts` — Added 5 tests for `gpHardBlockThreshold` config resolution.
- `supabase/functions/bot-scanner/gpHardGate.test.ts` — New file: 9 tests covering the gate decision logic.

## Tests added
| Test | Asserts |
|------|---------|
| `gpHardBlockThreshold: defaults to 75 when no config is set` | Default config resolution |
| `gpHardBlockThreshold: resolved from strategy section` | Nested config path |
| `gpHardBlockThreshold: raw fallback when strategy section is empty` | Flat config fallback |
| `gpHardBlockThreshold: strategy section takes priority over raw` | Priority order |
| `gpHardBlockThreshold: set to 0 disables the gate` | Disable mechanism |
| `GP hard gate: blocks counter-bias trade when confidence >= threshold (82% >= 75%)` | Core blocking behavior |
| `GP hard gate: allows counter-bias trade when confidence < threshold (60% < 75%)` | Below-threshold passthrough |
| `GP hard gate: allows aligned trade regardless of confidence` | No false positives on aligned trades |
| `GP hard gate: threshold=0 disables the gate entirely (allows all)` | Runtime disable |
| `GP hard gate: exact threshold boundary (70% >= 70% → blocks)` | Boundary condition |
| `GP hard gate: just below threshold (70% < 71% → allows)` | Off-by-one correctness |
| `GP hard gate: pair not in game plan → always passes` | Missing pair handling |
| `GP hard gate: null game plan → always passes` | No game plan handling |
| `GP hard gate: regression — today's GBP/USD trade would have been blocked` | Jul 27 scenario replay |

## Tests run
```
ok | 2242 passed | 0 failed (23s)
```
All existing tests pass. 14 new tests added (5 config + 9 behavior).

## Regression check
- **Aligned trades:** Unaffected — the gate only fires when `gpFilter.allowed === false` (counter-bias). Aligned trades take the `else` branch and always pass.
- **Counter-bias trades below threshold:** Unaffected — they take the `biasConf < gpThreshold` branch which produces identical output to the previous code (same `passed: true`, same reason string format).
- **Counter-bias trades at/above threshold:** NEW behavior — these are now blocked. This is the intended change.
- **No game plan active:** Unaffected — the entire `if (activeGamePlan)` block is skipped.
- **Threshold=0:** Disables the gate entirely, reverting to previous always-pass behavior.

## Open questions
1. **Step 4 (Direction Verdict GP reweight):** Scheduled as a separate task. Requires backtest validation before deployment. Once deployed, revisit whether this stopgap is still needed.
2. **Asset class splitting:** As more data accumulates in the 75%+ bucket, the pattern may differ between gold/commodities (large pip moves) and forex (small mean-reversion). Consider splitting the threshold by instrument type if the data supports it.
3. **Dashboard UI:** The `gpHardBlockThreshold` field is not yet exposed in the config UI. It can be set via direct DB edit (`config_json.strategy.gpHardBlockThreshold`) or will use the default of 75.

## Suggested PR title and description
**Title:** feat: conditional GP hard gate — block counter-bias trades at >=75% bias confidence

**Description:**
Adds a configurable hard gate that blocks trades opposing the game plan when bias confidence is high (>=75% by default).

**Context:** On Jul 27, the bot went long GBP/USD against an 82% bearish game plan bias and lost $505. The GP filter was soft-only (scoring penalty), which was insufficient to prevent the trade.

**Data analysis (n=76 trades with GP data):**
- 75%+ counter-bias bucket: 7 trades, 4W/3L, 57.1% WR
- Excluding one XAU/USD outlier (+$1,028): 6 trades, net +$7 — effectively flat
- The data is genuinely neutral; this gate is justified because a flat-EV trade category with high-conviction opposition is not worth the risk

**This is a labeled stopgap.** The proper fix is reweighting GP bias in the Direction Verdict from 0.08 to ~0.20 (Step 4, separate task requiring backtest validation). Once that's deployed, this gate should be revisited for redundancy.

**Config:** `strategy.gpHardBlockThreshold` (default: 75, set to 0 to disable)
