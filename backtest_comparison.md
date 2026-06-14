# Backtest Results Comparison — With New Gates

## Gate Block Counts (new gates only)

| Gate | Scalper | Day Trader | Swing Trader |
|------|---------|------------|--------------|
| DirectionVerdict | 6 | 0 | 0 |
| PremiumDiscount | 141 | 10 | 16 |
| StructuralConviction | 2 | 4 | 32 |
| **Total new blocks** | **149** | **14** | **48** |

## Performance Summary

| Metric | Scalper | Day Trader | Swing Trader |
|--------|---------|------------|--------------|
| Trades | 72 | 10 | 3 |
| Win Rate | 50% | 50% | 0% |
| Final Balance | $11,932 | $9,707 | $9,556 |
| P&L | +$1,932 | -$293 | -$444 |
| Max Drawdown | 3.4% | 5.0% | 4.4% |
| Highest Score | 60.6 | 52.2 | 52.2 |

## Notes

- **PremiumDiscount** is the most active new gate across all styles (141 blocks for scalper, 16 for swing)
- **StructuralConviction** is most impactful for swing_trader (32 blocks out of 51 total gate passes)
- **DirectionVerdict** fires rarely (6 blocks for scalper, 0 for others) — this is expected since the direction engine already filters heavily upstream
- All 3 new gates successfully type-check and integrate with existing analysis data
