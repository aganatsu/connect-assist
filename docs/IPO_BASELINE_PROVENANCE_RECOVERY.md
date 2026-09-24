# IPO baseline provenance recovery

**Provenance recovery only. No strategy logic changed, no baseline edited, no
deployment, no database write, no production code touched.** Dated 2026-09-23.

---

## 0. Result

**The exact 15 validation windows ARE RECOVERED, at GRADE B.**

```
periods (5, end-exclusive)      2021-11..2022-01   2022-10..12
                                2023-06..08        2025-10..12
                                2026-04..06
instruments (3)                 EUR/USD 1h · USD/JPY 30min · BTC/USD 1h
= 15 windows, 24,101 bars
```

Source: `docs/IPO_RESEARCH_FREEZE.md` §17, heading *"Data — 15 windows, five
separated periods, five different years, all untouched"*.

**The original per-trade output was NOT recovered.** No artifact anywhere holds
the 1,039 rows.

**Determinism is NOT yet proven.** The replay is blocked on throughput, not on
evidence — see §7. Under the task's stop conditions this is therefore **not** a
completed Success Condition 1, and stage 3 should not auto-resume.

---

## 1. Why stage 3 stopped

Stage 3 (`83dec1d8`) could not identify the population. Its candidate window set
— freeze §14 (3 windows) + §15 (12 windows) — was refuted: BTC/USD produced 165
HIGH_VOL trades from three of five candidate windows against a locked total of
140, and a superset cannot be the population.

That refutation was correct, and the cause is now visible: §14+§15 was the wrong
document *and* the window lengths were wrong (§4).

---

## 2. What was searched

| area | method | outcome |
|---|---|---|
| working tree | `grep -rIl` for 1039, 341, 558, 0.585, 72.6, 2.02, 18.4 | 3 files hold 1039+341, all downstream of the baseline |
| working tree | phrases: "15 untouched", "validation window", "causal baseline", "locked baseline", "HIGH_VOL" | **led to freeze §17 and §19** |
| git history | `git log --all -S` on 1039, +0.585, 72.6 | **found `c2f2a903`**, the baseline-creating commit |
| git history | `--diff-filter=D` for ipo/valid/baseline/backtest/corpus/window/holdout/oos/forward/frozen/stage/result/trade/report | no deleted research output |
| commit messages | `--grep` baseline, validation, causal, 1039 | `c2f2a903` only |
| branches/tags | all local + remote refs listed; no tags exist | nothing unmerged holds it |
| PRs | 100 PRs, titles scanned, **every body fetched and grepped** for 1039 / 341+558 / 0.585 | **no PR body carries the figures** |
| issues/comments | same terms | nothing |
| shell history | `~/.zsh_history` (79 lines), `~/.bash_history` (2 lines) | too short to reach the research period; secrets redacted from the search output |
| local outputs | `/tmp` and repo, `.json/.csv/.log/.ndjson/.txt` scanned for both 1039 and 341 | **no artifact holds both** |
| agent transcripts | 6 session `.jsonl` files under `~/.claude/projects/` | 5 mention 1039; none contains the window dates |

Search terms used verbatim: `1039`, `341`, `558`, `140`, `72.6`, `0.585`,
`2.02`, `18.4`, `15 untouched validation windows`, `validation windows`,
`untouched windows`, `causal baseline`, `locked baseline`, `BTC HIGH_VOL`,
`final-validation`, `five windows`.

---

## 3. The recovered evidence

### Grade B — freeze §17 lists the windows

> **Data — 15 windows, five separated periods, five different years, all untouched**
>
> 2021-11..2022-01, 2022-10..12, 2023-06..08, 2025-10..12, 2026-04..06 for each
> of the three instruments. 24,101 bars.

§17's own batch result: EUR/USD 678, USD/JPY 1151, BTC/USD HIGH_VOL 287,
portfolio 2116.

### Grade B — `c2f2a903` ties those windows to the locked numbers

Commit `c2f2a903`, 2026-09-21, *"docs(ipo): make the causal live-equivalent
result the official baseline"*:

> Section 11 of the forward spec now carries the causal figures from
> `ipoLiveEngine.ts` replaying **all 15 validation windows** bar by bar:
> EUR/USD n=341 +0.758R · USD/JPY n=558 +0.550R · BTC/USD HIGH_VOL n=140
> +0.301R · PORTFOLIO n=1039 +0.585R
>
> Also supersedes the interim **1,109 / +0.619R** live figure, which predated two
> engine fixes (cost priced off the exit bar; same-bar re-entry permitted).

### The chain, end to end

| stage | source | EUR | JPY | BTC | total |
|---|---|---|---|---|---|
| batch, non-causal | freeze §17 | 678 | 1151 | 287 | 2116 |
| batch, as quoted in the spec | spec §11 | 678 | 1151 | 284 | 2113 |
| live, pre-fix | freeze §19 | 368 | 595 | 146 | 1109 |
| **live, post-fix — LOCKED** | **spec §11** | **341** | **558** | **140** | **1039** |

Each step is documented, and the 287-vs-284 difference on BTC is the §17 data
repair treatment (drop vs repair), which §17 states explicitly.

**§17 and §19 describe the same 15 windows** — §19's heading is "Replaying all
15 final-validation windows bar by bar" and it reports the batch column
identically to §17. So the windows that produced 1,109 are the windows that,
after two named engine fixes, produced 1,039.

---

## 4. Resolving the `..` notation — the reason stage 3 missed

`2021-11..2022-01` is **start..end-exclusive**: two months, not three.

Established from the document's own bar count, not assumed. Period 1 was fetched
and measured under both readings:

| reading | period-1 bars | ×5 periods | documented | deviation |
|---|---|---|---|---|
| 3 months (→ 2022-02-01) | 7,000 | 35,000 | 24,101 | **45.2%** |
| **2 months (→ 2022-01-01)** | **4,716** | **23,580** | **24,101** | **2.2%** |

§14 uses the same convention explicitly, writing `2023-09-01 -> 2023-11-01` for
a two-month USD/JPY window.

This is interpretation of the recovered evidence. It is **not** fitting to trade
counts, and no window boundary was moved to chase 341/558/140.

Stage 3 used three-month windows, which is why USD/JPY alone returned 209 trades
from one window against a locked 558 across five.

### The recovered windows, verbatim

| # | instrument | timeframe | start UTC | end UTC (exclusive) |
|---|---|---|---|---|
| 1–3 | EUR/USD, USD/JPY, BTC/USD | 1h, 30min, 1h | 2021-11-01 | 2022-01-01 |
| 4–6 | " | " | 2022-10-01 | 2022-12-01 |
| 7–9 | " | " | 2023-06-01 | 2023-08-01 |
| 10–12 | " | " | 2025-10-01 | 2025-12-01 |
| 13–15 | " | " | 2026-04-01 | 2026-06-01 |

Source: `docs/IPO_RESEARCH_FREEZE.md` §17; tied to the locked result by commit
`c2f2a903`.

### One data-quality step that must travel with them

Freeze §17: BTC 2023-06..08 contains 64 bars (4.6%) with a decimal-shift glitch
(`low` = price / 10000). The **primary** treatment is to DROP them; repairing
leaves corrupted zone geometry (avg MAE 35.1R against ~1.2R elsewhere). The
replay script implements the drop and reports the count. §17 records the verdict
as identical either way (portfolio expR 0.689 vs 0.685).

---

## 5. Evidence grades

| source | grade | why |
|---|---|---|
| freeze §17 window list | **B** | an original research document explicitly listing the exact windows, with a bar count that independently confirms the reading |
| commit `c2f2a903` | **B** | explicitly ties "all 15 validation windows" to the locked 341/558/140/1039 and names the two fixes separating them from 1,109 |
| freeze §19 | **B** | same 15 windows, reports the pre-fix live figures that the locked set supersedes |
| original per-trade output | — | **not found anywhere** |
| original runner script | — | **not found**; no invocation survives in history or shell history |

No Grade A evidence exists: the script or command that actually executed the run
was never committed and is not in shell history.

---

## 6. Success conditions

| condition | met? |
|---|---|
| exact 15 windows recovered from Grade A/B evidence | **YES** (Grade B) |
| unmodified replay reproduces 341/558/140/1039 | **NOT YET** |
| original trade-level corpus recovered | **NO** |

**Success Condition 1 is NOT met**, because the determinism half is outstanding.
Stage 3 should not auto-resume on this report alone.

---

## 7. The remaining blocker — throughput, not evidence

The determinism replay was started and is incomplete. Two independent costs:

1. **Twelve Data throttling.** `outputsize=5000` bills roughly 8 credits, so the
   per-minute budget is gone after ~7 large requests. With 65-second backoff
   that is about one window per 85 seconds — roughly 21 minutes for 15 windows.
2. **The replay itself is O(n²).** `ipoLiveEngine` re-runs the frozen lifecycle
   over a growing prefix at every bar. A single 3,199-bar USD/JPY window took
   minutes. Across 24,101 bars this is the larger of the two costs.

Neither is a provenance problem. The script
(`local-runner/stage3-population.ts`) now carries the recovered two-month
windows and the §17 drop treatment, and prints a hard MATCH/MISMATCH verdict
against 341/558/140/1039.

**If it does not reproduce the locked counts, that is a finding to report, not
something to tune.** No window may be adjusted to close a gap.

---

## 8. What this does not claim

- No corrected expectancy, and no change to the locked baseline.
- No claim that count-matching would by itself prove provenance; the Grade B
  documentary chain is what identifies the windows, and the determinism check is
  a confirmation of it.
- No brute-force search over window combinations was performed (Part M).

---

## 9. Statement

No IPO detection, lifecycle, contraction, FVG, direction, E2 entry, S2
invalidation, 2R target, re-entry, sequencing, volatility or cost rule was
changed. No SMC code, no broker execution, no schema, no cron, no deployment, no
database write. The only code added is search and replay tooling under
`local-runner/`, with no production caller.

**The locked baseline is preserved exactly as written** — EUR/USD 341 @ +0.758R,
USD/JPY 558 @ +0.550R, BTC/USD HIGH_VOL 140 @ +0.301R, portfolio 1,039 @
+0.585R, win 72.6%, PF 2.02, maxDD 18.4R.
