# Bot Entity Lifecycle Audit

## Audit Scope

Every analytical entity in the bot system should ideally track a lifecycle: **created → active → tested → invalidated/confirmed**. This audit examines each entity to determine what lifecycle tracking exists, what's missing, and what improvements are recommended.

## Reference: Entities with Mature Lifecycles

### Staged Setups (✅ Gold Standard)
- **States**: `watching` → `promoted` | `expired` | `invalidated`
- **Fields**: `status`, `staged_at`, `last_eval_at`, `resolved_at`, `scan_cycles`, `min_cycles`, `ttl_minutes`, `promotion_reason`, `invalidation_reason`, `current_score`, `gate_score`
- **Transitions**: Score gate met + min cycles → promoted. TTL expiry → expired. SL breach / direction reversal / score drop → invalidated.
- **Frontend**: Full WatchlistPanel with TTL countdown, score progress, factor checklist, history badges.
- **Verdict**: Complete lifecycle. Use as reference model.

### Pending Orders (✅ Gold Standard)
- **States**: `pending` → `filled` | `expired` | `cancelled`
- **Fields**: `status`, `created_at`, `filled_at`, `resolved_at`, `fill_reason`, `cancel_reason`, `from_watchlist`, `staged_cycles`, `current_price`, `ttl_minutes`
- **Transitions**: Price touch → filled. TTL expiry → expired. SL breach / manual cancel → cancelled.
- **Frontend**: Full PendingOrdersPanel with price distance, expiry progress, history badges.
- **Verdict**: Complete lifecycle. Use as reference model.

### BOS-Derived S/R (✅ New — Just Added)
- **States**: `active` (unbroken) | `broken`
- **Fields**: `price`, `type` (support/resistance), `broken` (boolean)
- **Transitions**: Created from BOS event → active. Candle closes through level → broken.
- **Frontend**: Structure Intelligence panel shows active (green/red) and broken (strikethrough).
- **Verdict**: Good lifecycle for a derived entity. Could be enhanced with `testedCount` and `createdAt` index.

---

## Entities Needing Lifecycle Improvements

### 1. Order Blocks (⚠️ Partial Lifecycle)

**Current State**:
- `mitigated: boolean` — binary, set when price retraces 50%+ into the OB zone
- `mitigatedPercent: number` — continuous 0-100%, tracks how deeply price has entered the zone
- `hasDisplacement`, `hasFVGAdjacency`, `hasVolumePivot` — quality flags (static, set at creation)

**What's Missing**:
- **No "tested" state**: When price approaches the OB edge but doesn't penetrate 50%, it's a "test" — this is valuable information (tested OBs that hold are stronger)
- **No "broken" state**: Once mitigatedPercent reaches 100% and price closes through, the OB should be marked "broken" (invalidated), not just "mitigated"
- **No `testedCount`**: How many times price has tested the OB edge without fully mitigating it
- **No timestamp tracking**: When was it first tested? When was it mitigated? When was it broken?

**Recommended Additions to `OrderBlock` interface**:
```typescript
  state: "fresh" | "tested" | "mitigated" | "broken";
  testedCount: number;        // times price entered zone but didn't close through 50%
  firstTestedAt?: number;     // candle index of first test
  mitigatedAt?: number;       // candle index when mitigatedPercent crossed 50%
  brokenAt?: number;          // candle index when price closed fully through the zone
```

**Scoring Impact**: Fresh OBs (never tested) get full weight. Tested-and-held OBs get a bonus. Mitigated OBs get reduced weight (already exists via mitigatedPercent scaling). Broken OBs should be excluded entirely.

---

### 2. Fair Value Gaps (⚠️ Partial Lifecycle)

**Current State**:
- `mitigated: boolean` — binary, set when ANY candle enters the gap zone
- `quality: number` — 0-8 score (static, set at creation)

**What's Missing**:
- **No partial fill tracking**: A bullish FVG that's 30% filled is very different from one that's 80% filled. Currently it's all-or-nothing.
- **No "respected" state**: When price approaches the FVG edge but bounces, that's a "respect" — the FVG acted as S/R
- **No `fillPercent`**: Continuous measure of how much of the gap has been filled
- **No timestamp tracking**: When was it first tested? When was it fully filled?

**Recommended Additions to `FairValueGap` interface**:
```typescript
  state: "open" | "partially_filled" | "respected" | "filled";
  fillPercent: number;        // 0-100%, how much of the gap has been filled
  respectedCount: number;     // times price touched edge but bounced away
  firstTestedAt?: number;     // candle index of first price entry into gap
  filledAt?: number;          // candle index when fully filled (mitigated)
```

**Scoring Impact**: Open FVGs with high quality get full weight. Partially filled FVGs get proportional weight. Respected FVGs get a bonus (they're acting as S/R). Fully filled FVGs should be excluded from entry zones.

---

### 3. Swing Points (⚠️ Minimal Lifecycle)

**Current State**:
- `significance: "internal" | "external"` — classification only (just added)
- No state tracking at all beyond detection

**What's Missing**:
- **No "tested" state**: When price approaches a swing high/low but doesn't break it, that's a test
- **No "broken" state**: When price closes through a swing level (this IS tracked in BOS/CHoCH detection, but not on the swing point itself)
- **No "swept" state**: When price wicks through but closes back (this IS tracked in sweep detection, but not on the swing point itself)
- **No `testedCount`**: How many times the swing level has been tested

**Recommended Additions to `SwingPoint` interface**:
```typescript
  state: "active" | "tested" | "swept" | "broken";
  testedCount: number;        // times price approached within ATR*0.1 but didn't break
  sweptAt?: number;           // candle index when wick went through but close held
  brokenAt?: number;          // candle index when price closed through
```

**Scoring Impact**: Active swing points with high test counts are stronger S/R. Swept-but-held swings are very strong (liquidity taken, level held). Broken swings should transition to BOS/CHoCH events (already happens, but the swing point itself doesn't know).

**Note**: The sweep and BOS detection already computes this information — the improvement is about writing it BACK onto the swing point so downstream consumers can see the full picture without re-deriving it.

---

### 4. Liquidity Pools (⚠️ Good Partial Lifecycle)

**Current State**:
- `swept: boolean` — whether price has gone through the pool level
- `sweptAtIndex: number` — when it was swept
- `rejectionConfirmed: boolean` — whether price rejected after sweeping (wick through, close back)
- `strength: number` — how many equal highs/lows formed the pool

**What's Missing**:
- **No "retested" tracking**: After a sweep, did price come back to test the pool level from the other side? (This is a classic ICT concept — swept liquidity becomes S/R)
- **No "absorbed" state**: When price sweeps through AND continues (no rejection), the liquidity was absorbed, not just swept
- **No `sweepDepth`**: How far past the pool level did price go? Deep sweeps vs shallow sweeps have different implications

**Recommended Additions to `LiquidityPool` interface**:
```typescript
  state: "active" | "swept_rejected" | "swept_absorbed" | "retested";
  sweepDepth?: number;        // how far past the level price went (in pips or ATR multiples)
  retestedAt?: number;        // candle index when price came back to test from the other side
  retestedHeld?: boolean;     // did the retest hold? (level acting as new S/R)
```

**Scoring Impact**: Active pools with high strength are strong targets. Swept-rejected pools confirm the level's importance. Swept-absorbed pools are invalidated. Retested-and-held pools become strong S/R for entry.

---

### 5. Breaker Blocks (✅ Decent Lifecycle)

**Current State**:
- `isActive: boolean` — whether the breaker zone is still valid
- `subtype: "breaker" | "mitigation_block"` — classification
- `mitigatedAt: number` — when the original OB was broken

**What's Missing**:
- **No "tested" tracking**: How many times has price tested the breaker zone?
- **No "respected" state**: When price enters the zone and bounces, that confirms the breaker
- **Currently filtered**: `detectBreakerBlocks` returns ONLY active breakers (`filter(b => b.isActive)`), so broken breakers are lost entirely

**Recommended Additions to `BreakerBlock` interface**:
```typescript
  state: "active" | "tested" | "respected" | "broken";
  testedCount: number;
  respectedAt?: number;       // candle index when price bounced from the zone
  brokenAt?: number;          // candle index when price closed through (invalidated)
```

**Scoring Impact**: Active breakers get base weight. Tested-and-respected breakers get bonus weight. Broken breakers should be excluded but kept in history for analysis.

---

### 6. Unicorn Setups (⚠️ No Lifecycle)

**Current State**:
- Pure detection only — overlap zone between breaker and FVG
- No state, no tracking, no timestamps

**What's Missing**:
- **No "active" vs "invalidated" state**: If either the breaker or FVG gets invalidated, the unicorn should too
- **No "tested" tracking**: Has price entered the overlap zone?
- **No "triggered" state**: Did price actually reach the unicorn zone and provide an entry?

**Recommended Additions to `UnicornSetup` interface**:
```typescript
  state: "active" | "tested" | "triggered" | "invalidated";
  invalidationReason?: "breaker_broken" | "fvg_filled" | "price_through";
```

**Scoring Impact**: Unicorn setups are already rare and high-value. Adding lifecycle would prevent stale unicorns from influencing scoring.

---

## Summary Matrix

| Entity | Current Lifecycle | States Tracked | Missing States | Priority |
|--------|------------------|----------------|----------------|----------|
| Staged Setups | ✅ Complete | watching → promoted/expired/invalidated | None | — |
| Pending Orders | ✅ Complete | pending → filled/expired/cancelled | None | — |
| BOS-Derived S/R | ✅ Good | active → broken | testedCount | Low |
| Breaker Blocks | ✅ Decent | active → (filtered out) | tested, respected, broken history | Medium |
| Liquidity Pools | ⚠️ Partial | active → swept (rejected/not) | absorbed, retested, sweepDepth | Medium |
| Order Blocks | ⚠️ Partial | fresh → mitigated (%) | tested, broken, timestamps | **High** |
| Fair Value Gaps | ⚠️ Partial | open → mitigated (binary) | fillPercent, respected, timestamps | **High** |
| Swing Points | ⚠️ Minimal | (significance only) | tested, swept, broken | Medium |
| Unicorn Setups | ❌ None | (detection only) | all states | Low |

## Implementation Priority

1. **Order Blocks** — Most impactful. OBs are a core scoring factor (Tier 1) and the mitigatedPercent already exists but isn't leveraged for state transitions.
2. **Fair Value Gaps** — Also Tier 1. Adding fillPercent and respected tracking would significantly improve entry zone quality.
3. **Swing Points** — Medium priority. The data already exists in BOS/CHoCH/sweep detection but isn't written back to the swing points.
4. **Liquidity Pools** — Medium priority. Already has good partial lifecycle. Adding absorbed vs rejected distinction and retest tracking would improve sweep-based scoring.
5. **Breaker Blocks** — Medium priority. Already has isActive. Adding test count and keeping broken history would improve breaker scoring.
6. **Unicorn Setups** — Low priority. Rare entity. Lifecycle would prevent stale unicorns but the impact is small.
7. **BOS-Derived S/R** — Low priority. Just added with active/broken. Could add testedCount later.
