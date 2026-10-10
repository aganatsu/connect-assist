/**
 * Execution harness for bot-scanner's runScanForUser — in-memory tables, a
 * stubbed provider, and a log of every write and outbound call.
 *
 * Built for the Candidate C shadow (PR "shadow-zonemid"): run the REAL scanner
 * code with the shadow flag off and on, and compare everything A writes.
 * Not a PostgREST emulator: it implements the query-builder surface the
 * scanner uses (filters, order, limit, single/maybeSingle, insert/update/
 * upsert/delete with optional returning) over plain arrays.
 */

export type Row = Record<string, any>;
export interface WriteRecord { table: string; op: "insert" | "update" | "upsert" | "delete"; payload: unknown; filters: string[] }
export interface CallRecord { kind: "provider" | "credit" | "telegram" | "other"; url: string; phase: string }

export class FakeDb {
  tables = new Map<string, Row[]>();
  writes: WriteRecord[] = [];
  reads: { table: string; filters: string[]; phase: string }[] = [];
  rpcs: { name: string; args: unknown }[] = [];
  /** Advanced by `onRead` hooks; stamped on every outbound call. */
  phase = "start";
  onRead: ((table: string, filters: string[]) => void) | null = null;
  rpcHandlers = new Map<string, (args: any) => unknown>();
  /** Fault injection: return "throw" to throw from the query, "error" to return a PostgREST-style error. */
  fault: ((op: "read" | "write", table: string, filters: string[], payload: unknown) => "throw" | "error" | null) | null = null;

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [t, rows] of Object.entries(seed)) this.tables.set(t, rows.map((r) => structuredClone(r)));
  }
  rows(t: string): Row[] {
    let r = this.tables.get(t);
    if (!r) { r = []; this.tables.set(t, r); }
    return r;
  }
  client() {
    return {
      from: (t: string) => new FakeQuery(this, t),
      rpc: (name: string, args: unknown) => {
        this.rpcs.push({ name, args });
        const h = this.rpcHandlers.get(name);
        return Promise.resolve(h ? { data: h(args), error: null } : { data: null, error: null });
      },
    };
  }
}

type Filter = { desc: string; test: (r: Row) => boolean };
const eqv = (a: unknown, b: unknown) =>
  a === b || (a != null && b != null && typeof a !== "object" && typeof b !== "object" && String(a) === String(b));

class FakeQuery {
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private filters: Filter[] = [];
  private payload: any = null;
  private upsertOpts: any = null;
  private returning = false;
  private selectOpts: any = null;
  private orderBy: { col: string; asc: boolean }[] = [];
  private limitN: number | null = null;
  private mode: "many" | "single" | "maybe" = "many";

  constructor(private db: FakeDb, private table: string) {}

  select(_cols?: string, opts?: any) {
    if (this.op === "select") this.selectOpts = opts ?? null;
    else this.returning = true;
    return this;
  }
  insert(rows: any, _opts?: any) { this.op = "insert"; this.payload = rows; return this; }
  update(patch: any) { this.op = "update"; this.payload = patch; return this; }
  upsert(rows: any, opts?: any) { this.op = "upsert"; this.payload = rows; this.upsertOpts = opts ?? {}; return this; }
  delete() { this.op = "delete"; return this; }

  private add(desc: string, test: (r: Row) => boolean) { this.filters.push({ desc, test }); return this; }
  eq(c: string, v: unknown) { return this.add(`${c}=eq.${v}`, (r) => eqv(r[c], v)); }
  neq(c: string, v: unknown) { return this.add(`${c}=neq.${v}`, (r) => !eqv(r[c], v)); }
  in(c: string, vs: unknown[]) { return this.add(`${c}=in.(${vs.join(",")})`, (r) => vs.some((v) => eqv(r[c], v))); }
  is(c: string, v: unknown) { return this.add(`${c}=is.${v}`, (r) => (v === null ? r[c] == null : r[c] === v)); }
  not(c: string, op: string, v: unknown) {
    if (op === "is") return this.add(`${c}=not.is.${v}`, (r) => (v === null ? r[c] != null : r[c] !== v));
    if (op === "in") {
      const vs = String(v).replace(/[()]/g, "").split(",");
      return this.add(`${c}=not.in.${v}`, (r) => !vs.some((x) => eqv(r[c], x)));
    }
    return this.add(`${c}=not.${op}.${v}`, (r) => !eqv(r[c], v));
  }
  gt(c: string, v: any) { return this.add(`${c}=gt.${v}`, (r) => r[c] != null && r[c] > v); }
  gte(c: string, v: any) { return this.add(`${c}=gte.${v}`, (r) => r[c] != null && r[c] >= v); }
  lt(c: string, v: any) { return this.add(`${c}=lt.${v}`, (r) => r[c] != null && r[c] < v); }
  lte(c: string, v: any) { return this.add(`${c}=lte.${v}`, (r) => r[c] != null && r[c] <= v); }
  like(c: string, p: string) { return this.add(`${c}=like.${p}`, () => true); }
  ilike(c: string, p: string) { return this.add(`${c}=ilike.${p}`, () => true); }
  /** `or` is accepted and not applied (the scanner uses it only for the scan lock). */
  or(expr: string) { return this.add(`or=(${expr})`, () => true); }
  filter(c: string, op: string, v: unknown) { return this.add(`${c}=${op}.${v}`, () => true); }
  contains(c: string, v: unknown) { return this.add(`${c}=cs.${JSON.stringify(v)}`, () => true); }
  order(col: string, o?: { ascending?: boolean }) { this.orderBy.push({ col, asc: o?.ascending !== false }); return this; }
  limit(n: number) { this.limitN = n; return this; }
  range(a: number, b: number) { this.limitN = b - a + 1; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }
  abortSignal() { return this; }

  then(resolve: (v: any) => any, reject?: (e: any) => any) {
    try { return Promise.resolve(this.exec()).then(resolve, reject); } catch (e) { return Promise.reject(e).then(resolve, reject); }
  }

  private matched(): Row[] { return this.db.rows(this.table).filter((r) => this.filters.every((f) => f.test(r))); }
  private shape(rows: Row[]) {
    let out = [...rows];
    for (const o of [...this.orderBy].reverse()) {
      out.sort((a, b) => (a[o.col] === b[o.col] ? 0 : (a[o.col] > b[o.col] ? 1 : -1) * (o.asc ? 1 : -1)));
    }
    if (this.limitN != null) out = out.slice(0, this.limitN);
    out = out.map((r) => structuredClone(r));
    if (this.mode === "single") {
      return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { code: "PGRST116", message: `${out.length} rows` } };
    }
    if (this.mode === "maybe") return { data: out[0] ?? null, error: null };
    return { data: out, error: null, count: this.selectOpts?.count ? out.length : null };
  }
  private exec() {
    const desc = this.filters.map((f) => f.desc);
    const f = this.db.fault?.(this.op === "select" ? "read" : "write", this.table, desc, this.payload) ?? null;
    if (f === "throw") throw new Error(`injected fault: ${this.op} ${this.table}`);
    if (f === "error") return { data: null, error: { code: "XX000", message: `injected error: ${this.op} ${this.table}` } };
    if (this.op === "select") {
      this.db.reads.push({ table: this.table, filters: desc, phase: this.db.phase });
      this.db.onRead?.(this.table, desc);
      return this.shape(this.matched());
    }
    this.db.writes.push({ table: this.table, op: this.op, payload: structuredClone(this.payload), filters: desc });
    const rows = this.db.rows(this.table);
    if (this.op === "insert") {
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((r: Row) => ({ id: crypto.randomUUID(), ...r }));
      rows.push(...list);
      return this.returning ? this.shape(list) : { data: null, error: null };
    }
    if (this.op === "update") {
      const hit = this.matched();
      for (const r of hit) Object.assign(r, structuredClone(this.payload));
      return this.returning ? this.shape(hit) : { data: null, error: null };
    }
    if (this.op === "upsert") {
      const keys = String(this.upsertOpts?.onConflict ?? "id").split(",").map((s: string) => s.trim());
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      for (const p of list) {
        const ex = rows.find((r) => keys.every((k) => eqv(r[k], p[k])));
        if (ex) { if (!this.upsertOpts?.ignoreDuplicates) Object.assign(ex, structuredClone(p)); }
        else rows.push({ id: crypto.randomUUID(), ...structuredClone(p) });
      }
      return this.returning ? this.shape(list) : { data: null, error: null };
    }
    const hit = new Set(this.matched());
    this.db.tables.set(this.table, rows.filter((r) => !hit.has(r)));
    return { data: null, error: null };
  }
}

// ── Provider stub ───────────────────────────────────────────────────────────

const STEP_MIN: Record<string, number> = { "1min": 1, "5min": 5, "15min": 15, "30min": 30, "1h": 60, "4h": 240, "1day": 1440, "1week": 10080 };

/**
 * Deterministic candles for (symbol, interval), anchored to a FIXED base time so
 * two runs seconds apart see identical series. `priceOf` maps a symbol to its
 * level; bars oscillate gently around it.
 */
export function syntheticSeries(symbol: string, tdInterval: string, n: number, baseMs: number, priceOf: (s: string) => number) {
  const step = (STEP_MIN[tdInterval] ?? 5) * 60_000;
  const last = Math.floor(baseMs / step) * step - step;
  const p0 = priceOf(symbol);
  const amp = p0 * 0.0004;
  const values = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = last - i * step;
    const k = (t / step) % 997;
    const mid = p0 + amp * Math.sin(k / 7);
    const open = mid - amp * 0.2 * Math.cos(k / 3);
    const close = mid + amp * 0.2 * Math.cos(k / 5);
    values.push({
      datetime: new Date(t).toISOString().replace("T", " ").slice(0, 19),
      open: open.toFixed(6), high: (Math.max(open, close) + amp * 0.3).toFixed(6),
      low: (Math.min(open, close) - amp * 0.3).toFixed(6), close: close.toFixed(6), volume: "100",
    });
  }
  return values;
}

/** Stamp fixed OHLC bars so the LAST one is the bar before the one forming at `baseMs` (as syntheticSeries). */
export function anchoredSeries(bars: { open: number; high: number; low: number; close: number }[], tdInterval: string, baseMs: number) {
  const step = (STEP_MIN[tdInterval] ?? 5) * 60_000;
  const last = Math.floor(baseMs / step) * step - step;
  return bars.map((b, i) => ({
    datetime: new Date(last - (bars.length - 1 - i) * step).toISOString().replace("T", " ").slice(0, 19),
    open: String(b.open), high: String(b.high), low: String(b.low), close: String(b.close), volume: "100",
  }));
}

/**
 * Replace global fetch for the duration of `fn`. Provider requests get
 * synthetic candles, the credit RPC is granted, everything is recorded with
 * the db's current phase.
 */
/** OHLC bars (oldest first) that replace the synthetic series for one (symbol, interval). */
export type SeriesOverride = (tdSymbol: string, tdInterval: string) => { open: number; high: number; low: number; close: number }[] | null;

export async function withStubbedNetwork<T>(
  db: FakeDb, calls: CallRecord[], baseMs: number, priceOf: (s: string) => number, fn: () => Promise<T>,
  override?: SeriesOverride,
): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("api.twelvedata.com")) {
      calls.push({ kind: "provider", url: url.replace(/apikey=[^&]+/, "apikey=***"), phase: db.phase });
      const u = new URL(url);
      const sym = u.searchParams.get("symbol") ?? "";
      const iv = u.searchParams.get("interval") ?? "5min";
      const n = Number(u.searchParams.get("outputsize") ?? 200);
      const fixed = override?.(sym, iv);
      const values = fixed ? anchoredSeries(fixed, iv, baseMs) : syntheticSeries(sym, iv, Math.min(n, 500), baseMs, priceOf);
      return Promise.resolve(new Response(JSON.stringify({ status: "ok", values })));
    }
    if (url.includes("/rpc/reserve_api_credit")) {
      calls.push({ kind: "credit", url, phase: db.phase });
      return Promise.resolve(new Response("true"));
    }
    if (url.includes("telegram-notify")) {
      calls.push({ kind: "telegram", url, phase: db.phase });
      return Promise.resolve(new Response("{}"));
    }
    calls.push({ kind: url.includes("polygon") ? "provider" : "other", url, phase: db.phase });
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}

// ── Normalisation for OFF-vs-ON comparison ──────────────────────────────────

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** Fields that measure wall-clock time or run identity, not behaviour.
 *  `ict_hash` hashes smc_scan_decision.ict_input, which embeds killZone.at (the wall clock). */
const VOLATILE = new Set(["ict_hash", "ms", "elapsed_ms", "elapsedMs", "durationMs", "duration_ms", "scan_lock_until", "barStalenessMin", "t0", "startedAt", "finishedAt", "wallMs", "mgmtMs"]);

export function normalise(v: unknown): unknown {
  if (typeof v === "string") {
    if (v.startsWith("{") || v.startsWith("[")) {
      try { return normalise(JSON.parse(v)); } catch { /* not JSON */ }
    }
    return v.replace(ISO, "<ts>").replace(UUID, "<uuid>");
  }
  if (Array.isArray(v)) return v.map(normalise);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = VOLATILE.has(k) ? "<vol>" : normalise((v as any)[k]);
    return out;
  }
  return v;
}

// ── Clock ───────────────────────────────────────────────────────────────────

/**
 * Run `fn` with the wall clock moved to `startMs` (time still advances). Both
 * `Date.now()` and `new Date()` move together, so market-hours, TTL and
 * staleness logic all see one consistent fake time — independent of when CI
 * runs (FX is closed at weekends).
 */
export async function withFakeClock<T>(startMs: number, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const offset = startMs - RealDate.now();
  class FakeDate extends RealDate {
    constructor(...a: any[]) {
      if (a.length === 0) super(RealDate.now() + offset);
      else super(...(a as [any]));
    }
    static override now() { return RealDate.now() + offset; }
  }
  (globalThis as any).Date = FakeDate;
  try { return await fn(); } finally { (globalThis as any).Date = RealDate; }
}

// ── Environment ─────────────────────────────────────────────────────────────

/**
 * Run `fn` with `Deno.env.get` answering `vars` first. Isolate-local: the
 * process environment is never written, so parallel test modules are unaffected.
 * `undefined` hides a variable.
 */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const env = Deno.env as any;
  const real = env.get;
  env.get = (k: string) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : real.call(Deno.env, k));
  try { return await fn(); } finally { env.get = real; }
}
