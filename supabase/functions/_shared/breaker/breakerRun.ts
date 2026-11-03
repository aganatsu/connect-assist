// Breaker shadow runner: for every account with Bot Config → "Breaker Shadow" on (config_json.strategy.breakerShadowEnabled),
// registers the Unified zones its scans showed (scan_logs.details_json[].unifiedZone) and advances breakerEngine on the canonical 5m
// bars (structure_bars_5m). Called by supabase/functions/breaker-shadow (cron). Writes only breaker_shadow_events / _state.
// No order, position, account, ledger or provider call.
import { IOV3_PAIRS } from "../iov3/shadowEngine.ts";
import { resolveShadowParams } from "../iov3/params.ts";
import { canonical5m } from "../iov3/canonical5m.ts";
import { addZones, advanceBars, BREAKER_ENGINE_VERSION, initBreakerState, zoneId, type BreakerEvent, type BreakerParams, type BreakerState, type SeenZone } from "./breakerEngine.ts";

// deno-lint-ignore no-explicit-any
type Client = { from: (table: string) => any };
const iso = (t: number) => new Date(t).toISOString();
const M5 = 300_000;
/** A state older than this means the switch was off (or the runner down): start fresh instead of replaying the gap. */
export const PAUSE_AFTER_MS = 6 * 3_600_000;
/** At most this many scans are read per run; a longer backlog continues on the next run. */
export const MAX_SCANS_PER_RUN = 24;

export const breakerEnabled = (cfg: unknown) => ((cfg as Record<string, any> | null)?.strategy?.breakerShadowEnabled) === true;

/** The Unified zones one scan's details showed, per pair. */
export function zonesFromScan(details: unknown, scanT: number, pipOf: (pair: string) => number | null): SeenZone[] {
  const out: SeenZone[] = [];
  for (const d of Array.isArray(details) ? details : []) {
    const u = (d as any)?.unifiedZone, pair = (d as any)?.pair, pip = typeof pair === "string" ? pipOf(pair) : null;
    if (!u?.hasZone || !pip || !u.zone || !u.impulse) continue;
    const zl = Number(u.zone.low), zh = Number(u.zone.high);
    const dir = u.impulse.direction === "bullish" ? "long" : u.impulse.direction === "bearish" ? "short" : null;
    if (!dir || !(zh > zl)) continue;
    // intact: the scan's price was on the zone's side or inside it (a zone price has already closed through is not a fresh break)
    const price = Number(u.price?.currentPrice);
    const intact = Number.isFinite(price) && (dir === "long" ? price >= zl : price <= zh);
    out.push({ id: zoneId(pair, dir, zl, zh, pip), dir, zoneType: String(u.zone.type ?? ""), zl, zh, seenT: scanT, tf: u.selectedTF ?? null, intact });
  }
  return out;
}

export function eventRow(userId: string, pair: string, e: BreakerEvent) {
  return { user_id: userId, pair, zone_id: e.zoneId, arm: "arm" in e && e.arm ? e.arm : "-", type: e.type, t: iso(e.t), payload: e };
}

async function pages<T>(q: (from: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, what: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from);
    if (error) throw new Error(`${what}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

export interface BreakerRunResult { user: string; pair: string; skipped?: string; events: number; asOf?: string; zones?: number; open?: string[] }

export async function runBreakerShadow(db: Client, nowMs: number): Promise<BreakerRunResult[]> {
  const { data: cfgs, error } = await db.from("bot_configs").select("user_id,config_json").is("connection_id", null);
  if (error) throw new Error(`bot_configs: ${error.message}`);
  const out: BreakerRunResult[] = [];
  for (const row of (cfgs ?? []) as { user_id: string; config_json: unknown }[]) {
    if (!breakerEnabled(row.config_json)) continue;
    const userId = row.user_id;
    const params = new Map<string, BreakerParams>();
    for (const pair of IOV3_PAIRS) {
      const r = resolveShadowParams(row.config_json, pair);
      if (r.ok) params.set(pair, { pair, pip: r.params.pip, costPips: r.params.costPips, minSlPips: r.params.minSlPips });
      else out.push({ user: userId.slice(0, 8), pair, skipped: r.reason, events: 0 });
    }
    // latest state per pair (fresh start when missing or stale)
    const states = new Map<string, { seq: number; state: BreakerState; lastScanAt: number; asOf: number; fresh: boolean; stale: BreakerState | null }>();
    for (const pair of params.keys()) {
      const { data: s, error: se } = await db.from("breaker_shadow_state").select("seq,as_of,last_scan_at,state").eq("user_id", userId).eq("pair", pair).order("seq", { ascending: false }).limit(1);
      if (se) throw new Error(`state: ${se.message}`);
      const cur = s?.[0];
      if (cur && Date.parse(cur.as_of) >= nowMs - PAUSE_AFTER_MS) states.set(pair, { seq: cur.seq, state: cur.state, lastScanAt: Date.parse(cur.last_scan_at), asOf: Date.parse(cur.as_of), fresh: false, stale: null });
      else {
        const start = Math.floor((nowMs - 30 * 60_000) / M5) * M5;
        states.set(pair, { seq: cur?.seq ?? 0, state: initBreakerState(start), lastScanAt: start, asOf: start, fresh: true, stale: cur ? cur.state : null });
      }
    }
    if (!states.size) continue;
    // scans since the earliest pair's last processed scan, oldest first, capped
    const since = Math.min(...[...states.values()].map((x) => x.lastScanAt));
    const { data: scans, error: sce } = await db.from("scan_logs").select("created_at,details_json").eq("user_id", userId)
      .gt("created_at", iso(since)).lte("created_at", iso(nowMs)).order("created_at", { ascending: true }).limit(MAX_SCANS_PER_RUN);
    if (sce) throw new Error(`scan_logs: ${sce.message}`);
    const scanRows = (scans ?? []) as { created_at: string; details_json: unknown }[];
    const lastScanT = scanRows.length ? Date.parse(scanRows[scanRows.length - 1].created_at) : null;
    for (const [pair, p] of params) {
      const s = states.get(pair)!;
      const events: BreakerEvent[] = [];
      if (s.fresh && s.stale) {
        // the switch was off: whatever the old state still held is closed out as paused, at its last processed bar
        const t = s.stale.last5mT + M5;
        for (const z of s.stale.zones) for (const arm of ["C", "L"] as const) if (z.status === "flipped" && z.arms[arm].status !== "done") events.push({ type: "cancelled", t, zoneId: z.id, arm, reason: "paused" });
        for (const arm of ["C", "L"] as const) { const pos = s.stale.pos[arm]; if (pos) events.push({ type: "cancelled", t, zoneId: pos.zoneId, arm, reason: "paused" }); }
      }
      const seen = scanRows.filter((r) => Date.parse(r.created_at) > s.lastScanAt)
        .flatMap((r) => zonesFromScan(r.details_json, Date.parse(r.created_at), (x) => (x === pair ? p.pip : null)));
      const a = addZones(s.state, seen, nowMs); events.push(...a.events);
      type B5 = { bar_time: string; open: number; high: number; low: number; close: number; observed_at: string };
      const fromMs = a.state.last5mT;
      const rows = await pages<B5>((f) => db.from("structure_bars_5m").select("bar_time,open,high,low,close,observed_at").eq("symbol", pair)
        .gte("bar_time", iso(fromMs - 3 * 86_400_000)).lte("bar_time", iso(nowMs)).order("bar_time").range(f, f + 999), `5m ${pair}`);
      const m5 = canonical5m(rows, nowMs, fromMs);
      const until = Math.min(nowMs - 60_000, m5.processUntil);
      const r = advanceBars(a.state, m5.bars, p, until); events.push(...r.events);
      const newLastScan = lastScanT !== null && lastScanT > s.lastScanAt ? lastScanT : s.lastScanAt;
      const asOf = Math.max(until, r.state.last5mT + M5);
      // also written hourly when nothing happened (weekends), so a quiet market is never mistaken for the switch being off
      const changed = s.fresh || events.length > 0 || JSON.stringify(r.state) !== JSON.stringify(s.state) || newLastScan !== s.lastScanAt || asOf - s.asOf >= 3_600_000;
      if (events.length) {
        const rowsE = events.map((e) => eventRow(userId, pair, e));
        for (let i = 0; i < rowsE.length; i += 500) {
          const { error: ee } = await db.from("breaker_shadow_events").upsert(rowsE.slice(i, i + 500), { onConflict: "user_id,zone_id,arm,type,t", ignoreDuplicates: true });
          if (ee) throw new Error(`breaker_shadow_events ${pair}: ${ee.message}`);
        }
      }
      if (changed) {
        // a concurrent run that already wrote seq+1 wins; the event rows above are deterministic, so its duplicates were ignored
        const { error: we } = await db.from("breaker_shadow_state").upsert([{ user_id: userId, pair, seq: s.seq + 1, as_of: iso(asOf), last_scan_at: iso(newLastScan),
          engine_version: BREAKER_ENGINE_VERSION, state: r.state }], { onConflict: "user_id,pair,seq", ignoreDuplicates: true });
        if (we) throw new Error(`breaker_shadow_state ${pair}: ${we.message}`);
      }
      out.push({ user: userId.slice(0, 8), pair, events: events.length, asOf: iso(r.state.last5mT + M5), zones: r.state.zones.length,
        open: (["C", "L"] as const).filter((arm) => r.state.pos[arm]).map((arm) => `${arm}:${r.state.pos[arm]!.zoneId}`) });
    }
  }
  return out;
}
