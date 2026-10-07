# Route 2 fill vs the stop floor — open policy question (documented, NOT fixed)

**Status:** decision required before unlock. Step 14 deliberately does not change this.

## The issue

- **Placement:** step 10 anchors the Route 2 stop to the order's **limit** price and guarantees `|limit − stop| ≥ floor` (25 pips on the JPY pairs).
- **Fill:** the hunt fills at the **confirmation price**, which can differ from the limit by a fraction of a pip or more. The absolute stop doesn't move.
  - A fill **better** than the limit (higher for a short, lower for a long) sits closer to the stop, so the distance from the actual fill can be **slightly inside the floor**.
  - A worse fill sits farther away.

Fill-time sizing (step 9) sizes to the actual fill → stop distance, so **dollar risk stays at 0.5% either way**. What is breached is the floor's *noise* purpose: the stop is closer to price than the rule intends.

## Measured (dry run, 2026-10-06/07)

| Order | Pair | Limit | Fill | Stop | Limit→stop | **Fill→stop** | vs 25p floor | Lots | Risk |
|---|---|---|---|---|---|---|---|---|---|
| 2dee2910 | USD/JPY short | 158.20462 | 158.21184 (0.72p better) | 158.45462 | 25.00p | **24.28p** | **0.72p inside** | 3.25 | 0.4987% |
| 77134ab8 | CHF/JPY long | 190.142885 | 190.1643 (2.14p worse) | 189.892885 | 25.00p | 27.14p | outside | 2.91 | 0.4987% |

## Options (for the pre-unlock decision)

1. **Accept.** The floor applies at placement; size compensates at the fill. Simplest; no change.
2. **Re-check at fill, skip if inside the floor.** Strict: refuses those fills, which loses trades exactly when the entry is better.
3. **Re-anchor at fill.** Move the stop to fill ∓ floor when the fill is inside, keeping the target ratio. Changes the stop the order was placed with.
4. **Tolerance.** Accept up to X pips (or X% of the floor) inside, otherwise option 2 or 3.

Measurement to decide with: the full dry-run sample of `fillSizing.stopDistance` against `route2Stop.floorPips` (both are recorded on every dry-run fill).
