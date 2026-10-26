// Live writer for canonical 5m bars (Impulse-on-V3 shadow, owner decision 2026-10-26 option A), called by bot-scanner with the 5m
// entry candles it ALREADY fetched. Zero additional provider calls. DEFAULT OFF. Mirrors structureBarsWriter.ts (the 1H writer):
//   - reads only its arguments; never mutates the candles; returns telemetry that no gate, score, entry or decision reads;
//   - persistence is AWAITED and BOUNDED (AbortSignal timeout); any failure is reported in the telemetry and never thrown;
//   - batched: at most 3 database operations per pair per scan (read existing by range, insert new, revisions).
// Pre-settlement observations are the expected majority each scan and are only counted, not logged (no rejections table).
import type { Candle } from "../smcAnalysis.ts";
import { candleTimeMs, planWrites, valueHash, type Evaluation } from "./canonicalBars.ts";
import { evaluateObservation5m } from "./canonicalBars5m.ts";
import { OBSERVATION_SLACK_MS, type WriterTelemetry } from "./structureBarsWriter.ts";

export const LIVE_WRITE_5M_ENV = "STRUCTURE_BARS_5M_LIVE_WRITE"; // "on" enables; anything else (default) = off
/** 24 h of 5m bars: a pair whose scans were skipped (session gate, refused fetch) is filled in by its next scan. */
export const LIVE_LOOKBACK_BARS_5M = 288;
export const WRITE_TIMEOUT_MS_5M = 2_500;

export type LiveWriter5mConfig = { enabled: false; reason: string } | { enabled: true };
export function liveWriter5mConfig(get: (k: string) => string | undefined = (k) => Deno.env.get(k)): LiveWriter5mConfig {
  return (get(LIVE_WRITE_5M_ENV) ?? "off") === "on" ? { enabled: true } : { enabled: false, reason: "flag off" };
}

// deno-lint-ignore no-explicit-any
type Client = { from: (table: string) => any };

export async function writeLiveStructureBars5m(
  client: Client, symbol: string, candles: readonly Candle[],
  o: { cfg: LiveWriter5mConfig; fetchStartedAtMs: number; timeoutMs?: number; lookbackBars?: number },
): Promise<WriterTelemetry> {
  if (!o.cfg.enabled) return { ok: true, skipped: o.cfg.reason, counts: {}, dbOps: 0 };
  const ctl = new AbortController(), tel: WriterTelemetry = { ok: false, counts: {}, dbOps: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async () => {
    const observedAt = o.fetchStartedAtMs - OBSERVATION_SLACK_MS; // a cached candle can never look more settled than it was
    const evals: Evaluation[] = candles.slice(-(o.lookbackBars ?? LIVE_LOOKBACK_BARS_5M)).map((c) =>
      evaluateObservation5m({ symbol, barTime: candleTimeMs(c.datetime), o: c.open, h: c.high, l: c.low, c: c.close, observedAt, provider: null }));
    const keys = evals.flatMap((e) => (e.kind === "candidate" ? [e.row.bar_time] : [])).sort();
    const existing = new Map<string, { hash: string; open: number; high: number; low: number; close: number }>();
    if (keys.length) {
      tel.dbOps++;
      const { data, error } = await client.from("structure_bars_5m").select("bar_time,open,high,low,close").eq("symbol", symbol)
        .gte("bar_time", keys[0]).lte("bar_time", keys[keys.length - 1]).limit(1000).abortSignal(ctl.signal);
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
    await put("structure_bars_5m", plan.inserts, "symbol,bar_time");
    await put("structure_bar_5m_revisions", plan.revisions, "symbol,bar_time,value_hash,source");
    tel.ok = true;
    return tel;
  })();
  const timeout = new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), o.timeoutMs ?? WRITE_TIMEOUT_MS_5M); });
  try {
    const r = await Promise.race([work, timeout]);
    if (r === "timeout") {
      ctl.abort();
      await work.catch(() => undefined);
      return { ...tel, ok: false, timedOut: true, error: "timeout" };
    }
    return r;
  } catch (e) {
    return { ...tel, ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
