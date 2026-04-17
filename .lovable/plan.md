
## Recommendation: Dual-threshold gating (score AND count)

### Why both, not either
- **Score alone** (current): 11/17 weighted = 9.5/10 can fire even when key factors miss, because heavy-weighted factors dominate.
- **Count alone**: ignores that some factors matter more (e.g. HTF bias 1.5pt vs spread filter 0.5pt).
- **Both together**: "≥7.5 score AND ≥13/17 factors" → forces broad alignment AND quality. This is how serious ICT traders gate.

### Mapping for your 13/17 question
With current weights (0.5–1.5), 13/17 factors typically score **7.0–9.5/10**. There's no fixed mapping — depends which 13. So the practical answer: set BOTH a count floor (13) and a score floor (~7.5) and you get the strict gate you want.

## Plan

### 1. Add `minFactorCount` to bot config (default 0 = off)
- `BotConfigModal.tsx`: new slider 0–17 under existing "Min Confluence Score" slider, in the Strategy section
- Helper text: "Require at least N of 17 factors to align (in addition to score threshold)"

### 2. Gate logic in `bot-scanner/index.ts`
One additional check after the score gate:
```ts
if ((cfg.minFactorCount ?? 0) > 0 && presentFactors.length < cfg.minFactorCount) {
  reason = `Only ${presentFactors.length}/${factors.length} factors (need ≥${cfg.minFactorCount})`;
  skip;
}
```
Reason string surfaces in scan log so you see why a setup was skipped.

### 3. Show active thresholds on BotView
Small badge above the scan list: `Gate: ≥7.5 score · ≥13/17 factors`. Makes it obvious what's filtering.

### 4. Live mapping helper in modal
Below the two sliders, compute from the last ~20 `scan_logs` entries:
> "Recent scans with ≥13 factors averaged 8.1/10 score (range 7.4–9.5)"
Helps you pick a sensible pair without guessing.

### Out of scope
- No re-weighting of factors
- No change to Chart unified confluence (display-only)
- No DB migration (config_json is already jsonb)

### Files
- `src/components/BotConfigModal.tsx` — slider + helper
- `src/pages/BotView.tsx` — threshold badge
- `supabase/functions/bot-scanner/index.ts` — count gate + reason
- `supabase/functions/bot-config/index.ts` defaults — add `minFactorCount: 0`

### Risk
Low — additive, defaults off, existing behaviour preserved.
