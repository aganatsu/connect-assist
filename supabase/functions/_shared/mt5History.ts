import type { Candle } from "./smcAnalysis.ts";

export const MT5_HISTORY_VERSION = "mt5-history.v1";
export type MT5HistoryInterval = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" | "1w";

function normalizeHeader(value: string): string {
  return value.trim().replace(/^<|>$/g, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}
function split(line: string, delimiter: string): string[] {
  return line.split(delimiter).map((value) => value.trim().replace(/^"|"$/g, ""));
}
function utcTimestamp(date: string, time = "00:00:00", timezoneOffsetMinutes = 0): string | null {
  const cleanDate = date.trim().replace(/[./]/g, "-");
  const match = cleanDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  const cleanTime = time.trim() || "00:00:00";
  const value = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}T${cleanTime.length === 5 ? cleanTime + ":00" : cleanTime}Z`;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms - timezoneOffsetMinutes * 60_000).toISOString() : null;
}

export interface MT5ParseResult {
  candles: Candle[];
  rejectedRows: number;
  duplicateRows: number;
  delimiter: "tab" | "comma" | "semicolon";
}

export function parseMT5History(text: string, timezoneOffsetMinutes = 0): MT5ParseResult {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("History file has no candle rows");
  const delimiter = lines[0].includes("\t") ? "\t" : lines[0].includes(";") ? ";" : ",";
  const headers = split(lines[0], delimiter).map(normalizeHeader);
  const index = (names: string[]) => headers.findIndex((header) => names.includes(header));
  const dateIndex = index(["date"]), timeIndex = index(["time"]), datetimeIndex = index(["datetime"]);
  const openIndex = index(["open"]), highIndex = index(["high"]), lowIndex = index(["low"]), closeIndex = index(["close"]);
  const volumeIndex = index(["tickvol", "tickvolume", "vol", "volume", "realvol"]);
  if ((dateIndex < 0 && datetimeIndex < 0) || [openIndex, highIndex, lowIndex, closeIndex].some((value) => value < 0)) {
    throw new Error("Expected MT4/MT5 columns: DATE, TIME, OPEN, HIGH, LOW, CLOSE");
  }
  let rejectedRows = 0, duplicateRows = 0;
  const byTime = new Map<string, Candle>();
  for (const line of lines.slice(1)) {
    const values = split(line, delimiter);
    const rawDateTime = datetimeIndex >= 0 ? values[datetimeIndex] : values[dateIndex];
    const parts = rawDateTime?.trim().split(/[ T]/) || [];
    const datetime = datetimeIndex >= 0
      ? utcTimestamp(parts[0] || "", parts[1] || "00:00:00", timezoneOffsetMinutes)
      : utcTimestamp(rawDateTime || "", timeIndex >= 0 ? values[timeIndex] : "00:00:00", timezoneOffsetMinutes);
    const open = Number(values[openIndex]), high = Number(values[highIndex]);
    const low = Number(values[lowIndex]), close = Number(values[closeIndex]);
    if (!datetime || ![open, high, low, close].every(Number.isFinite) || high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
      rejectedRows++; continue;
    }
    const candle: Candle = { datetime, open, high, low, close };
    const volume = volumeIndex >= 0 ? Number(values[volumeIndex]) : NaN;
    if (Number.isFinite(volume)) candle.volume = volume;
    if (byTime.has(datetime)) duplicateRows++;
    byTime.set(datetime, candle);
  }
  const candles = [...byTime.values()].sort((a, b) => a.datetime.localeCompare(b.datetime));
  if (candles.length < 30) throw new Error(`Only ${candles.length} valid candles found; at least 30 are required`);
  const deltas = candles.slice(1, 1001)
    .map((candle, index) => Date.parse(candle.datetime) - Date.parse(candles[index].datetime))
    .filter((delta) => delta > 0 && delta < 6 * 60 * 60 * 1000)
    .sort((a, b) => a - b);
  const medianDelta = deltas[Math.floor(deltas.length / 2)] || Infinity;
  if (medianDelta > 90_000) {
    throw new Error("Import the MT5 M1 history export; this file appears to use a higher timeframe");
  }
  return { candles, rejectedRows, duplicateRows, delimiter: delimiter === "\t" ? "tab" : delimiter === ";" ? "semicolon" : "comma" };
}

const INTERVAL_MS: Record<MT5HistoryInterval, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000, "1w": 604_800_000,
};
export function aggregateMT5Candles(candles: Candle[], interval: MT5HistoryInterval): Candle[] {
  if (interval === "1m") return candles;
  const size = INTERVAL_MS[interval];
  const buckets = new Map<number, Candle>();
  for (const candle of candles) {
    const ms = Date.parse(candle.datetime);
    if (!Number.isFinite(ms)) continue;
    const weekOffset = interval === "1w" ? 4 * 86_400_000 : 0; // UTC Monday buckets.
    const bucket = Math.floor((ms - weekOffset) / size) * size + weekOffset;
    const current = buckets.get(bucket);
    if (!current) buckets.set(bucket, { ...candle, datetime: new Date(bucket).toISOString() });
    else {
      current.high = Math.max(current.high, candle.high); current.low = Math.min(current.low, candle.low);
      current.close = candle.close; current.volume = (current.volume || 0) + (candle.volume || 0);
    }
  }
  return [...buckets.values()].sort((a, b) => a.datetime.localeCompare(b.datetime));
}
