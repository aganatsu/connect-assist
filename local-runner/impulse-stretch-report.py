"""IMPULSE_STRETCH_PREREG_V1 report. python3 -I local-runner/impulse-stretch-report.py"""
import json, glob, os, math, random
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
def load(corpus, arm):
    out = []
    for f in sorted(glob.glob(f"{D}/stretch_{corpus}_{arm}_setups_*.json")):
        out += [s for s in json.load(open(f)) if s["outcome"] == "TRADE_TAKEN"]
    return out
key = lambda s: (s["symbol"], s["direction"], s["fillTime"])
def stats(ts):
    n = len(ts)
    if not n: return dict(n=0, wr=float("nan"), exp=float("nan"), gross=float("nan"), lo=float("nan"), hi=float("nan"))
    r = [t["netR"] for t in ts]; random.seed(7)
    bs = sorted(sum(random.choice(r) for _ in r) / n for _ in range(2000))
    return dict(n=n, wr=100 * sum(t["grossR"] > 0 for t in ts) / n, exp=sum(r) / n,
                gross=sum(t["grossR"] for t in ts) / n, lo=bs[50], hi=bs[1949])
def row(label, ts):
    s = stats(ts)
    return f"| {label} | {s['n']} | {s['wr']:.1f}% | {s['exp']:+.3f}R | [{s['lo']:+.3f}, {s['hi']:+.3f}] | {s['gross']:+.3f}R |"
def half(ts, h): return [t for t in ts if t["window"] == h]
for corpus in ("is", "oos"):
    base, strict = load(corpus, "base"), load(corpus, "strict")
    if not base: continue
    sk = {key(t) for t in strict}; bk = {key(t) for t in base}
    removed = [t for t in base if key(t) not in sk]; added = [t for t in strict if key(t) not in bk]
    print(f"\n## {corpus.upper()}\n\n| arm | trades | WR | net exp | 95% CI | gross |\n|---|---|---|---|---|---|")
    for lab, ts in (("BASE", base), ("STRICT", strict), ("REMOVED", removed), ("ADDED", added)): print(row(lab, ts))
    for h in ("h1", "h2"):
        print(row(f"BASE {h}", half(base, h))); print(row(f"STRICT {h}", half(strict, h)))
    print("\nby pair (BASE → STRICT net exp, removed n):")
    for sym in sorted({t["symbol"] for t in base}):
        b = [t for t in base if t["symbol"] == sym]; s = [t for t in strict if t["symbol"] == sym]
        r = [t for t in removed if t["symbol"] == sym]
        print(f"  {sym}: {stats(b)['exp']:+.3f} (n={len(b)}) → {stats(s)['exp']:+.3f} (n={len(s)}); removed {len(r)} @ {stats(r)['exp']:+.3f}")
    sb, ss, sr = stats(base), stats(strict), stats(removed)
    if corpus == "is":
        g = [ss["exp"] > sb["exp"] and all(stats(half(strict, h))["exp"] > stats(half(base, h))["exp"] for h in ("h1", "h2")),
             sr["n"] >= 30 and sr["exp"] < 0, ss["n"] >= 0.4 * sb["n"]]
        print(f"\nIS gates: 1 {'PASS' if g[0] else 'FAIL'} · 2 {'PASS' if g[1] else 'FAIL'} · 3 {'PASS' if g[2] else 'FAIL'}")
    else:
        print(f"\nOOS gate 4: {'PASS' if ss['exp'] > sb['exp'] and sr['exp'] < 0 else 'FAIL'}")
