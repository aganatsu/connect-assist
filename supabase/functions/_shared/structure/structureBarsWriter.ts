// Live writer for canonical 1H structure bars, called by bot-scanner with the 1H candles it ALREADY fetched.
// Zero additional provider calls. DEFAULT OFF.
//
// Isolation contract (Q3, 2026-10-15):
//   - reads only its arguments; never mutates the candles; returns telemetry that no gate, score, entry or decision reads;
//   - persistence is AWAITED and BOUNDED: a timeout aborts the in-flight queries (AbortSignal) and the function still
//     resolves; nothing is left running unawaited;
//   - any failure (error, throw, timeout, bad config) is reported in the returned telemetry and never thrown;
//   - batched: at most 4 database operations per pair per scan (read existing, insert new, revisions, rejections).
// Reserved window: the writer is enabled only with an explicit release time ≥ 2026-10-23 21:00Z and never writes a bar
// that opens before it. The span 2026-10-09 21:00Z → release is filled later from smc_scan_bars (D26).
import type { Candle } from "../smcAnalysis.ts";
import { candleTimeMs, evaluateObservation, MIN_LIVE_RELEASE_MS, planWrites, valueHash, type Evaluation } from "./canonicalBars.ts";

export const LIVE_WRITE_ENV = "STRUCTURE_BARS_LIVE_WRITE"; // "on" enables; anything else (default) = off
export const RELEASE_AT_ENV = "STRUCTURE_BARS_RELEASE_AT"; // ISO; required when on; ≥ MIN_LIVE_RELEASE_MS
/** candleSource keeps intraday candles up to 90 s (CACHE_TTL_INTRADAY_MS); +30 s margin. The observation time is taken
 *  as fetch start − slack, so a cached candle can never look more settled than it was. */
export const OBSERVATION_SLACK_MS = 120_000;
export const LIVE_LOOKBACK_BARS = 48;
export const WRITE_TIMEOUT_MS = 2_500;

export type LiveWriterConfig = { enabled: false; reason: string } | { enabled: true; releaseAtMs: number };

export function liveWriterConfig(get: (k: string) => string | undefined = (k) => Deno.env.get(k)): LiveWriterConfig {
  if ((get(LIVE_WRITE_ENV) ?? "off") !== "on") return { enabled: false, reason: "flag off" };
  const releaseAtMs = Date.parse(get(RELEASE_AT_ENV) ?? "");
  if (!Number.isFinite(releaseAtMs)) return { enabled: false, reason: `${RELEASE_AT_ENV} missing or invalid` };
  if (releaseAtMs < MIN_LIVE_RELEASE_MS) return { enabled: false, reason: `${RELEASE_AT_ENV} is before the reserved window closes` };
  return { enabled: true, releaseAtMs };
}

export interface WriterTelemetry { ok: boolean; skipped?: string; timedOut?: boolean; error?: string; counts: Record<string, number>; dbOps: number }

// The query-builder surface used (supabase-js, and the test harness's FakeDb).
// deno-lint-ignore no-explicit-any
type Client = { from: (table: string) => any };

export async function writeLiveStructureBars(
  client: Client, symbol: string, candles: readonly Candle[],
  o: { cfg: LiveWriterConfig; fetchStartedAtMs: number; timeoutMs?: number; lookbackBars?: number },
): Promise<WriterTelemetry> {
  if (!o.cfg.enabled) return { ok: true, skipped: o.cfg.reason, counts: {}, dbOps: 0 };
  const cfg = o.cfg, ctl = new AbortController(), tel: WriterTelemetry = { ok: false, counts: {}, dbOps: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async () => {
    const observedAt = o.fetchStartedAtMs - OBSERVATION_SLACK_MS;
    const span = { source: "scanner_live" as const, sourceRef: null, minBarTime: Math.max(cfg.releaseAtMs, MIN_LIVE_RELEASE_MS), maxBarTimeExclusive: Infinity };
    const evals: Evaluation[] = candles.slice(-(o.lookbackBars ?? LIVE_LOOKBACK_BARS)).map((c) =>
      evaluateObservation({ symbol, barTime: candleTimeMs(c.datetime), o: c.open, h: c.high, l: c.low, c: c.close, observedAt, provider: null }, span));
    const keys = evals.flatMap((e) => (e.kind === "candidate" ? [e.row.bar_time] : []));
    const existing = new Map<string, { hash: string; open: number; high: number; low: number; close: number }>();
    if (keys.length) {
      tel.dbOps++;
      const { data, error } = await client.from("structure_bars_1h").select("bar_time,open,high,low,close").eq("symbol", symbol).in("bar_time", keys).abortSignal(ctl.signal);
      if (error) throw new Error(`read: ${error.message}`);
      for (const r of data ?? []) {
        const v = { open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) };
        existing.set(new Date(r.bar_time).toISOString(), { ...v, hash: valueHash(symbol, v.open, v.high, v.low, v.close) });
      }
    }
    const plan = planWrites(evals, existing, "scanner_live");
    tel.counts = plan.counts;
    const put = async (table: string, rows: unknown[], onConflict: string) => {
      if (!rows.length) return;
      tel.dbOps++;
      const { error } = await client.from(table).upsert(rows, { onConflict, ignoreDuplicates: true }).abortSignal(ctl.signal);
      if (error) throw new Error(`${table}: ${error.message}`);
    };
    await put("structure_bars_1h", plan.inserts, "symbol,bar_time");
    await put("structure_bar_revisions", plan.revisions, "symbol,bar_time,value_hash,source");
    await put("structure_bar_rejections", plan.rejections, "symbol,bar_time,reason,value_hash,source");
    tel.ok = true;
    return tel;
  })();
  const timeout = new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), o.timeoutMs ?? WRITE_TIMEOUT_MS); });
  try {
    const r = await Promise.race([work, timeout]);
    if (r === "timeout") {
      ctl.abort();
      await work.catch(() => undefined); // aborted queries reject promptly; nothing is left running
      return { ...tel, ok: false, timedOut: true, error: "timeout" };
    }
    return r;
  } catch (e) {
    return { ...tel, ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
