# Single-Ownership Historical Baseline

Analyzed 2026-08-03 from owner-exported Supabase CSV data. Raw exports are not
committed because they contain detailed trading records.

## Coverage

- 500 rejected setups; 270 contained parseable `raw_detail` evidence.
- 339 closed trades; 325 contained parseable `signal_reason` evidence.
- Rejected outcomes: 22 would-have-won, 144 would-have-lost, 327
  inconclusive, and 7 pending.
- Closed outcomes: 205 winners and 134 losers.

## Confirmed duplicate influence

For rejected setups with usable Zone Story evidence:

- 72 selected FVG zones also had a present legacy FVG factor.
- 57 selected OB zones also had a present legacy OB factor.

For closed trades:

- 91 selected OB/FVG zones duplicated the same concept in legacy factors.
- 128 rows contained explicit `IMPULSE-ZONE CREDIT` mutations.

| Credited legacy factor | Rows |
|---|---:|
| Premium/Discount & Fib | 90 |
| Order Block | 58 |
| Confluence Stack | 57 |
| Fair Value Gap | 31 |
| HTF POI Alignment | 14 |

Credited rows sometimes contained contradictory legacy descriptions: 46 said
the retracement thesis was invalidated, 40 said no P/D score should apply, 27
described a counter-swing, and 82 said price was not at the factor level.

## Interpretation

Zone Story validates a selected impulse/POI/location, then Tier factors rescore
the same market fact, and scanner credits reconcile disagreement by mutating
factors and counts.

Simply subtracting credited weights is not a valid counterfactual because many
rows lack a complete pre-credit snapshot and score changes affect later path
execution. The safe implementation is one explicit authority contract with
legacy diagnostics retained, followed by paper-only forward enforcement.
