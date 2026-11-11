"""BREAK_STRENGTH_PREREG_V1 — gate and breakdowns (docs/BREAK_STRENGTH_PREREG_V1.md).
Reads local-runner/.cache/smc_bs_setups_*.json (break-strength-replay.ts) and the original
docs/exports/impulse_zone_trades_clean.csv for the consistency check. RESEARCH ONLY.

    python3 -I local-runner/break-strength-report.py
"""
import csv, glob, json, random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MID = "2026-06-27"          # window midpoint = original PRIMARY start
THRESH = 0.70

rows = []
for f in sorted(glob.glob(str(ROOT / "local-runner/.cache/smc_bs_setups_*.json"))):
    rows += json.load(open(f))
trades = [r for r in rows if r["outcome"] == "TRADE_TAKEN" and not r["ambiguous"]]

def stats(xs, key="netR"):
    rs = [x[key] for x in xs if x.get(key) is not None]
    n = len(rs)
    if not n: return {"n": 0, "exp": float("nan"), "wr": float("nan"), "pf": float("nan"), "lo": float("nan"), "hi": float("nan")}
    w = sum(r for r in rs if r > 0); l = -sum(r for r in rs if r <= 0)
    rnd = random.Random(1); boots = sorted(sum(rs[rnd.randrange(n)] for _ in range(n)) / n for _ in range(2000))
    return {"n": n, "exp": sum(rs) / n, "wr": sum(1 for r in rs if r > 0) / n, "pf": w / l if l else float("inf"), "lo": boots[50], "hi": boots[1949]}

def line(label, s):
    return f"{label:<28} n={s['n']:>5}  WR {s['wr']*100:5.1f}%  exp {s['exp']:+.3f}R  95%CI [{s['lo']:+.3f}, {s['hi']:+.3f}]  PF {s['pf']:.2f}"

strong = lambda x: x["bosClose"] is not None and x["bosClose"] >= THRESH
weak = lambda x: x["bosClose"] is not None and x["bosClose"] < THRESH
h1 = lambda x: x["t"] < MID
h2 = lambda x: x["t"] >= MID

print("BREAK_STRENGTH_PREREG_V1 — SMC impulse-zone replay, decisions 2026-03-29 → 2026-09-25")
orig = list(csv.DictReader(open(ROOT / "docs/exports/impulse_zone_trades_clean.csv")))
o_exp = sum(float(r["netR"]) for r in orig) / len(orig)
okeys = {(r["zoneId"], r["t"]) for r in orig}
match = sum(1 for t in trades if (t["zoneId"], t["t"]) in okeys)
print(f"consistency: original n={len(orig)} exp {o_exp:+.3f}R | re-run n={len(trades)} exp {stats(trades)['exp']:+.3f}R | "
      f"same (zone, time) as original: {match}  | bosClose missing: {sum(1 for t in trades if t['bosClose'] is None)}")

print("\n-- BOS close strength (the decision split)")
S, Wk = [t for t in trades if strong(t)], [t for t in trades if weak(t)]
res = {}
for lab, grp in (("ALL", trades), ("STRONG (>=70%)", S), ("WEAK (<70%)", Wk)):
    print(line(lab, stats(grp)))
for half, hf in (("1st half", h1), ("2nd half", h2)):
    for lab, grp in (("STRONG", S), ("WEAK", Wk)):
        res[(lab, half)] = stats([t for t in grp if hf(t)])
        print(line(f"  {lab} {half}", res[(lab, half)]))

s_all, w_all = stats(S), stats(Wk)
checks = [
    (f"STRONG ≥ 30 trades ({s_all['n']}) and exp > 0 ({s_all['exp']:+.3f}R)", s_all["n"] >= 30 and s_all["exp"] > 0),
    (f"STRONG beats WEAK ({s_all['exp']:+.3f} vs {w_all['exp']:+.3f})", s_all["exp"] > w_all["exp"]),
]
for half in ("1st half", "2nd half"):
    s, w = res[("STRONG", half)], res[("WEAK", half)]
    checks.append((f"{half}: STRONG ≥ 30 & > 0 & > WEAK ({s['n']} trades, {s['exp']:+.3f} vs {w['exp']:+.3f})",
                   s["n"] >= 30 and s["exp"] > 0 and s["exp"] > w["exp"]))
print("\n=== GATE (pre-registered) ===")
for k, ok in checks: print(f"  {'PASS' if ok else 'FAIL'}  {k}")
print(f"  RESULT: {'PASSED → add the Bot Config switch (default off)' if all(ok for _, ok in checks) else 'FAILED → no change; the measure stays observational'}")

print("\n=== DESCRIPTIVE ONLY ===")
print(line("STRONG before costs", stats(S, "grossR")))
print(line("WEAK before costs", stats(Wk, "grossR")))
vals = sorted(t["bosClose"] for t in trades if t["bosClose"] is not None)
if vals:
    q1, q2 = vals[len(vals) // 3], vals[2 * len(vals) // 3]
    print(f"-- BOS close terciles (cuts {q1:.2f} / {q2:.2f})")
    for lab, lo, hi in (("low", -1, q1), ("mid", q1, q2), ("high", q2, 2)):
        print(line(f"  {lab}", stats([t for t in trades if t["bosClose"] is not None and lo <= t["bosClose"] < hi])))
print("-- leg force (displacement.strength)")
for k in ("strong", "moderate", "weak", None):
    print(line(f"  {k}", stats([t for t in trades if t["legStrength"] == k])))
print("-- by timeframe, STRONG vs WEAK")
for tf in ("1H", "15m", "5m"):
    print(line(f"  {tf} STRONG", stats([t for t in S if t["selectedTF"] == tf])))
    print(line(f"  {tf} WEAK", stats([t for t in Wk if t["selectedTF"] == tf])))
