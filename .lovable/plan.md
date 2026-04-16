

# Fix Runtime Error + Add Trading Style System

## Critical Bug Fix First

The bot-scanner is crashing with `detectSession is not defined` because two essential functions were never added to `bot-scanner/index.ts`:

- **`detectSession()`** — determines current trading session (Asian/London/NY) and kill zone status
- **`calculatePremiumDiscount(candles)`** — calculates premium/discount zones from swing points

Both exist in `smc-analysis/index.ts` but are missing from the scanner. These must be added before any new features.

## Trading Style System

### How It Works

Add a `tradingStyle` config section with four modes. When a mode is active, the scanner applies parameter overrides **before** running its analysis — so the existing 9-factor scoring, safety gates, and trade execution all automatically adapt.

### The Four Modes

```text
Parameter          │ Scalper        │ Day Trader     │ Swing Trader   │ Auto
───────────────────┼────────────────┼────────────────┼────────────────┼──────────
Entry TF           │ 5m             │ 15m            │ 1h             │ computed
HTF Bias TF        │ 1h             │ 1D             │ 1W             │ computed
TP Ratio           │ 1.5:1          │ 2:1            │ 3:1            │ computed
SL Buffer (pips)   │ 1              │ 2              │ 5              │ computed
Max Hold (hours)   │ 1              │ 8              │ 120            │ computed
Min Confluence     │ 5              │ 6              │ 7              │ computed
```

**Auto mode** analyzes ATR and trend strength per instrument:
- Low ATR + ranging → Scalper params
- Medium ATR + trending → Day Trader params
- High ATR + strong trend → Swing Trader params

### Changes by File

**1. `supabase/functions/bot-scanner/index.ts`**
- Add missing `detectSession()` and `calculatePremiumDiscount()` functions (fixes the crash)
- Add `getStyleOverrides(mode)` — returns parameter overrides for each style
- Add `detectOptimalStyle(candles, dailyCandles)` — ATR + trend analysis for Auto mode
- In `runScanForUser`: after loading config, resolve active style → apply overrides to config before analysis
- Adjust `fetchCandles` interval based on style (5m for Scalper, 15m for Day Trader, 1h for Swing)

**2. `supabase/functions/bot-config/index.ts`**
- Add `tradingStyle` defaults to `getDefaultConfig()`:
  ```
  tradingStyle: {
    mode: "day_trader",
    autoDetectEnabled: false,
  }
  ```

**3. `src/components/BotConfigModal.tsx`**
- Add "Trading Style" tab (first position, before Strategy)
- Four mode buttons: Scalper, Day Trader, Swing Trader, Auto
- When manual mode selected: show summary card of what parameters it sets
- When Auto selected: show explanation text
- Note that style sets defaults; manual overrides in other tabs still apply

**4. `src/pages/BotView.tsx`**
- Add a colored badge in the header showing active style
- In Auto mode, show per-instrument detected style in scan results

### How It Integrates With Existing Logic

The style system works as a **parameter preprocessor**. It modifies config values (entry TF, TP ratio, SL buffer, min confluence, max hold hours) before they're used by:
- The 9-factor confluence scoring (uses entry TF for candle fetching, min confluence for threshold)
- The 10 safety gates (uses max hold, min R:R which changes with TP ratio)
- Position sizing (uses SL buffer)
- Trade execution (uses TP ratio)

No changes to the scoring or gate logic itself — just the parameters fed into them.

