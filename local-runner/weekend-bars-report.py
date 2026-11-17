"""WEEKEND_BARS_PREREG_V1 — gate (docs/WEEKEND_BARS_PREREG_V1.md). RESEARCH ONLY.
BASELINE = .cache/smc_wk_base_setups_*.json (weekend bars kept), VARIANT = .cache/smc_wk_drop_setups_*.json.

    python3 -I local-runner/weekend-bars-report.py
"""
import glob, json, random
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MID = "2026-06-27"

def load(prefix):
    rows = []
    for f in sorted(glob.glob(str(ROOT / f"local-runner/.cache/{prefix}_*.json"))):
        rows += json.load(open(f))
    return [r for r in rows if r["outcome"] == "TRADE_TAKEN" and not r["ambiguous"]]

def stats(xs, key="netR"):
    rs = [x[key] for x in xs if x.get(key) is not None]
    n = len(rs)
    if not n: return {"n": 0, "exp": float("nan"), "wr": float("nan"), "pf": float("nan"), "lo": float("nan"), "hi": float("nan")}
    w = sum(r for r in rs if r > 0); l = -sum(r for r in rs if r <= 0)
    rnd = random.Random(1); b = sorted(sum(rs[rnd.randrange(n)] for _ in range(n)) / n for _ in range(2000))
    return {"n": n, "exp": sum(rs) / n, "wr": sum(1 for r in rs if r > 0) / n, "pf": w / l if l else float("inf"), "lo": b[50], "hi": b[1949]}

def line(label, s):
    return f"{label:<30} n={s['n']:>5}  WR {s['wr']*100:5.1f}%  exp {s['exp']:+.3f}R  95%CI [{s['lo']:+.3f}, {s['hi']:+.3f}]  PF {s['pf']:.2f}"

def monday(t):
    return datetime.fromisoformat(t["t"].replace("Z", "+00:00")).weekday() == 0

base, var = load("smc_wk_base_setups"), load("smc_wk_drop_setups")
bkeys = {(t["symbol"], t["t"]) for t in base}
vkeys = {(t["symbol"], t["t"]) for t in var}
only_var = [t for t in var if (t["symbol"], t["t"]) not in bkeys]
only_base = [t for t in base if (t["symbol"], t["t"]) not in vkeys]

print("WEEKEND_BARS_PREREG_V1 — SMC replay 2026-03-29 → 2026-09-25, weekend bars kept vs dropped")
for lab, g in (("BASELINE (weekend bars kept)", base), ("VARIANT (weekend bars dropped)", var),
               ("only in VARIANT", only_var), ("only in BASELINE", only_base)):
    print(line(lab, stats(g)))
half = {}
for h, f in (("1st half", lambda x: x["t"] < MID), ("2nd half", lambda x: x["t"] >= MID)):
    for lab, g in (("BASELINE", base), ("VARIANT", var)):
        half[(lab, h)] = stats([t for t in g if f(t)])
        print(line(f"  {lab} {h}", half[(lab, h)]))

sb, sv = stats(base), stats(var)
checks = [(f"VARIANT ≥ BASELINE − 0.05R overall ({sv['exp']:+.3f} vs {sb['exp']:+.3f})", sv["exp"] >= sb["exp"] - 0.05)]
for h in ("1st half", "2nd half"):
    v_, b_ = half[("VARIANT", h)], half[("BASELINE", h)]
    checks.append((f"{h}: VARIANT ≥ BASELINE − 0.05R ({v_['exp']:+.3f} vs {b_['exp']:+.3f})", v_["exp"] >= b_["exp"] - 0.05))
checks.append((f"VARIANT trades ≥ 70% of BASELINE ({sv['n']} vs {sb['n']})", sv["n"] >= 0.7 * sb["n"]))
print("\n=== GATE (pre-registered) ===")
for k, ok in checks: print(f"  {'PASS' if ok else 'FAIL'}  {k}")
print(f"  RESULT: {'PASSED → ship the fix (default on)' if all(ok for _, ok in checks) else 'FAILED → no change'}")

print("\n=== DESCRIPTIVE ONLY ===")
print(line("BASELINE before costs", stats(base, "grossR")))
print(line("VARIANT before costs", stats(var, "grossR")))
print(line("BASELINE Mondays", stats([t for t in base if monday(t)])))
print(line("VARIANT Mondays", stats([t for t in var if monday(t)])))
print(line("BASELINE Tue–Fri", stats([t for t in base if not monday(t)])))
print(line("VARIANT Tue–Fri", stats([t for t in var if not monday(t)])))
print("-- by pair (BASELINE | VARIANT)")
for p in sorted({t["symbol"] for t in base + var}):
    b_, v_ = stats([t for t in base if t["symbol"] == p]), stats([t for t in var if t["symbol"] == p])
    print(f"  {p:<8} n {b_['n']:>4} exp {b_['exp']:+.3f}  |  n {v_['n']:>4} exp {v_['exp']:+.3f}")
