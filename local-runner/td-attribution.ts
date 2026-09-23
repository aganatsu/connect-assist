/**
 * PART A — retrospective provider attribution against Twelve Data.
 *
 * RESEARCH ONLY. Reads the persisted engine bars and Twelve Data's own history,
 * compares them field by field, and classifies how strongly each stored bar can
 * be attributed to Twelve Data. Writes one local JSON. No database, no strategy
 * code, no deployment.
 *
 * WHY THIS IS EVIDENCE AND NOT INFERENCE. The production fetch was a MetaAPI →
 * Twelve Data → Polygon fallback chain and the runner discarded which one
 * answered. But a tape that reproduces a stored bar's four numbers exactly is
 * the tape that produced it — barring a coincidence across O, H, L and C
 * simultaneously, on many bars. So attribution is recoverable after the fact,
 * and this measures it rather than assuming it.
 *
 * ABSENCE OF A MATCH RULES DOWN TWELVE DATA ONLY. MetaAPI is also in the chain
 * and no Polygon credential is held, so a mismatch does NOT identify the
 * alternative. Those bars stay NOT_TWELVE_ATTRIBUTED, never "therefore Polygon".
 *
 * THE KEY IS READ FROM THE ENVIRONMENT AND NEVER PRINTED, LOGGED OR STORED.
 * Nothing this script writes contains it.
 */

import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";

const KEY = Deno.env.get("TWELVE_DATA_API_KEY");
if (!KEY) {
  console.error("TWELVE_DATA_API_KEY is not set. Refusing to run rather than embedding a key.");
  Deno.exit(1);
}

/**
 * Attribution classes, tightest first.
 *
 * EXACT is the only class that proves source identity. It allows ONLY
 * serialization differences — Twelve Data returns numbers as strings, so
 * "85940.32" and 85940.32 are the same number and `Number()` makes them equal.
 * No tolerance is applied to the VALUE.
 *
 * NORMALIZED allows rounding at the instrument's own quote precision, for the
 * case where one side carries a float artefact (…3200000000004). Reported
 * separately from EXACT and never merged into it.
 *
 * CLOSE_BUT_NOT_PROVEN is a warning, not an attribution: two venues quoting the
 * same liquid market agree closely, so "small" says nothing about identity.
 */
export type Attribution =
  | "TWELVE_EXACT_MATCH" | "TWELVE_NORMALIZED_MATCH"
  | "TWELVE_CLOSE_MATCH_BUT_NOT_PROVEN" | "TWELVE_MISMATCH"
  | "TWELVE_NO_DATA" | "TWELVE_API_ERROR";

/** Quote precision per instrument, for the NORMALIZED class only. */
const DP: Record<string, number> = { "EUR/USD": 5, "USD/JPY": 3, "BTC/USD": 2 };
/** Above this max-field divergence a bar is a mismatch, not merely "close". */
const CLOSE_LIMIT = 0.0005;   // 0.05%

interface FieldCmp { stored: number; twelve: number; abs: number; pct: number }
interface Row {
  instrument: string; timeframe: string; barTime: string;
  attribution: Attribution;
  o?: FieldCmp; h?: FieldCmp; l?: FieldCmp; c?: FieldCmp;
  maxFieldPct?: number;
  timestampAgrees: boolean;
  note?: string;
}

let httpRequests = 0, apiErrors = 0, rateLimited = 0;

async function tdSeries(symbol: string, interval: string, start: string, end: string) {
  const u = new URL("https://api.twelvedata.com/time_series");
  u.searchParams.set("symbol", symbol);
  u.searchParams.set("interval", interval);
  u.searchParams.set("outputsize", "5000");
  u.searchParams.set("order", "ASC");
  u.searchParams.set("timezone", "UTC");
  u.searchParams.set("start_date", start);
  u.searchParams.set("end_date", end);
  u.searchParams.set("apikey", KEY!);
  httpRequests++;
  const res = await fetch(u);
  const body = await res.json();
  if (body?.status === "error") {
    apiErrors++;
    if (String(body?.code) === "429") rateLimited++;
    // The message can echo request context; the key is never in it, but the URL
    // is never logged either, so nothing can leak by accident.
    throw new Error(`twelvedata ${body?.code}: ${String(body?.message).slice(0, 120)}`);
  }
  return (body?.values ?? []) as Array<Record<string, string>>;
}

/** "2026-09-23 14:00:00" → "2026-09-23T14:00:00Z", the stored form. */
const iso = (d: string) => `${d.replace(" ", "T")}Z`;

const rows: Row[] = [];

for (const inst of IPO_INSTRUMENTS) {
  const file = `/tmp/state_${inst.instrument.replace("/", "_")}.json`;
  let stored: { t: string[]; o: number[]; h: number[]; l: number[]; c: number[] };
  try {
    stored = JSON.parse(JSON.parse(await Deno.readTextFile(file))[0].value).bars;
  } catch { console.log(`skip ${inst.instrument}: no local state dump`); continue; }

  const tdInterval = inst.timeframe === "30min" ? "30min" : "1h";
  const first = stored.t[0].replace("T", " ").replace("Z", "");
  const last = stored.t[stored.t.length - 1].replace("T", " ").replace("Z", "");

  let values: Array<Record<string, string>> = [];
  try { values = await tdSeries(inst.instrument, tdInterval, first, last); }
  catch (e) {
    console.log(`${inst.instrument}: API error — ${(e as Error).message}`);
    rows.push({ instrument: inst.instrument, timeframe: inst.timeframe, barTime: "*",
                attribution: "TWELVE_API_ERROR", timestampAgrees: false,
                note: (e as Error).message });
    continue;
  }

  const byTime = new Map(values.map((v) => [iso(v.datetime), v]));
  const dp = DP[inst.instrument] ?? 5;

  for (let i = 0; i < stored.t.length; i++) {
    const bt = stored.t[i];
    const v = byTime.get(bt);
    if (!v) {
      rows.push({ instrument: inst.instrument, timeframe: inst.timeframe, barTime: bt,
                  attribution: "TWELVE_NO_DATA", timestampAgrees: false });
      continue;
    }
    const cmp = (s: number, t: number): FieldCmp =>
      ({ stored: s, twelve: t, abs: Math.abs(s - t), pct: s === 0 ? 0 : Math.abs(s - t) / Math.abs(s) });

    const o = cmp(stored.o[i], Number(v.open));
    const h = cmp(stored.h[i], Number(v.high));
    const l = cmp(stored.l[i], Number(v.low));
    const c = cmp(stored.c[i], Number(v.close));
    const maxFieldPct = Math.max(o.pct, h.pct, l.pct, c.pct);

    const exact = [o, h, l, c].every((f) => f.stored === f.twelve);
    const normalized = !exact && [o, h, l, c].every(
      (f) => f.stored.toFixed(dp) === f.twelve.toFixed(dp));

    const attribution: Attribution =
      exact ? "TWELVE_EXACT_MATCH"
      : normalized ? "TWELVE_NORMALIZED_MATCH"
      : maxFieldPct <= CLOSE_LIMIT ? "TWELVE_CLOSE_MATCH_BUT_NOT_PROVEN"
      : "TWELVE_MISMATCH";

    rows.push({ instrument: inst.instrument, timeframe: inst.timeframe, barTime: bt,
                attribution, o, h, l, c, maxFieldPct, timestampAgrees: true });
  }
  console.log(`${inst.instrument} ${tdInterval}: stored ${stored.t.length} bars, twelve returned ${values.length}`);
  await new Promise((s) => setTimeout(s, 9000));   // free-tier courtesy
}

// ── report ───────────────────────────────────────────────────────────────────

const CLASSES: Attribution[] = ["TWELVE_EXACT_MATCH", "TWELVE_NORMALIZED_MATCH",
  "TWELVE_CLOSE_MATCH_BUT_NOT_PROVEN", "TWELVE_MISMATCH", "TWELVE_NO_DATA", "TWELVE_API_ERROR"];

console.log(`\n${"=".repeat(104)}\nTWELVE DATA ATTRIBUTION — all stored bars\n${"=".repeat(104)}`);
console.log("instrument".padEnd(12) + CLASSES.map((c) => c.replace("TWELVE_", "").padStart(15)).join(""));
for (const inst of [...new Set(rows.map((r) => r.instrument))].concat(["PORTFOLIO"])) {
  const set = inst === "PORTFOLIO" ? rows : rows.filter((r) => r.instrument === inst);
  console.log(inst.padEnd(12) +
    CLASSES.map((c) => String(set.filter((r) => r.attribution === c).length).padStart(15)).join(""));
}

console.log(`\nfield divergence on non-exact bars, by instrument:`);
for (const inst of [...new Set(rows.map((r) => r.instrument))]) {
  const ds = rows.filter((r) => r.instrument === inst && r.maxFieldPct !== undefined
                               && r.attribution !== "TWELVE_EXACT_MATCH")
                 .map((r) => r.maxFieldPct!).sort((a, b) => a - b);
  if (!ds.length) { console.log(`  ${inst}: every comparable bar is an EXACT match`); continue; }
  const p = (x: number) => `${(x * 100).toFixed(4)}%`;
  console.log(`  ${inst}: n=${ds.length} min=${p(ds[0])} median=${p(ds[ds.length >> 1])} max=${p(ds[ds.length - 1])}`);
}

console.log(`\nAPI: ${httpRequests} requests, ${apiErrors} errors, ${rateLimited} rate-limited.`);
await Deno.writeTextFile("/tmp/td-attribution.json", JSON.stringify(rows, null, 1));
console.log(`wrote ${rows.length} bar comparisons to /tmp/td-attribution.json (no credential in file)`);
