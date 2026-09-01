## Goal
Stop the bot from doing things that directly cancel your P&L, without over-restricting trades that can still make money.

## The money-losing case (must block)
**Opposite direction on correlated pairs** — e.g. long EUR/USD + short GBP/USD. They move together, so one wins exactly as the other loses. This is the setup that guarantees you bleed spread/commission for zero net edge. **Block this.**

## The risky-but-profitable case (cap, don't block)
**Same direction on correlated pairs** — e.g. long EUR/USD + long GBP/USD. Both can win together (or lose together). It's not self-sabotage, it's concentration risk. Blocking it entirely means missing real winners. **Allow, but capped** by `maxCorrelatedPositions` so you don't stack 5 EUR-longs at once.

## What changes in the bot
File: `supabase/functions/bot-scanner/index.ts`

Current behavior: correlation filter treats *both* same-direction and opposite-direction correlated trades as conflicts and blocks them.

New behavior:
- Opposite-direction correlated trade → classified as `hedge` conflict → **blocked** (as today).
- Same-direction correlated trade → **allowed**, but still counted toward the `maxCorrelatedPositions` cap so exposure to one correlated cluster stays bounded.
- Uncorrelated pairs → unaffected.

No changes to bot entry logic, SMC signals, or risk sizing — only the correlation gate.

## Defaults
- Correlation filter: **on** by default.
- Threshold: **0.70** (absolute) — catches strong correlations like EUR/USD–GBP/USD without over-flagging looser ones.
- `maxCorrelatedPositions`: **2** — lets same-direction stack a little, prevents a full cluster pile-on.

You can tune these in the bot config modal after it's live.

## Out of scope
- Bot strategy / signal logic (untouched).
- Frontend UI (no changes needed; existing config modal already exposes threshold + max).
