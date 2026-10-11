# Strategy V2.0.2 — PARKED — LOW_FREQUENCY_FAIL (2026-10-11)

Spec: STRATEGY_SPEC_V2.0.2_FROZEN.md (sha256 7d64282d5e716137f9a8624fa8d4be6c55a2dd4d7c33ad7b8f82578081786e9e).
Engine: feat/v2-engine @ d7ef563d. Phase 4 is NOT started (§12.1c: LOW_FREQUENCY_FAIL → no Phase 4).

| Gate | Result |
|---|---|
| Dataset integrity (P3a) | PASS — 5 TwelveData batch calls, 30 credits; checksums match the manifest; no truncation; no key in stored files |
| Completeness (P3b, §12.1e) | PASS — 10/10 complete eligible days (2026-09-28 → 2026-10-09); 0 MISSING intervals |
| Fidelity (§12.1b) | PASS — engine vs independent checker 1,314 events, 0 disagreements; owner sample empty (0 resolved trades) |
| Frequency (§12.1c) | **FAIL** — 0 resolved trades / 10 days × 5 = 0.0 per week < 5 → LOW_FREQUENCY_FAIL |

Dataset (stored outside the repo, read-only, not committed): ~/strategy-v2/datasets/phase3-20261011T1837Z/
- dataset.json sha256 2cc0c4b3c5badf60b909759c083c40384cdef53b1d93bbd90c6a974ef679559f
- manifest: dataset-manifest.json (request parameters without the key, retrieval timestamps, per-call and per-series sha256)

Reproduce (with the dataset present):
```
deno run --allow-read scripts/v2/phase3_completeness.ts --dataset <dir>/dataset.json --measured-start 2026-09-27T21:00:00Z
deno run --allow-read --allow-write scripts/v2/phase3_report.ts --dataset <dir>/dataset.json --measured-start 2026-09-27T21:00:00Z --days 10 --out <out>
```
Expected: dataset sha256 above, 1,314 agreeing events, 0 resolved trades, LOW_FREQUENCY_FAIL.
