# Weekend crypto mode

Right now the bot stops completely at the weekend. Your trading list only has currencies and gold, and Saturday/Sunday are not ticked as active days, so every weekend scan is skipped with "Day not enabled".

## What will change

- The bot recognises when the currency market is shut (Friday 5pm New York through Sunday 5pm New York).
- During that window it keeps scanning, but only Bitcoin (BTC/USD) and Ethereum (ETH/USD).
- Currencies, gold and silver stay skipped until the market reopens, exactly as today.
- A new switch in bot settings, "Trade crypto on weekends", turned on by default. Off means the bot rests all weekend like now.
- The status area shows "Weekend — crypto only" so you can tell at a glance why only crypto is being scanned.

Nothing about how trades are found, sized or managed changes. Crypto is scanned with the same rules and the same session settings you already use.

## Technical detail

- `supabase/functions/_shared/configMapper.ts`: add `sessions.weekendCryptoEnabled` (default `true`) and map it into the scanner config.
- `supabase/functions/bot-scanner/index.ts`:
  - Compute a single `fxIsClosed` flag once per cycle from NY local day/hour (reuse existing logic at the per-pair weekend skip).
  - When `fxIsClosed && weekendCryptoEnabled`: bypass the `enabledDays` early return, and replace `config.instruments` with the crypto subset `["BTC/USD", "ETH/USD"]` (intersected with `SPECS[...].type === "crypto"` and `SUPPORTED_SYMBOLS`). Skip the session-filter gate for these, since crypto profiles already set `skipSessionGate`.
  - When `fxIsClosed && !weekendCryptoEnabled`: keep today's behaviour (skip).
  - Log and return a `weekendCryptoMode: true` marker in the scan result / `scan_logs` details so the UI can label it.
- `src/components/BotConfigModal.tsx`: add the toggle under Sessions, defaulting on, saved through `bot-config`.
- `src/components/SessionStatusPill.tsx` (and the bot page status line): show "Weekend — crypto only" when the flag is set.
- Redeploy `bot-scanner` and `bot-config` after the change.

## Note

BTC/USD and ETH/USD are currently unticked in your allowed-instruments list. Weekend mode will enable them for the weekend window only; your weekday list is untouched.
