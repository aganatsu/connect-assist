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
  - read-only, bounded 21-day scan-log summary;
  - distinguishes no structural impulse from an impulse trace with no accepted
    zone;
  - classifies independent direction/structure/HTF-POI/liquidity evidence;
  - separates current no-zone skips from retained frozen setup observations;
  - avoids materializing full scan JSON or joining large evidence tables.
- `reports/non-impulse-top-down-candidate-details.sql`
  - read-only detail follow-up for the summary's `at_aligned_htf_poi_*`
    categories;
  - defaults to three days and caps output at 250 rows;
  - exposes the matched HTF POI and sequence state without inventing entry,
    stop, target, confirmation, authorization, or outcome evidence.

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
reports/non-impulse-top-down-opportunity-audit.sql and
reports/non-impulse-top-down-candidate-details.sql
balanced SQL delimiters
```

A PostgreSQL parser package could not be downloaded in the execution
environment. The SQL still needs its final schema/runtime validation in the
Supabase SQL editor; it is deliberately read-only.

The first wide audit query reached Supabase SQLSTATE `53100` while PostgreSQL
was writing `pgsql_tmp`. It was replaced before merge with the bounded summary
and capped detail queries listed above. The failing wide query should not be
rerun.

Review of the first bounded export also found that counting every historical
ready liquidity sequence overstated current readiness. Both queries now mirror
`evaluateCanonicalStructureDecision`: only the latest direction-aligned sequence
controls the reported ready/pending state.

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
   `at_aligned_htf_poi_*` categories in the bounded summary, split by style and
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
setup ownership becomes impulse-specific, and adds bounded read-only queries
for the recent no-zone cohort. No runtime behavior changes.
```
