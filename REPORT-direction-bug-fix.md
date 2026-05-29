# Task: Investigate AUD/JPY SHORT against bullish BOS structure
## Branch: manus/direction-bug-fix

## Behavior changes

1. **Trades are now blocked when 4H trend opposes daily bias.** Previously, if the daily bias was bearish but 4H had already flipped to a bullish trend (with the CHoCH outside the lookback window), the direction engine would return SHORT — allowing a trade against clear 4H bullish structure. Now, the engine checks `h4Structure.trend` directly: if it opposes the daily bias (and is not "ranging"), the trade is blocked with reason "4H trend is {bullish/bearish} (opposes bias) → BLOCKED".

2. **This is a TIGHTER filter** — some trades that previously passed will now be blocked. Specifically: any pair where the daily bias and 4H trend disagree will no longer produce a direction signal. This is the intended behavior (the user explicitly does not want to trade against the main trend on 4H).

## Root cause analysis

### Bug #1: Direction Engine Gap (PRIMARY — caused the AUD/JPY SHORT)

The `is4HRetracing()` function only checked for **recent CHoCH** within a configurable lookback window (default 10 candles) to block trades against the daily bias. The failure scenario:

1. Daily bias = bearish → direction engine wants to go SHORT
2. 4H had a bullish CHoCH (trend flip) **before** the lookback window (e.g., 15+ candles ago)
3. Subsequent bullish breaks on 4H are classified as **BOS** (not CHoCH) because 4H is already bullish
4. `is4HRetracing()` finds NO bullish CHoCH in the recent lookback → `chochAgainst = false`
5. Trade proceeds as SHORT despite 4H being clearly bullish with confirmed BOS above 113.982

**Fix:** Added a direct `h4Structure.trend` check after the CHoCH check. If `h4Structure.trend` opposes the daily bias (and is not "ranging"), the trade is blocked — same as if a CHoCH was detected.

### Bug #2: TIER1_GATE_FAIL in Summary (COSMETIC — not a real gate failure)

The summary string showing "TIER1_GATE_FAIL" is built inside `confluenceScoring.ts` at analysis time, **before** the IZ rescue credits patch `analysis.tieredScoring.tier1GatePassed`. The IZ rescue (lines 4136–4260 in bot-scanner) successfully patches the tiered scoring object, and `runSafetyGates()` (called at line 4430, **after** the rescue) reads the patched value — so Gate 19 actually passes. The summary is simply stale/misleading.

### Bug #3: SL Floor (10.5 pips vs 25 pip minimum — INCONCLUSIVE)

The SL floor code exists at line 4509 and should have widened the 10.5-pip SL to 25 pips for AUD/JPY. Possible explanations:
- The trade was from a deployment before the SL floor was merged
- The reported SL (114.211) may be from the broker's perspective after spread adjustment
- The SL floor code path was not reached (e.g., early return before line 4509)

This requires production logs to confirm. The code as-written is correct.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/directionEngine.ts` | Added 4H trend vs daily bias hard block (10 lines) after the existing CHoCH check at line 314 |
| `supabase/functions/_shared/directionEngine.test.ts` | Added 5 new regression tests for the 4H trend block behavior |

## Extra caution note (directionEngine.ts)

**What changed:** Added a new hard block at line 314–323 that checks `h4Structure.trend` against the daily `bias`. If 4H trend is not "ranging" and does not match the bias, the function returns `direction: null` with `h4ChochAgainst: true` and a descriptive reason.

**Why:** The existing CHoCH lookback check has a blind spot when the CHoCH that flipped 4H happened outside the lookback window. The trend check catches this case by looking at the overall 4H trend (derived from the last 2 swing highs + lows in `analyzeMarketStructure`), which persists regardless of when the CHoCH occurred.

**Risk assessment:** LOW. This is a strictly tighter filter — it can only block trades, never allow new ones. Any trade that was previously blocked by the CHoCH check is still blocked. The new check only catches additional cases where 4H trend opposes daily bias but the CHoCH is outside the lookback window.

## Tests added

| Test | Assertion |
|------|-----------|
| `4H TREND BLOCK: daily bearish + 4H bullish trend → direction blocked (AUD/JPY bug fix)` | Reproduces the exact AUD/JPY scenario: daily bearish, 4H bullish with BOS (CHoCH outside lookback). Verifies direction = null and reason contains "BLOCKED". |
| `4H TREND BLOCK: daily bullish + 4H bearish trend → direction blocked` | Mirror scenario: daily bullish but 4H bearish. Verifies the block works in both directions. |
| `4H TREND BLOCK: daily bearish + 4H ranging → NOT blocked (ranging is neutral)` | Verifies that a ranging 4H does NOT trigger the trend opposition block. |
| `4H TREND BLOCK: daily bearish + 4H bearish → NOT blocked (aligned)` | Verifies that aligned 4H/daily trends do NOT trigger the block. |
| `4H TREND BLOCK: source code contains the trend opposition check` | Structural guard that verifies the fix exists in source code. |

## Tests run

```
$ deno test supabase/functions/_shared/ --allow-read --allow-env --allow-net
ok | 768 passed | 0 failed (13s)
```

## Regression check

1. All 20 existing direction engine tests continue to pass unchanged (including hysteresis tests, CHoCH block tests, and config guard tests).
2. All 743 other tests in `_shared/` pass unchanged (confluenceScoring, smcAnalysis, impulseZone, etc.).
3. The new block only fires when `h4Structure.trend !== "ranging" && h4Structure.trend !== bias` — this is a pure addition that cannot affect existing passing scenarios where 4H aligns with daily.
4. The `h4ChochAgainst: true` flag in the return ensures downstream code (bot-scanner) treats this identically to a CHoCH block — no new code paths needed.

## Open questions

1. **SL floor bypass:** The 10.5-pip SL on the live AUD/JPY trade needs production logs to diagnose. The code is correct but may not have been deployed at the time of the trade, or the trade may have gone through a different path. Recommend checking the Supabase function deployment timestamp vs trade open time.

2. **Summary string staleness:** The TIER1_GATE_FAIL in the summary is cosmetic but confusing for debugging. Consider updating the summary string after IZ rescue credits are applied (separate task, touches `confluenceScoring.ts` which requires permission).

3. **4H fallback as bias source:** When daily is ranging and 4H provides the bias (Option C fallback at line ~250), the new trend check is irrelevant (4H trend = 4H bias by definition). This is correct behavior — no action needed.

## Suggested PR title and description

**Title:** fix: block trades when 4H trend opposes daily bias (AUD/JPY direction bug)

**Description:**
Fixes a critical gap in the direction engine where a SHORT trade was taken on AUD/JPY despite clear bullish BOS on 4H (confirmed above 113.982).

**Root cause:** `is4HRetracing()` only checked for CHoCH within a 10-candle lookback window. When the CHoCH that flipped 4H to bullish happened outside that window, subsequent bullish BOS were not detected as opposing the daily bearish bias.

**Fix:** Added a direct `h4Structure.trend` check after the existing CHoCH check. If 4H trend opposes the daily bias (and is not "ranging"), the trade is blocked.

**Impact:** Strictly tighter filter — blocks trades where 4H disagrees with daily. Cannot allow any new trades. 5 new regression tests added. All 768 existing tests pass.
