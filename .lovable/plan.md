## Apply performance-driven config changes to active bot

Update the user's active `bot_configs` row via a migration to disable underperforming pairs/sessions and tighten safety filters.

### Changes

**Instruments — disable (13):**
AUD/CHF, NZD/JPY, EUR/NZD, EUR/GBP, GBP/CHF, USD/JPY, EUR/CAD, AUD/JPY, EUR/CHF, plus any remaining CHF/JPY crosses currently enabled.

**Instruments — keep enabled:**
GBP/CAD, EUR/AUD, USD/CAD, GBP/USD, CAD/JPY, NZD/USD, AUD/USD, XAU/USD.

**Sessions:**
- Remove: `asian`
- Keep: `london`, `newyork`, `offhours`

**Safety filters:**
- `correlationFilterEnabled: true`
- `maxSpreadPips: 2`

**Leave untouched:**
- Partial TP (already on at +1R / 50%)
- Break-even offset (already 3 pips)
- Confluence threshold and tier-1 gate (per your current preference)

### How

One migration that JSON-patches the `config` column on the user's `bot_configs` row(s), preserving all other fields. Values will be merged in-place — arrays for instruments/sessions replaced, booleans/numbers overwritten.

### Verification after apply

Read back `bot_configs` and confirm the updated arrays + flags.
