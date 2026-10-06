# Step 10 — Route 2 stop anchored to the order's entry (pre-deploy report)

**Status:** built and tested (PR, not merged). The account stays **paused and entries-locked**.

**Activation:** `simplification.stopAnchor = "limit"` in config. The code defaults to `market`, so merging alone changes nothing.

## The defect

The stop chain measured every distance from the **market price at scan time**:
1. the swing stop;
2. widen it to the minimum-stop floor if too close to the market price;
3. the Impulse-origin stop replaces it if wider from the market price and within the cap.

The Route 2 order then kept that **absolute** stop with its own limit entry, and only the target was recalculated from the limit. So neither the floor nor the cap was ever checked against the entry the order would actually use.

Measured on the 53 FX Route 2 orders in the 8 days before the reset:
- **33 of 53 (62%) had a limit→stop distance below the floor.** For example, GBP/USD shorts had 12–15 pip stops against a 25-pip floor, and NZD/CAD 11 pips against 20.
- The distance from the limit was a median **0.67×** the distance the chain had checked (range 0.29–2.24).
- None had the stop on the wrong side of the entry.
- Same-price "refresh in place" also rewrote the stop from a newer market price. Under `limit` anchoring the refreshed stop is computed from the order's entry, so it's consistent.

## The fix (`_shared/route2StopGeometry.ts`)

Same rules, measured from the order's **limit entry**:
1. Swing stop, if it's on the correct side of the limit.
2. The Impulse-origin stop instead, if it's farther from the limit **and** within the cap (cap measured from the limit).
3. If the stop is missing or closer than the floor → limit ∓ floor.
4. Target = limit ± risk × target ratio.

Every Route 2 decision records both geometries (`detail.route2Stop.market` and `.limit`). The order-level R:R check (step 8) and fill-time sizing (step 9) then use the anchored stop.

## Effect on the 53 FX Route 2 orders (re-computed from each order's recorded candidates)

| | Before (market-anchored) | After (limit-anchored) |
|---|---|---|
| Orders with limit→stop below the floor | **33** | **0** |
| Median stop distance | 20.1 pips | 25.0 pips |
| Stop distance, new ÷ old | — | median 1.21×, range 0.67–3.59; 32 wider, 4 tighter, 17 unchanged |
| Stop source | — | floor 33 · Impulse origin 18 · swing 2 |
| Orders passing the order R:R check (effective ≥ 1.0 after spread; spreads approximate here) | 31 / 53 | 40 / 53 |

What this changes:
- **Risk in dollars:** none. Step 9 sizes every fill at 0.5%, so wider stops mean fewer lots, not more risk.
- **Targets:** the target sits 1.1 × the (now wider) risk away. Whether that reaches fewer targets can't be measured from these records. The dry-run funnel will show touch, confirmation and fill rates with the new geometry before any unlock.
- **Trade count:** slightly more orders pass the order R:R check (31 → 40 of 53 here), because spread is a smaller share of a wider stop.

## Not changed

The fill price still comes from the confirmation in the zone. The stop stays where the order placed it; step 9 sizes the actual fill-to-stop distance.

## Tests

`step10StopAnchor.test.ts` (7):
- the real GBP/USD shape;
- swing kept beyond the floor;
- Impulse used only if wider and within the cap;
- a wrong-side stop is never used;
- an exhaustive grid stays ≥ floor on the correct side with TP = 1.1R;
- invalid inputs fail closed;
- wiring order (before the R:R check and sizing).

Full Deno suite green.

## Deploy plan (after your approval)

1. Merge the PR (legacy default, no change).
2. Set `simplification.stopAnchor = "limit"`.
3. Dry-run orders then carry the anchored stop; the funnel measures it.
