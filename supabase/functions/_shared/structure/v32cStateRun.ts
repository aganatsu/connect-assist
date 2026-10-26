// One v32c-state run for one pair: load canonical bars → replay → compare with stored → append new snapshots / checkpoints /
// audit rows. Called by supabase/functions/v32c-state (hourly, recent window) and local-runner/v32c-state-backfill.ts (full history).
// Writes only structure_v3_snapshots / structure_v3_checkpoints / structure_v3_audit. No provider call, no trading table.
import { fxOpenNY, STRUCTURE_PAIRS } from "./canonicalBars.ts";
import { computeV3State, planV3Writes, staleness, V32C_ENGINE_VERSION, type H1, type V3Checkpoint, type V3Plan } from "./v32cState.ts";

export const RUNNER_ENV = "V32C_STATE_RUNNER"; // "on" enables the hourly function; anything else (default) = off
/** The hourly function judges and writes snapshots closing within this window (8 days spans any weekend with margin). */
export const AUDIT_WINDOW_MS = 8 * 86_400_000;

// The query-builder surface used (supabase-js, and the test harness's FakeDb).
// deno-lint-ignore no-explicit-any
type Client = { from: (table: string) => any };
const iso = (v: string | number) => new Date(typeof v === "number" ? v : Date.parse(v)).toISOString(); // PostgREST returns +00:00

async function pages<T>(q: (from: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, what: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from);
    if (error) throw new Error(`${what}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

export interface RunResult { symbol: string; ok: boolean; counts: Record<string, number>; stale: ReturnType<typeof staleness>; latest1H: unknown; latest4H: unknown; repaints: number; checkpointMismatches: number; dryRun: boolean }

/** `materializeFrom` = -Infinity for the full-history backfill / audit; the hourly function passes now − AUDIT_WINDOW_MS. */
export async function runV3StateForPair(db: Client, symbol: string, o: { nowMs: number; materializeFrom: number; dryRun?: boolean }): Promise<RunResult & { plan: V3Plan }> {
  if (!STRUCTURE_PAIRS.includes(symbol as typeof STRUCTURE_PAIRS[number])) throw new Error(`not a structure pair: ${symbol}`);
  type BarRow = { bar_time: string; open: number; high: number; low: number; close: number };
  const rows = await pages<BarRow>((f) => db.from("structure_bars_1h").select("bar_time,open,high,low,close").eq("symbol", symbol).order("bar_time").range(f, f + 999), `bars ${symbol}`);
  const hours: H1[] = rows.map((r) => ({ t: Date.parse(r.bar_time), o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close) }));
  const computed = computeV3State(symbol, hours, o.materializeFrom);
  const since = Number.isFinite(o.materializeFrom) ? iso(o.materializeFrom) : "1970-01-01T00:00:00.000Z";

  type SnapRow = { tf: string; known_at: string; state_hash: string };
  const storedRows = await pages<SnapRow>((f) => db.from("structure_v3_snapshots").select("tf,known_at,state_hash").eq("symbol", symbol).eq("engine_version", V32C_ENGINE_VERSION).gte("known_at", since).order("tf").order("known_at").range(f, f + 999), `snapshots ${symbol}`);
  const stored = new Map(storedRows.map((r) => [`${r.tf}|${iso(r.known_at)}`, r.state_hash]));
  const cpRows = await pages<V3Checkpoint>((f) => db.from("structure_v3_checkpoints").select("symbol,known_at,engine_version,bars_1h,last_bar_time,h1_known_at,h1_state_hash,h4_known_at,h4_state_hash,d_state_hash").eq("symbol", symbol).eq("engine_version", V32C_ENGINE_VERSION).gte("known_at", since).order("known_at").range(f, f + 999), `checkpoints ${symbol}`);
  const norm = (v: string | null) => (v === null ? null : iso(v));
  const storedCp = new Map(cpRows.map((c) => [iso(c.known_at), { ...c, known_at: iso(c.known_at), last_bar_time: iso(c.last_bar_time), h1_known_at: norm(c.h1_known_at), h4_known_at: norm(c.h4_known_at) }]));

  const plan = planV3Writes(computed, stored, storedCp, o.materializeFrom);
  const stale = staleness(hours, o.nowMs, fxOpenNY);
  const audit = [
    ...plan.repaints.map((r) => ({ symbol, kind: "repaint", tf: r.tf, known_at: r.known_at, ref: `${r.stored_hash}>${r.replay_hash}`, detail: r })),
    ...plan.checkpointMismatches.map((m) => ({ symbol, kind: "checkpoint_mismatch", tf: "-", known_at: m.known_at, ref: m.field, detail: m })),
    ...(stale.stale && stale.expected ? [{ symbol, kind: "stale", tf: "-", known_at: stale.expected, ref: stale.expected, detail: stale }] : []),
  ];
  if (!o.dryRun) {
    const put = async (table: string, list: unknown[], onConflict: string) => {
      for (let i = 0; i < list.length; i += 1000) {
        const { error } = await db.from(table).upsert(list.slice(i, i + 1000), { onConflict, ignoreDuplicates: true });
        if (error) throw new Error(`${table} ${symbol}: ${error.message}`);
      }
    };
    await put("structure_v3_snapshots", plan.inserts, "symbol,tf,known_at,engine_version");
    await put("structure_v3_checkpoints", plan.checkpointInserts, "symbol,known_at,engine_version");
    await put("structure_v3_audit", audit, "symbol,kind,tf,known_at,ref");
  }
  const last = (tf: "1H" | "4H") => { const s = computed.snapshots[tf].at(-1); return s ? { known_at: s.known_at, trend: s.trend, p: s.p_price, x: s.x_price } : null; };
  return { symbol, ok: plan.repaints.length === 0 && plan.checkpointMismatches.length === 0, counts: { ...plan.counts, bars_1h: hours.length, ...(stale.stale ? { stale: 1 } : {}) },
    stale, latest1H: last("1H"), latest4H: last("4H"), repaints: plan.repaints.length, checkpointMismatches: plan.checkpointMismatches.length, dryRun: !!o.dryRun, plan };
}
