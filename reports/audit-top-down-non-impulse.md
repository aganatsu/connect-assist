# Task report: audit/top-down-non-impulse

## Task

Determine whether the existing system can support a style-aware top-down setup
path when no executable impulse zone is found, without adding duplicate
detectors or another decision authority.

## Behavior changes

None.

This is an audit-only branch. It does not change scanner, backtest, Bot Config,
setup lifecycle, risk, authorization, or execution behavior.

## Files modified

- `docs/TOP_DOWN_NON_IMPULSE_AUDIT_2026-08-28.md`
  - source-backed current-state architecture;
  - exact impulse coupling points;
  - config-mode and frozen-lifecycle interactions;
  - existing-owner and duplication review;
  - evidence limitations;
  - phased, observation-first implementation plan.
- `reports/non-impulse-top-down-opportunity-audit.sql`
  - read-only 21-day scan-log audit;
  - distinguishes no structural impulse from an impulse trace with no accepted
    zone;
  - classifies independent direction/structure/HTF-POI/liquidity evidence;
  - exposes missing candidate geometry, confirmation, authorization, snapshot,
    and outcome evidence without inventing a trade result.

## Tests added

None. No executable behavior changed.

## Tests run

```text
deno test --no-check --allow-read --allow-net --allow-env supabase/tests/
ok | 3562 passed | 0 failed (28s)
```

Additional validation:

```text
deno fmt --check docs/TOP_DOWN_NON_IMPULSE_AUDIT_2026-08-28.md
Checked 1 file

git diff --check
clean

custom delimiter/quote balance check for
reports/non-impulse-top-down-opportunity-audit.sql
balanced SQL delimiters
```

A PostgreSQL parser package could not be downloaded in the execution
environment. The SQL still needs its final schema/runtime validation in the
Supabase SQL editor; it is deliberately read-only.

## Regression check

Not applicable: no runtime fix or behavior was introduced, so there is no
behavioral regression test to remove/reapply. Existing tests were run in full.

## Principal conclusion

The repository already has enough top-down detection data. It does not yet have
a shared, frozen, live/backtest-parity execution contract for a non-impulse
candidate. Turning the impulse gate Soft or Off would expose legacy fallback
behavior rather than activate the canonical decision pipeline.

The smallest safe future change is an observation-only extension of the existing
`ictEntryZoneAuthority` owner, followed by a versioned generalization of the
existing Zone Story/setup contract. No new detector or arbiter should be
created.

## Open questions

1. How many recent no-zone scans reach the two descriptive
   `at_aligned_htf_poi_*` categories in the companion SQL, split by style and
   pair?
2. Which existing range should own location for a `structure_poi` candidate when
   no qualified impulse dealing range exists?
3. Does forward observation show enough resolved disagreements to justify a
   paper-only experiment?
4. Should the existing cross-timeframe mode remain a direct saved-config
   authority, or be restored to the certificate-capped behavior described in
   comments and neighboring controls? This should be decided separately.

## Suggested PR

Title:

```text
docs: audit non-impulse top-down setup path
```

Description:

```text
Documents the existing top-down analysis pipeline, identifies where executable
setup ownership becomes impulse-specific, and adds a read-only query for the
recent no-zone cohort. No runtime behavior changes.
```
