# Bot Configuration Sync Audit
## Post-Fixes Assessment (ranging-direction, htf-nested-entry, structure-authority, falling-knife-guard)

---

## EXECUTIVE SUMMARY

**Overall verdict: 85% in sync.** The core logic changes are internally consistent and well-integrated. However, there are **3 real sync issues** (one potentially costing you money), **2 cosmetic mismatches**, and **4 hardcoded thresholds** that should eventually be configurable.

---

## 🔴 REAL SYNC ISSUES (Action Required)

### Issue 1: `normalizedScoring` Default Contradiction
**Severity: MEDIUM — could cause threshold confusion**

| Location | Default Value |
|----------|--------------|
| `DEFAULTS` object (line 148) | `true` |
| Config loading (line 747) | `false` |
| minConfluence auto-scale check (line 701) | assumes `true` |
| UI (BotConfigModal line 134) | `true` |

**What happens:** If your DB has no `normalizedScoring` field stored (which is likely for older configs), the config loading resolves to `false` (line 747's fallback), but the UI shows it as `true`, and the minConfluence auto-scaler assumes `true`. This means:
- The UI thinks scoring is percentage-based (0-100%)
- The backend might be using raw tiered scoring
- The minConfluence auto-scaler might incorrectly scale a value that's already a percentage

**Impact:** In practice, `confluenceScoring.ts` always outputs percentage scores (line 2593: `normalizedScoring: true`), so the scoring engine is fine. The issue is only in the config loading fallback — it's a dead flag that never actually changes behavior. But it's confusing and could bite you if someone explicitly sets it to `false`.

**Fix:** Change line 747 from `?? false` to `?? true` to match everything else.

---

### Issue 2: Gate 1 vs Falling Knife Guard — Overlapping but Different Thresholds
**Severity: LOW-MEDIUM — not losing money, but confusing behavior**

| Protection Layer | Where | Threshold | What It Does |
|-----------------|-------|-----------|--------------|
| Gate 1 (soft mode) | bot-scanner line 926 | Regime ≥ 60% opposing | Blocks the trade at gate level |
| Falling Knife Guard | confluenceScoring line 521 | Regime ≥ 75% opposing | Sets direction = null |

**What happens:** These two protections overlap but fire at different stages:
1. **Falling knife guard** fires FIRST (during direction determination in confluenceScoring). If regime is ≥75% opposing AND the only direction source is P/D zone, direction becomes null → no trade generated at all.
2. **Gate 1** fires SECOND (in bot-scanner). If regime is ≥60% opposing AND daily structure is ranging, it blocks the trade.

**The gap:** If regime is 60-74% opposing:
- Gate 1 blocks it ✓
- But if direction was determined by fractals or daily BOS (not P/D zone), the falling knife guard doesn't fire

This is actually **correct behavior** — the falling knife guard is specifically for P/D zone mean-reversion, while Gate 1 is broader. But it's confusing to debug because you might see a trade blocked by Gate 1 at 62% confidence and wonder "why didn't the falling knife guard catch it?" Answer: because direction came from fractals, not P/D zone.

**Recommendation:** Add a comment in Gate 1 explaining the relationship. No code change needed.

---

### Issue 3: 5 Factors Missing from Weight UI
**Severity: LOW — not losing money, but limits user control**

These factors exist in the scoring engine but have NO weight slider in the UI:

| Factor | Max Weight | Tier | Why Missing |
|--------|-----------|------|-------------|
| HTF POI Alignment | 2.0 | 2 | Added in htf-nested-entry branch |
| HTF Fib + PD + Liquidity | 2.5 | 2 | Added in htf-nested-entry branch |
| Confluence Stack | 1.5 | 2 | Added post-UI build |
| Pullback Health | 0.5 | 3 | Added post-UI build |
| Sweep Reclaim | — | bonus | Enhancement factor |

**Impact:** Users can't tune these factors' weights. They use hardcoded defaults. For HTF POI (2.0) and HTF Fib (2.5), these are significant contributors that can't be adjusted.

**Fix:** Add these to `FACTOR_WEIGHT_DEFS` in BotConfigModal.tsx.

---

## 🟡 COSMETIC MISMATCHES (Low Priority)

### Issue 4: Gate 3 (Structural Conviction) and Gate 3b (Reaction Confirmation) — Not Toggleable
These gates were added in the `structure-authority` branch but have no UI toggle. They're always-on. This is probably fine (they're safety nets), but a user who wants to disable them can't.

### Issue 5: `dailyBias` Weight Mismatch
- `DEFAULT_FACTOR_WEIGHTS.dailyBias` = 1.0 (line 72)
- `FACTOR_MAX_WEIGHT["Daily Bias"]` = 1.5 (line 2264)
- UI shows default weight = 1.0

The max is 1.5 (because Factor 22 can score up to 1.5 with trend strength + recent BOS bonuses), but the default weight is 1.0. This means quality scaling uses 1.5 as denominator, so a "perfect" Daily Bias factor gets quality ratio = 1.0/1.5 = 67%. This slightly underweights Daily Bias in the tiered scoring.

---

## 🟢 THINGS THAT ARE PROPERLY IN SYNC

| Component | Status | Notes |
|-----------|--------|-------|
| Factor 22 (Daily Bias) vs Gate 1 (HTF Bias) | ✅ Aligned | C5 fix properly coordinates them — Factor 22 gives 0 pts in hard veto mode |
| Regime scoring vs direction determination | ✅ Aligned | Regime is never used as a direction generator (structure-authority fix) |
| HTF nested entry vs Tier 1 gate | ✅ Aligned | HTF promotions correctly increment tier1Count for Gate 19 |
| Ranging cap vs Tier 1 gate | ✅ Aligned | Market Structure capped at 1.0 in ranging → quality ratio ≤ 0.4 → can't pass Tier 1 alone |
| FOTSI penalty vs Gate 17 | ✅ Aligned | Gate 17 is info-only, penalty applied upstream to effectiveScore |
| Game plan filter vs config toggle | ✅ Aligned | `gamePlanFilterEnabled` properly respected |
| News filter vs config toggle | ✅ Aligned | `newsFilterEnabled` properly respected |
| Correlation filter vs config toggle | ✅ Aligned | `correlationFilterEnabled` properly respected |
| Factor toggles vs scoring | ✅ Aligned | All `use*` toggles properly skip scoring + exclude from max possible |
| Factor weights vs scoring | ✅ Aligned | `applyWeightScale()` correctly scales based on user-configured weights |
| 100% retracement rejection | ✅ Aligned | Properly zeros out P/D factor when thesis invalidated |
| HTF promotion skip in ranging | ✅ Aligned | `_skipHTFPromotion` correctly blocks when ranging + low regime confidence |

---

## ⚙️ HARDCODED THRESHOLDS (Should Eventually Be Configurable)

| Threshold | Value | Location | What It Controls |
|-----------|-------|----------|-----------------|
| Falling knife regime confidence | 75% | confluenceScoring.ts:521 | Min regime confidence to block P/D mean-reversion |
| Gate 1 soft-mode regime confidence | 60% | bot-scanner:926 | Min regime confidence to block ranging-market trades |
| Structural conviction S2F threshold | 35% | bot-scanner:960 | S2F rate below which structure is "chaotic" |
| Fractal direction threshold | 15% | confluenceScoring.ts:487 | Min fractal delta to determine direction |
| Tier 1 minimum count | 3 | confluenceScoring.ts:2533 | Min core factors required |
| Regime gate failure threshold | -1.0 | confluenceScoring.ts:2149 | Effective adjustment below which regime gate fails |

These are all reasonable defaults, but power users might want to tune them. Low priority.

---

## 🎯 MY HONEST RECOMMENDATIONS (Prioritized)

### Priority 1: Fix the normalizedScoring default (5 min)
Change line 747 in bot-scanner/index.ts from `?? false` to `?? true`. This aligns the fallback with DEFAULTS, UI, and actual scoring behavior. Zero behavior change for your live bot (since your DB likely has it stored), but prevents future confusion.

### Priority 2: Add missing factors to weight UI (30 min)
Add HTF POI Alignment, HTF Fib + PD + Liquidity, Confluence Stack, and Pullback Health to the `FACTOR_WEIGHT_DEFS` array in BotConfigModal.tsx. This gives you control over the new HTF factors.

### Priority 3: Leave everything else alone
The core logic is solid and internally consistent. The falling knife guard, structural conviction gate, and reaction confirmation gate are all working as designed. The threshold values are sensible. Don't over-configure — more knobs = more ways to break things.

### What NOT to do:
- Don't make Gate 3/3b toggleable. They're safety nets that prevent obviously bad trades. Making them optional invites disaster.
- Don't try to "unify" Gate 1 and the falling knife guard into one threshold. They protect against different scenarios at different stages.
- Don't add weight sliders for Sweep Reclaim — it's a bonus enhancement, not a standalone factor.

---

## SUMMARY TABLE

| Category | Count | Verdict |
|----------|-------|---------|
| Real sync issues | 3 | 1 quick fix, 1 comment, 1 UI addition |
| Cosmetic mismatches | 2 | Low priority |
| Properly synced | 12+ | All critical paths aligned |
| Hardcoded thresholds | 6 | Fine for now, configurable later |

**Bottom line:** Your bot's config system is in good shape after the recent fixes. The changes are internally consistent. The one thing I'd fix today is the `normalizedScoring` default contradiction — it's a 5-second change that prevents future headaches.
