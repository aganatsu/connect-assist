
## What's actually happening

**Image 1 — "FACTORS (9/9)" vs score 8.0/10 with one ✗ visible:**
- The denominator `/9` in BotView is **hardcoded** (`p.text-...`>Factors ({d.factorCount || 0}/9)</p>`) at lines 644 and 709 of `src/pages/BotView.tsx`.
- The bot-scanner now emits **17 factors**, not 9. So `factorCount` (count of present factors) can exceed 9, and the denominator is misleading.
- The "9/9" with one ✗ visible is because the panel only shows the legacy 9 factors in the scrollable area but the numerator counts all present factors across the full 17-factor list — the math no longer adds up visually.
- Score 8.0 with one factor missing is correct: each factor has a weight (0.5–1.5), so missing one ≠ losing exactly 1 point.

**Image 2 — "11/17 factors aligned (score: 9.5/10)":**
- Built in `bot-scanner/index.ts` line 1453: `${presentFactors.length}/${factors.length} factors aligned (score: ${score}/10)`.
- This is **mathematically valid**: factors have weights (0.5, 1.0, 1.5). 11 present factors can sum to 9.5 weighted points (capped at 10). 17 is the new total factor count.
- Not a bug — but the relationship between "11/17" and "9.5/10" isn't obvious to a reader.

## Plan — Fix the count display

### 1. Fix hardcoded `/9` denominator in `src/pages/BotView.tsx`
Replace both occurrences (lines 644 and 709) with the actual factor list length:
```tsx
Factors ({d.factorCount || 0}/{d.factors?.length || 0})
```
This will correctly show "11/17", "9/17", etc.

### 2. Add a small explainer tooltip next to the factor count
Hover/title text: "X factors present out of Y total. Score is weighted (each factor 0.5–1.5 pts), capped at 10."

### 3. Optional polish
- Color the numerator green when ≥ 60% of factors present, amber 40–60%, muted otherwise — matches existing score color scheme.

### Out of scope
- No edge function changes (the summary string in bot-scanner is already correct).
- No re-weighting of factors.

### Files
- `src/pages/BotView.tsx` (2 small string changes + optional tooltip)

### Risk
Trivial — pure label/denominator fix.
