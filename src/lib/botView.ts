/**
 * Bot View — what the SMC bot actually saw on its latest scan of a pair, shaped for
 * the chart. Everything here comes from the scan record (scan_logs.details_json) or
 * from the bot's own structure code; nothing is re-decided in the browser.
 */

export type Dir = "bullish" | "bearish";

export interface SwingLike { type: "high" | "low"; price: number; datetime: string; significance?: string }
export interface LabelledSwing extends SwingLike { label: "HH" | "HL" | "LH" | "LL" | "H" | "L"; major: boolean }

/**
 * Label swings the way a trader reads them: alternate high/low (keeping the more extreme
 * of two in a row, like the bot's confirmedTrend), then compare each high with the
 * previous high and each low with the previous low.
 */
export function labelSwings(swings: SwingLike[]): LabelledSwing[] {
  const sorted = [...swings].sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
  // Same instant reported as internal and external → keep one, external wins.
  const byKey = new Map<string, SwingLike>();
  for (const s of sorted) {
    const k = `${s.datetime}|${s.type}`;
    if (!byKey.has(k) || s.significance === "external") byKey.set(k, s);
  }
  const alt: SwingLike[] = [];
  for (const s of byKey.values()) {
    const last = alt[alt.length - 1];
    if (last && last.type === s.type) {
      const moreExtreme = s.type === "high" ? s.price > last.price : s.price < last.price;
      if (moreExtreme) alt[alt.length - 1] = s;
      continue;
    }
    alt.push(s);
  }
  let prevHigh: number | null = null, prevLow: number | null = null;
  return alt.map((s) => {
    let label: LabelledSwing["label"];
    if (s.type === "high") { label = prevHigh === null ? "H" : s.price > prevHigh ? "HH" : "LH"; prevHigh = s.price; }
    else { label = prevLow === null ? "L" : s.price > prevLow ? "HL" : "LL"; prevLow = s.price; }
    return { ...s, label, major: s.significance === "external" };
  });
}

export interface BotViewLevels { entry: number | null; sl: number | null; tp: number | null; source: "plan" | "none" }
export interface BotViewZone { low: number; high: number; label: string; score: number | null }
export interface BotViewImpulse { direction: Dir; fromPrice: number; toPrice: number; fromTime: string | null; toTime: string | null; tf: string | null }
export interface BotDecision {
  headline: string;
  tone: "go" | "wait" | "block";
  direction: "long" | "short" | null;
  directionLines: string[];
  zoneLine: string | null;
  breakLine: string | null;
  waitingFor: string | null;
}
export interface BotView {
  scannedAt: string;
  status: string;
  decision: BotDecision;
  zone: BotViewZone | null;
  impulse: BotViewImpulse | null;
  levels: BotViewLevels;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The scan record's direction reason, split into one plain line per timeframe. */
export function directionLines(reason: string | null | undefined): string[] {
  if (!reason) return [];
  return reason
    .replace(/^\[[a-z_]+\]\s*/i, "")
    .replace(/^✓\s*/, "")
    .split(" | ")
    .map((l) => l.replace(/\s*\[[^\]]*(highs|lows)[^\]]*\]/g, "").trim())
    .filter(Boolean);
}

function headlineFor(d: any): { headline: string; tone: BotDecision["tone"] } {
  const status: string = d?.status ?? "";
  const skip: string = d?.skipReason ?? "";
  const izReason: string = d?.impulseZone?.reason ?? "";
  if (status.startsWith("trade_placed")) return { headline: "Trade opened on this scan", tone: "go" };
  if (status === "pending_order_placed" || status === "zone_setup_placed") return { headline: "Pending order placed at the zone", tone: "go" };
  if (status === "watching_zone") return { headline: "Watching — zone found, price not there yet", tone: "wait" };
  if (status === "skipped_no_impulse_zone") {
    if (izReason.startsWith("No direction")) return { headline: "Blocked — the direction check said no", tone: "block" };
    return { headline: "No valid zone right now", tone: "block" };
  }
  if (status === "skipped_weak_zone") return { headline: "Skipped — zone score below your minimum", tone: "block" };
  if (status === "skipped_weak_break") return { headline: "Skipped — break candle closed too weakly", tone: "block" };
  if (status === "rejected") {
    const failed = Array.isArray(d?.gates) ? d.gates.find((g: any) => g && g.passed === false) : null;
    return { headline: `Skipped — ${failed?.reason ?? skip ?? "a risk rule blocked it"}`, tone: "block" };
  }
  if (skip) return { headline: skip, tone: "block" };
  return { headline: status ? status.replace(/_/g, " ") : "No decision recorded", tone: "wait" };
}

/** Shape one pair's scan detail for the chart and the decision card. */
export function buildBotView(detail: any, scannedAt: string): BotView {
  const uz = detail?.unifiedZone ?? null;
  const iz = detail?.impulseZone ?? null;
  const sd = detail?.simpleDirection ?? null;

  const imp = uz?.impulse ?? iz?.impulse ?? null;
  let impulse: BotViewImpulse | null = null;
  if (imp && num(imp.high) !== null && num(imp.low) !== null) {
    const dir: Dir = imp.direction === "bullish" ? "bullish" : "bearish";
    impulse = {
      direction: dir,
      fromPrice: num(imp.origin) ?? (dir === "bullish" ? imp.low : imp.high),
      toPrice: num(imp.terminus) ?? (dir === "bullish" ? imp.high : imp.low),
      fromTime: imp.startTime ?? null,
      toTime: imp.endTime ?? null,
      tf: uz?.selectedTF ?? iz?.selectedTF ?? imp.timeframe ?? null,
    };
  }

  let zone: BotViewZone | null = null;
  const bz = iz?.bestZone ?? null;
  const uzz = uz?.zone ?? null;
  const zLow = num(uzz?.low) ?? num(bz?.low), zHigh = num(uzz?.high) ?? num(bz?.high);
  if (zLow !== null && zHigh !== null) {
    const type = String(uzz?.type ?? bz?.type ?? "zone").toUpperCase();
    const fib = uzz?.fibLabel ?? (num(bz?.fibLevel) !== null ? `${(bz.fibLevel * 100).toFixed(1)}%` : null);
    const score = num(bz?.totalScore);
    zone = { low: Math.min(zLow, zHigh), high: Math.max(zLow, zHigh), label: `${type}${fib ? ` @ ${fib}` : ""}`, score };
  }

  const e = uz?.entry ?? null;
  const entry = num(e?.entryPrice) ?? num(bz?.refinedEntry);
  const sl = num(e?.slPrice) ?? num(bz?.refinedSL);
  const tp = num(e?.tpPrice);
  const levels: BotViewLevels = { entry, sl, tp, source: entry !== null || sl !== null || tp !== null ? "plan" : "none" };

  const { headline, tone } = headlineFor(detail);
  const dirRaw = sd?.direction ?? null;
  const q = uz?.impulse?.candleQuality;
  const zoneScore = zone?.score;
  const decision: BotDecision = {
    headline, tone,
    direction: dirRaw === "long" || dirRaw === "short" ? dirRaw : null,
    directionLines: directionLines(sd?.reason ?? (iz?.reason?.startsWith("No direction") ? iz.reason.replace(/^No direction:\s*/, "") : null)),
    zoneLine: zone ? `${zone.label}${zoneScore != null ? ` · score ${zoneScore}/9` : ""}` : null,
    breakLine: q && num(q.bosCloseStrength) !== null
      ? `Break candle closed ${Math.round(q.bosCloseStrength * 100)}% toward the move${q.bosCloseStrength >= 0.8 ? " — strong" : q.bosCloseStrength >= 0.6 ? " — solid" : q.bosCloseStrength >= 0.4 ? " — undecided" : " — rejected"}`
      : null,
    waitingFor: uz?.confirmation?.entryReady === false ? (uz.confirmation.detail ?? "Waiting for confirmation") :
      (detail?.status === "watching_zone" && num(uz?.price?.distancePips) !== null ? `Price ${uz.price.distancePips} pips from the zone` : null),
  };

  return { scannedAt, status: detail?.status ?? "", decision, zone, impulse, levels };
}

/** Bot View only offers the timeframes the scalper bot actually uses. */
export const BOT_VIEW_TIMEFRAMES = [
  { value: "1h", label: "1H" },
  { value: "15min", label: "15M" },
  { value: "5min", label: "5M" },
] as const;
