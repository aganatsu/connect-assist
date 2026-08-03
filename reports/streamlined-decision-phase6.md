# Streamlined Decision Phase 6 - Path Parity

Implemented 2026-08-03. Scanner and backtest call the shared evaluator.
Watchlist, rejection, pending, fill, position, and close paths carry the same
frozen origin. Pending confirmation refreshes lifecycle state without replacing
origin evidence. Manual scanner routes share the scanner implementation.

Missing historical evidence remains unavailable. Zone Story, impulse, OB/FVG,
canonical range, confirmation, and final runtime gates remain protected.
