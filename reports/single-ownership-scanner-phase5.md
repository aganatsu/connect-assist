# Single-Ownership Scanner Phase 5

Date: 2026-08-03

## Scope

Phase 5 applies the owned decision at actual fill time in both pending-order
routes: the main scanner and the one-minute zone-confirmation scanner.

## Fill Authorization

Both routes now:

1. load the frozen Zone Story and candidate identity;
2. use the latest Direction Verdict;
3. recalculate current price against the frozen canonical range;
4. attach the successful routed confirmation;
5. rerun thesis validation;
6. run the existing route-independent final operational authorization;
7. evaluate the same single-ownership contract; and
8. call the atomic database fill only when both authorizations allow entry.

In paper ownership enforcement, the duplicate Game Plan veto is disabled at
the fill boundary because Game Plan is already represented in Direction
Verdict. It remains visible in decision context. Live and observe behavior are
unchanged.

Missing frozen Zone Story or canonical evidence fails closed in enforcement.
The refreshed owned decision is persisted on the resulting position.
