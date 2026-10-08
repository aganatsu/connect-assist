#!/usr/bin/env python3
"""STEP 17-C — two-session PostgreSQL concurrency proof for the atomic reset.

Runs ONLY against a disposable, EMPTY database on a real PostgreSQL server you control.
See README.md. Sessions: A (fill / order placement), B (reset), M (monitor: pg_stat_activity,
pg_blocking_pids). The schema is the repo's test-harness setup (build_bootstrap.ts), which
applies the repo migrations including 20261009010000_step17c_atomic_reset.

  export PG_URI='postgresql://postgres@localhost:5432/s17c_test'   # disposable, empty
  export S17C_DISPOSABLE_DB=yes
  python3 two_session_test.py [--bootstrap /path/bootstrap.sql] [--iterations 60]

Exit code 0 = every check passed. A transcript is written next to this file
(two_session_transcript.txt) unless --transcript is given.
"""
import argparse, json, os, random, re, subprocess, sys, threading, time, uuid, datetime as dt
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
PRODUCTION_MARKERS = ("supabase.co", "supabase.com", "supabase.net", "rvouzhacxqlbetwcttoe")

ap = argparse.ArgumentParser()
ap.add_argument("--bootstrap", help="schema SQL from build_bootstrap.ts (built automatically with deno if omitted)")
ap.add_argument("--iterations", type=int, default=60)
ap.add_argument("--transcript", default=os.path.join(HERE, "two_session_transcript.txt"))
args = ap.parse_args()

# ── safety: never production ─────────────────────────────────────────────────
uri = os.environ.get("PG_URI", "")
if not uri:
    sys.exit("REFUSED: set PG_URI to a disposable, empty PostgreSQL database (see README.md)")
if os.environ.get("S17C_DISPOSABLE_DB") != "yes":
    sys.exit("REFUSED: set S17C_DISPOSABLE_DB=yes to confirm PG_URI is a throwaway test database")
host = (urlparse(uri).hostname or "") + " " + uri
if any(m in host.lower() for m in PRODUCTION_MARKERS):
    sys.exit("REFUSED: PG_URI points at a Supabase host — this test must never run against production or any hosted project")

try:
    import psycopg
except ImportError:
    sys.exit("psycopg is required: pip install 'psycopg[binary]' (see requirements.txt)")

OUT = []
def log(*a):
    line = " ".join(str(x) for x in a); print(line, flush=True); OUT.append(line)
FAILS = []
def check(cond, msg):
    log(("  PASS " if cond else "  FAIL ") + msg)
    if not cond: FAILS.append(msg)
def now(): return dt.datetime.now(dt.timezone.utc).strftime("%H:%M:%S.%f")[:-3]
def conn():
    """A test session acting as the backend service role (as production's service key does), so the
    functions' caller check passes whatever the local superuser is named."""
    c = psycopg.connect(uri, autocommit=True)
    c.execute("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', false)")
    return c

M = conn()
log("server:", M.execute("select version()").fetchone()[0])
log("database:", M.execute("select current_database()").fetchone()[0])
if M.execute("select count(*) from information_schema.tables where table_schema = 'public'").fetchone()[0] > 0:
    sys.exit("REFUSED: the target database already has tables in schema public — use a new, empty database")

# ── schema ───────────────────────────────────────────────────────────────────
if args.bootstrap:
    sql = open(args.bootstrap).read()
else:
    out = os.path.join(HERE, ".bootstrap.sql")
    subprocess.run(["deno", "run", "--no-check", "--allow-read", f"--allow-write={out}",
                    os.path.join(HERE, "build_bootstrap.ts"), out], check=True, cwd=REPO)
    sql = open(out).read()
# roles are cluster-wide: create them only if missing
for role in ("anon", "authenticated", "service_role"):
    sql = re.sub(rf"create role {role};", f"DO $r$ BEGIN CREATE ROLE {role}; EXCEPTION WHEN duplicate_object THEN NULL; END $r$;", sql, count=1)
M.execute(sql)
log("schema: harness setup from the repo migrations (incl. 20261009010000_step17c_atomic_reset) loaded")
for t in ("paper_positions_serialize_with_reset", "pending_orders_serialize_with_reset"):
    assert M.execute("select count(*) from pg_trigger where tgname = %s", (t,)).fetchone()[0] == 1, t
MIGRATION_17C = open(os.path.join(REPO, "supabase/migrations/20261009010000_step17c_atomic_reset.sql")).read()

# ── helpers (production functions only) ─────────────────────────────────────
def new_account(balance=100000):
    u = str(uuid.uuid4())
    M.execute("insert into auth.users (id) values (%s)", (u,))
    M.execute("insert into public.paper_accounts (user_id, bot_id, balance, peak_balance, daily_pnl_base) values (%s, 'smc', %s, %s, %s)", (u, balance, balance, balance))
    return u
def pos_sql(u, pid):
    return ("insert into public.paper_positions (user_id, bot_id, position_id, order_id, symbol, direction, size, entry_price, stop_loss, take_profit, current_price, open_time, signal_score) "
            "values (%s, 'smc', %s, %s, 'USD/JPY', 'long', 1.0, 154.9, 154.694849, 155.507852, 155.53582, '2026-10-08T12:00:00Z', '46') returning id, created_at", (u, pid, "o" + pid))
def order_sql(u, oid, dry=False, symbol="EUR/USD"):
    return ("insert into public.pending_orders (user_id, bot_id, order_id, symbol, direction, order_type, entry_price, current_price, stop_loss, take_profit, status, expires_at, dry_run) "
            "values (%s, 'smc', %s, %s, 'long', 'limit', 1.1, 1.101, 1.098, 1.1022, 'pending', now() + interval '8 hours', %s) returning id", (u, oid, symbol, dry))
def acct(u):
    r = M.execute("select balance, ledger_epoch_id, ledger_reset_at from public.paper_accounts where user_id = %s", (u,)).fetchone()
    return {"balance": float(r[0]), "epoch": str(r[1]), "reset_at": r[2]}
def settle(u, row_id):
    return M.execute("select public.settle_paper_position(%s, %s, 'smc', %s::jsonb, 'scanner_breach_check')",
                     (row_id, u, json.dumps({"exit_price": 155.507852, "pnl": 871.19, "pnl_pips": 60.8, "close_reason": "tp_hit"}))).fetchone()[0]
def credited(s): return s.get("settled") is True and s.get("code") == "settled" and float(s.get("amount")) == 871.19
def guarded(c, u, reason): return c.execute("select public.reset_paper_account_if_flat(%s, 'smc', 100000, %s)", (u, reason)).fetchone()[0]
def wait_blocked(pid, timeout=5.0):
    t = time.time()
    while time.time() - t < timeout:
        r = M.execute("select wait_event_type, wait_event, pg_blocking_pids(pid) from pg_stat_activity where pid = %s", (pid,)).fetchone()
        if r and r[0] == "Lock" and r[2]: return r
        time.sleep(0.02)
    return M.execute("select wait_event_type, wait_event, pg_blocking_pids(pid) from pg_stat_activity where pid = %s", (pid,)).fetchone()
def pid(c): return c.execute("select pg_backend_pid()").fetchone()[0]

def writer_first(kind, label):
    """A writes (position or real order) and holds; B's guarded reset must block, then refuse."""
    u = new_account(104000); before = acct(u)
    A, B = conn(), conn(); a_pid, b_pid = pid(A), pid(B)
    A.execute("begin")
    row = A.execute(*(pos_sql(u, label) if kind == "position" else order_sql(u, label))).fetchone()
    log(f"{now()} A[{a_pid}] BEGIN; INSERT {kind} (trigger: account FOR KEY SHARE)  [open]")
    res = {}
    def b():
        B.execute("begin"); res["r"] = guarded(B, u, label); B.execute("commit")
    tb = threading.Thread(target=b); tb.start()
    w = wait_blocked(b_pid)
    log(f"{now()} B[{b_pid}] reset_paper_account_if_flat … wait_event={w[0]}/{w[1]} blocked_by={w[2]}")
    check(w[0] == "Lock" and a_pid in (w[2] or []), f"{label}: reset is blocked by the {kind} writer on the account-row lock")
    time.sleep(0.4); A.execute("commit"); log(f"{now()} A COMMIT"); tb.join(10)
    r = res.get("r") or {}
    log(f"{now()} B → {json.dumps(r)}")
    key = "openPositions" if kind == "position" else "activeRealOrders"
    check(r.get("reset") is False and r.get("code") == "reset_refused_real_exposure" and r.get("exposure", {}).get(key) == 1,
          f"{label}: reset REFUSED after the lock — it saw the committed {kind}")
    check(acct(u) == before, f"{label}: refusal changed nothing (balance, epoch, reset time)")
    if kind == "position":
        s = settle(u, row[0]); check(credited(s), f"{label}: the position's close is credited in full ({s.get('code')}, {s.get('amount')})")
    A.close(); B.close()

def reset_first(kind, label):
    """B's guarded reset holds the lock; A (whose transaction began EARLIER) writes and must block until B commits."""
    u = new_account(98000)
    A, B = conn(), conn(); a_pid, b_pid = pid(A), pid(B)
    A.execute("begin"); a_start = A.execute("select transaction_timestamp()").fetchone()[0]
    log(f"{now()} A[{a_pid}] BEGIN (transaction_timestamp {a_start})")
    time.sleep(0.2)
    B.execute("begin"); rb = guarded(B, u, label)
    log(f"{now()} B[{b_pid}] BEGIN; reset_paper_account_if_flat → reset={rb.get('reset')}  [B holds FOR UPDATE]")
    res = {}
    def a():
        res["row"] = A.execute(*(pos_sql(u, label) if kind == "position" else order_sql(u, label))).fetchone()
        res["after_insert"] = A.execute("select clock_timestamp()").fetchone()[0]; A.execute("commit")
    ta = threading.Thread(target=a); ta.start()
    w = wait_blocked(a_pid)
    log(f"{now()} A INSERT {kind} … wait_event={w[0]}/{w[1]} blocked_by={w[2]}")
    check(w[0] == "Lock" and b_pid in (w[2] or []), f"{label}: the {kind} writer is blocked by the reset on the account-row lock")
    time.sleep(0.4)
    b_precommit = B.execute("select clock_timestamp()").fetchone()[0]; B.execute("commit"); log(f"{now()} B COMMIT")
    ta.join(10); st = acct(u)
    check(rb.get("reset") is True, f"{label}: the reset succeeded (flat when it locked)")
    check(res["after_insert"] > b_precommit, f"{label}: the {kind} insert completed only AFTER the reset committed (no escape)")
    if kind == "position":
        created = res["row"][1]
        log(f"   A txn start {a_start} | ledger_reset_at {st['reset_at']} | created_at {created}")
        check(a_start < st["reset_at"], f"{label}: A's transaction START predates the reset (the old now() default would have been pre-epoch)")
        check(created > st["reset_at"], f"{label}: created_at (stamped after the lock) > ledger_reset_at → new epoch")
        s = settle(u, res["row"][0]); check(credited(s), f"{label}: the close is credited in full — never $0 ({s.get('code')}, {s.get('amount')})")
    A.close(); B.close()

# ── A / B / C ────────────────────────────────────────────────────────────────
log("\n=== A: fill first → reset second ===");                writer_first("position", "A-fill-first")
log("\n=== B: reset first → fill second ===");                reset_first("position", "B-reset-first")
log("\n=== C1: real order placement first → reset second ==="); writer_first("order", "C1-order-first")
log("\n=== C2: reset first → real order placement second ==="); reset_first("order", "C2-reset-first")

# ── controls: without the triggers the races are real ───────────────────────
log("\n=== CONTROLS: triggers removed — the original races reproduce ===")
M.execute("drop trigger paper_positions_serialize_with_reset on public.paper_positions; drop trigger pending_orders_serialize_with_reset on public.pending_orders;"
          "alter table public.paper_positions alter column created_at set default now();")
u = new_account(98000); A, B = conn(), conn()
A.execute("begin"); a_start = A.execute("select transaction_timestamp()").fetchone()[0]; time.sleep(0.2)
B.execute("begin"); B.execute("select public.reset_paper_account(%s, 'smc', 100000, 'control')", (u,)); B.execute("commit")
row = A.execute(*pos_sql(u, "ctl")).fetchone(); A.execute("commit"); s = settle(u, row[0])
check(s.get("code") == "settled_pre_epoch" and float(s.get("amount")) == 0, "control (position): opened after the reset, it settles pre-epoch $0 — the bug the fix closes")
u = new_account(98000); B.execute("begin"); rb = guarded(B, u, "control-order")
A.execute("begin"); A.execute(*order_sql(u, "ctlord")); A.execute("commit")   # does not block without the trigger
B.execute("commit")
check(rb.get("reset") is True and M.execute("select count(*) from public.pending_orders where user_id = %s and not dry_run and status = 'pending'", (u,)).fetchone()[0] == 1,
      "control (order): a real order committed while the reset held the lock and the reset still succeeded — the escape the order trigger closes")
A.close(); B.close()
M.execute(MIGRATION_17C); log("controls: 17-C migration re-applied")

# ── D: stress ────────────────────────────────────────────────────────────────
log(f"\n=== D: STRESS — {args.iterations} randomised races (position or real order vs guarded reset) ===")
stats = {"refused": 0, "reset_then_writer_after": 0, "violations": 0, "deadlocks": 0, "errors": 0}
for i in range(args.iterations):
    kind = random.choice(["position", "order"]); u = new_account(99000 + i)
    A, B = conn(), conn(); o = {}
    def fa():
        try:
            A.execute("begin"); time.sleep(random.uniform(0, 0.04))
            o["row"] = A.execute(*(pos_sql(u, f"s{i}") if kind == "position" else order_sql(u, f"s{i}"))).fetchone()
            o["after"] = A.execute("select clock_timestamp()").fetchone()[0]; time.sleep(random.uniform(0, 0.04)); A.execute("commit")
        except psycopg.errors.DeadlockDetected: o["deadlock"] = True
        except Exception as e: o["errA"] = repr(e)
    def fb():
        try:
            B.execute("begin"); time.sleep(random.uniform(0, 0.04)); o["r"] = guarded(B, u, "stress"); time.sleep(random.uniform(0, 0.04))
            o["precommit"] = B.execute("select clock_timestamp()").fetchone()[0]; B.execute("commit")
        except psycopg.errors.DeadlockDetected: o["deadlock"] = True
        except Exception as e: o["errB"] = repr(e)
    t1, t2 = threading.Thread(target=fa), threading.Thread(target=fb)
    (t1.start(), t2.start()) if random.random() < 0.5 else (t2.start(), t1.start()); t1.join(15); t2.join(15)
    if o.get("deadlock"): stats["deadlocks"] += 1
    if "errA" in o or "errB" in o: stats["errors"] += 1; log("  error", i, o.get("errA"), o.get("errB")); A.close(); B.close(); continue
    st = acct(u)
    if o["r"].get("reset"):
        ok = o["after"] > o["precommit"]
        if kind == "position": ok = ok and o["row"][1] > st["reset_at"] and credited(settle(u, o["row"][0]))
        stats["reset_then_writer_after" if ok else "violations"] += 1
        if not ok: log("  VIOLATION", i, kind, o)
    else:
        ok = o["r"].get("code") == "reset_refused_real_exposure"
        if kind == "position": ok = ok and credited(settle(u, o["row"][0]))
        stats["refused" if ok else "violations"] += 1
        if not ok: log("  VIOLATION", i, kind, o)
    A.close(); B.close()
log("stress:", json.dumps(stats))
check(stats["violations"] == 0 and stats["deadlocks"] == 0 and stats["errors"] == 0,
      f"{args.iterations} races: no pre-epoch position, no escaped real order, no lost P/L, no deadlock, no error")

# ── E: controls ──────────────────────────────────────────────────────────────
log("\n=== E: dry-run orders, system-reset, client access ===")
u = new_account(97000)
M.execute("update public.paper_accounts set entries_locked = true where user_id = %s", (u,))
M.execute(*order_sql(u, "dry17c", dry=True))
r = guarded(M, u, "dry")
check(r.get("reset") is True and r["exposure"]["activeDryRunOrders"] == 1, "dry-run orders alone do not block the reset (1 reported)")
check(M.execute("select status from public.pending_orders where order_id = 'dry17c'").fetchone()[0] == "pending", "the dry-run order is not cancelled")
S = conn(); S.execute("set role service_role")
check(S.execute("select public.reset_paper_account(%s, 'smc', 100000, 'system reset')", (u,)).fetchone()[0].get("reset") is True,
      "system-reset path: service_role still calls reset_paper_account")
S.close()
C = psycopg.connect(uri, autocommit=True); C.execute("set role authenticated")
C.execute("select set_config('request.jwt.claims', %s, false), set_config('request.jwt.claim.sub', %s, false)", (json.dumps({"role": "authenticated", "sub": u}), u))
try: C.execute("select public.reset_paper_account(%s, 'smc', 1, 'bypass')", (u,)); bypass = "ALLOWED"
except psycopg.errors.InsufficientPrivilege: bypass = "permission denied"
check(bypass == "permission denied", f"a client cannot call the unguarded reset_paper_account ({bypass})")
check(guarded(C, u, "own").get("reset") is True, "a client resets its OWN flat account only through the guarded function")
M.execute("insert into public.paper_positions (user_id, bot_id, position_id, order_id, symbol, direction, size, entry_price, stop_loss, take_profit, current_price, open_time, signal_score) "
          "values (%s, 'smc', 'cli', 'ocli', 'USD/JPY', 'long', 1, 154.9, 154.69, 155.5, 155.5, now(), '46')", (u,))
check(guarded(C, u, "own-exposed").get("code") == "reset_refused_real_exposure", "a client cannot bypass the exposure check (refused with an open position)")
other = new_account(50000)
check(guarded(C, other, "other").get("code") == "forbidden", "a client cannot reset ANOTHER user's account")
C.close()
log("  NOTE 16-D caller-level guard (paper-trading TypeScript) is covered by the Deno suite (step16AccountResetGuard.test.ts).")

log("\n=== RESULT:", "ALL PASS" if not FAILS else f"{len(FAILS)} FAIL(S): {FAILS}", "===")
open(args.transcript, "w").write("\n".join(OUT) + "\n")
log("transcript:", args.transcript)
sys.exit(1 if FAILS else 0)
