/**
 * Historical date-range candles for IPO research. SHADOW/RESEARCH ONLY.
 *
 * WHY THIS EXISTS. fetchCandlesWithFallback asks for the last N bars ending
 * now, and TwelveData caps N at 5,000. On 4H that window opens in mid-2024, so
 * a demonstrated IPO from May 2020 is roughly 14,000 bars before the data
 * starts. Coverage reported those examples ABSENT — a detector miss recorded
 * where the detector was never shown the bars. A measurement that cannot
 * distinguish "not found" from "not looked at" is worse than no measurement.
 *
 * The pagination pattern is the one already proven in backtest-engine's
 * fetchTwelveDataRange: start_date/end_date, outputsize=5000, order=ASC, walk
 * forward from the last bar of each page.
 *
 * ONE DELIBERATE DIFFERENCE FROM THAT PATTERN: this requests timezone=UTC.
 *
 * The backtest range fetcher omits it and then appends "Z" to whatever comes
 * back. TwelveData defaults to the EXCHANGE timezone, so that stamps a UTC that
 * was never requested — the exact bug fixed in candleSource on 2026-09-08,
 * where a GBP/JPY 5m bar arrived dated 9h54m in the future. For this work an
 * hour of drift is not cosmetic: the corpus pins 4H IPOs at 16:00, and an
 * offset would either miss the bar or silently match the wrong one. The
 * backtest path is NOT changed here; it is production and out of scope.
 *
 * Nothing in production imports this, and a test enforces that.
 */

import { TWELVE_DATA_SYMBOLS, twelveDataInterval, INTERVAL_MINUTES } from "./candleSource.ts";
import type { Candle } from "./smcAnalysis.ts";

export interface HistoricalRangeRequest {
  symbol: string;
  interval: string;
  /** Inclusive ISO date of the first bar of INTEREST (not of the fetch). */
  startDate: string;
  endDate: string;
  /**
   * Bars fetched BEFORE startDate so the detector has history.
   *
   * A zone needs prior bars for ATR(14), for confirmed swings, and for the
   * structure ledger that decides whether its break exists at all. Fetching
   * exactly the window of interest would make every zone near its left edge
   * look different from the same zone measured on a longer series — the input
   * would change, not the view of it.
   */
  lookbackBars?: number;
  /**
   * Bars fetched AFTER endDate. Confirmation, tests and invalidation all happen
   * after the IPO candle, so a window that stops at the zone reports a
   * lifecycle that simply ran out of chart.
   */
  lookaheadBars?: number;
  maxPages?: number;
}

export interface HistoricalRangeResult {
  candles: Candle[];
  source: "twelvedata_range" | "none";
  pages: number;
  /** What the caller asked to look at. */
  requestedWindow: { startDate: string; endDate: string };
  /** What was actually fetched, buffers included. */
  fetchedWindow: { startDate: string; endDate: string };
  /** First and last bar actually returned, or null when empty. */
  coverage: { first: string | null; last: string | null; bars: number };
  /** True when the provider's history begins after the requested start. */
  truncatedAtStart: boolean;
  notes: string[];
}

const DAY_MS = 86_400_000;

const shiftDays = (iso: string, days: number): string =>
  new Date(new Date(`${iso.slice(0, 10)}T00:00:00Z`).getTime() + days * DAY_MS)
    .toISOString().slice(0, 10);

/**
 * Calendar days needed to contain `bars` bars of this interval.
 *
 * Deliberately generous: FX closes at weekends and crypto does not, so a bar
 * count converts to wall-clock differently per instrument. Over-fetching costs
 * one paged request; under-fetching silently shortens the history the detector
 * sees, which is the failure this whole module exists to remove.
 */
export function barsToDays(interval: string, bars: number): number {
  const mins = INTERVAL_MINUTES[interval] ?? 240;
  const rawDays = (bars * mins) / 1440;
  return Math.max(2, Math.ceil(rawDays * 1.6) + 2);
}

/** One paged TwelveData range fetch. Returns [] on any provider failure. */
async function twelveDataRange(
  symbol: string, interval: string, startDate: string, endDate: string, maxPages: number,
): Promise<{ candles: Candle[]; pages: number; notes: string[] }> {
  const notes: string[] = [];
  const apiKey = Deno.env.get("TWELVE_DATA_API_KEY");
  if (!apiKey) return { candles: [], pages: 0, notes: ["TWELVE_DATA_API_KEY not set"] };
  const tdSymbol = TWELVE_DATA_SYMBOLS[symbol];
  if (!tdSymbol) return { candles: [], pages: 0, notes: [`no TwelveData symbol for ${symbol}`] };
  const tdInterval = twelveDataInterval(interval);

  const out: Candle[] = [];
  const seen = new Set<string>();
  let currentStart = startDate;
  let pages = 0;

  for (let page = 0; page < maxPages; page++) {
    const url = "https://api.twelvedata.com/time_series" +
      `?symbol=${encodeURIComponent(tdSymbol)}` +
      `&interval=${tdInterval}` +
      `&start_date=${encodeURIComponent(currentStart)}` +
      `&end_date=${encodeURIComponent(endDate)}` +
      `&outputsize=5000&order=ASC&timezone=UTC` +
      `&apikey=${apiKey}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch (e) {
      notes.push(`fetch error on page ${page + 1}: ${(e as Error)?.message}`);
      break;
    }
    if (res.status === 429) {
      notes.push(`rate limited on page ${page + 1}, waiting 10s`);
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }
    if (!res.ok) { notes.push(`HTTP ${res.status} on page ${page + 1}`); break; }
    const data = await res.json().catch(() => null);
    if (!data || data.status === "error" || !Array.isArray(data.values)) {
      if (data?.message) notes.push(`provider: ${data.message}`);
      break;
    }
    pages++;
    const chunk: Candle[] = data.values.map((v: any) => ({
      // timezone=UTC was requested, so appending Z states what was asked for
      // rather than asserting it — see the header note.
      datetime: typeof v.datetime === "string" && v.datetime.length === 10
        ? `${v.datetime}T00:00:00Z`
        : `${String(v.datetime).replace(" ", "T")}Z`,
      open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close),
      volume: v.volume != null ? Number(v.volume) : undefined,
    })).filter((c: Candle) =>
      Number.isFinite(c.open) && Number.isFinite(c.high) &&
      Number.isFinite(c.low) && Number.isFinite(c.close));

    if (!chunk.length) break;
    // Pages overlap by one bar because the next request starts AT the last bar
    // returned. Deduplicating by datetime keeps the series strictly increasing;
    // without it the duplicate becomes a zero-range bar in every ATR window
    // that spans a page boundary.
    let added = 0;
    for (const c of chunk) {
      if (seen.has(c.datetime)) continue;
      seen.add(c.datetime);
      out.push(c);
      added++;
    }
    if (chunk.length < 5000 || added === 0) break;
    currentStart = chunk[chunk.length - 1].datetime;
    await new Promise((r) => setTimeout(r, 1000));
  }

  out.sort((a, b) => (a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : 0));
  return { candles: out, pages, notes };
}

/**
 * Candles covering a historical window, with buffers, for research actions.
 *
 * The returned series is the BUFFERED window: callers run detection on all of
 * it and narrow the view separately, exactly as buildIPOInventory's from/to
 * already does. Trimming the input instead would change the zones rather than
 * the view of them.
 */
export async function fetchHistoricalRangeCandles(
  req: HistoricalRangeRequest,
): Promise<HistoricalRangeResult> {
  const lookbackBars = req.lookbackBars ?? 300;
  const lookaheadBars = req.lookaheadBars ?? 120;
  const fetchStart = shiftDays(req.startDate, -barsToDays(req.interval, lookbackBars));
  const fetchEnd = shiftDays(req.endDate, barsToDays(req.interval, lookaheadBars));

  const { candles, pages, notes } = await twelveDataRange(
    req.symbol, req.interval, fetchStart, fetchEnd, req.maxPages ?? 20,
  );

  const first = candles.length ? candles[0].datetime : null;
  const last = candles.length ? candles[candles.length - 1].datetime : null;
  // The provider's own history may begin after our buffered start. Say so:
  // otherwise a short series reads as a quiet market rather than a data limit.
  const truncatedAtStart = first !== null && first.slice(0, 10) > fetchStart;
  if (truncatedAtStart) {
    notes.push(
      `provider history begins ${first!.slice(0, 10)}, after the buffered start ${fetchStart} — ` +
      "zones near the left edge saw less history than a longer series would give them",
    );
  }
  return {
    candles,
    source: candles.length ? "twelvedata_range" : "none",
    pages,
    requestedWindow: { startDate: req.startDate.slice(0, 10), endDate: req.endDate.slice(0, 10) },
    fetchedWindow: { startDate: fetchStart, endDate: fetchEnd },
    coverage: { first, last, bars: candles.length },
    truncatedAtStart,
    notes,
  };
}
