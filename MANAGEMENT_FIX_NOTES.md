# Trade Management Fix Notes

## Bug 1: Config Shape Mismatch (breakEvenTriggerPips vs breakEvenPips)

**Frontend (BotConfigModal + bot-config edge function)** saves:
- `exit.breakEvenTriggerPips` (nested config)

**Backend (bot-scanner/index.ts DEFAULTS)** reads:
- `config.breakEvenPips` (flat config)

**Style classifier (botStyleClassifier.ts)** uses:
- `breakEvenPips`

The bot-scanner's `mapConfig()` or config merge needs to map `breakEvenTriggerPips` → `breakEvenPips`.

## Bug 2: Trailing/BE Activating When Trade is in Negative

In `scannerManagement.ts`:
- **Break-even (line 402)**: Has `rMultiple > 0` guard — CORRECT, won't fire when negative
- **Trailing stop (line 443-468)**: Checks `rMultiple >= activationR` — CORRECT for after_1r/after_2r
  BUT `after_0.5r` maps to 0.5, so it won't fire when negative either.
- **Structure invalidation (line 494)**: Fires when `rMultiple < 0 && rMultiple > -0.8` — this TIGHTENS SL when in negative, which is CORRECT behavior (reduces loss)

**Potential issue**: The STYLE_OVERRIDES in bot-scanner set `trailingStopEnabled: true` and `breakEvenEnabled: true` as DEFAULTS. If the user's saved config doesn't override these, they get applied. The user may not realize the style is setting these.

## Bug 3: Style Overrides Logic

In bot-scanner/index.ts (around line 203-252), STYLE_OVERRIDES are applied.
Need to check HOW they merge with user config — do user overrides win?

## Bug 4: Missing Trade Management UI Section

BotConfigModal has exit fields but user wants a dedicated "Trade Management" section
with clear trailing/BE/partial TP/max hold controls.

## Config Shape Translation Chain

1. Frontend saves nested: `{ exit: { trailingStopEnabled, breakEvenTriggerPips, ... } }`
2. bot-config edge function stores this nested shape in DB
3. bot-scanner loads from DB, needs to flatten/map to runtime shape
4. scannerManagement.ts reads flat: `config.trailingStopEnabled`, `config.breakEvenPips`

The mapping step (3) is where breakEvenTriggerPips → breakEvenPips needs to happen.
