# Position Management Audit - 2026-08-05

## Scope

End-to-end audit of per-trade overrides, scanner management, paper position processing, broker reconciliation, and the open-position UI.

## Fixed in PR 210

- The editor sends only fields the user changed. Editing trailing stop no longer silently creates overrides for break-even, partial take profit, or max hold.
- Open-position cards resolve per-trade overrides over the frozen entry policy instead of displaying stale entry-time values.
- Configured break-even pips are honored. Break-even no longer implicitly turns trailing on.
- The displayed break-even stop includes its configured protective offset.
- Trailing displays both the configured minimum and effective safety floor.
- Scanner management writes activation state to both persisted runtime formats, so paper processing and the UI read the same state.
- The fast paper trail calculates its safety floor from the original stop loss, not an already-ratcheted stop.
- Max hold has one owner. Scanner management protects profitable positions at entry; paper polling no longer independently force-closes them.
- OANDA partial take profit uses OANDA native trade-close endpoint. MetaAPI connections continue to use MetaAPI.
- Broker partial-close failures are logged and reported to Telegram instead of silently leaving broker size different from app size.
- The server validates override field names, types, activation modes, and bounds.

## Runtime authority

1. Entry freezes the setup and management policy on the position.
2. A per-trade override is the only intentional change to that open position.
3. `scannerManagement` decides break-even, trailing activation, partial take profit, and max-hold protection.
4. Paper processing detects stop/target hits and performs the fast trailing ratchet after scanner activation.
5. Broker reconciliation is the only broker writer for stop changes and partial closes.
6. The position card displays the same resolved policy used by runtime.

## Existing positions

Positions saved by the old editor may already contain overrides for all fields. Use **Reset to Global** once on those positions, then save only the intended override. New saves no longer create unwanted fields.

## Residual operational limits

- Broker partial close is not a database transaction with the broker. A broker rejection can still require manual reconciliation; it is now visible.
- Management checks use scanner/polling prices, not a broker tick stream. A price level touched and reversed entirely between scans can be missed.
- Legacy positions without a frozen entry snapshot fall back to saved exit flags, then current Bot Config when no saved policy exists.
