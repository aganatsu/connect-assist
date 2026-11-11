"""LATEST_CHOCH_PREREG_V1 — gate (docs/LATEST_CHOCH_PREREG_V1.md). RESEARCH ONLY.
BASELINE = .cache/smc_bs_setups_*.json (flag off), VARIANT = .cache/smc_lc_setups_*.json (flag on).

    python3 -I local-runner/latest-choch-report.py
"""
import glob, json, random
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

base, var = load("smc_bs_setups"), load("smc_lc_setups")
bkeys = {(t["zoneId"], t["t"]) for t in base}
vkeys = {(t["zoneId"], t["t"]) for t in var}
new = [t for t in var if (t["zoneId"], t["t"]) not in bkeys]
removed = [t for t in base if (t["zoneId"], t["t"]) not in vkeys]

print("LATEST_CHOCH_PREREG_V1 — SMC replay 2026-03-29 → 2026-09-25, structureLatestChochDecides off vs on")
for lab, g in (("BASELINE (current code)", base), ("VARIANT (latest CHoCH decides)", var), ("NEW trades (let through)", new), ("REMOVED (slot effects)", removed)):
    print(line(lab, stats(g)))
half = {}
for h, f in (("1st half", lambda x: x["t"] < MID), ("2nd half", lambda x: x["t"] >= MID)):
    for lab, g in (("BASELINE", base), ("VARIANT", var), ("NEW", new)):
        half[(lab, h)] = stats([t for t in g if f(t)])
        print(line(f"  {lab} {h}", half[(lab, h)]))

sb, sv, sn = stats(base), stats(var), stats(new)
checks = [
    (f"NEW ≥ 30 trades ({sn['n']}) and exp > 0 ({sn['exp']:+.3f}R)", sn["n"] >= 30 and sn["exp"] > 0),
    (f"VARIANT beats BASELINE ({sv['exp']:+.3f} vs {sb['exp']:+.3f})", sv["exp"] > sb["exp"]),
]
for h in ("1st half", "2nd half"):
    n_, v_, b_ = half[("NEW", h)], half[("VARIANT", h)], half[("BASELINE", h)]
    checks.append((f"{h}: NEW ≥ 30 & > 0 ({n_['n']}, {n_['exp']:+.3f}) and VARIANT > BASELINE ({v_['exp']:+.3f} vs {b_['exp']:+.3f})",
                   n_["n"] >= 30 and n_["exp"] > 0 and v_["exp"] > b_["exp"]))
print("\n=== GATE (pre-registered) ===")
for k, ok in checks: print(f"  {'PASS' if ok else 'FAIL'}  {k}")
print(f"  RESULT: {'PASSED → add the Bot Config switch (default off)' if all(ok for _, ok in checks) else 'FAILED → no change'}")

print("\n=== DESCRIPTIVE ONLY ===")
print(line("NEW before costs", stats(new, "grossR")))
print(line("VARIANT before costs", stats(var, "grossR")))
print("-- NEW by pair")
for p in sorted({t["symbol"] for t in new}):
    print(line(f"  {p}", stats([t for t in new if t["symbol"] == p])))
