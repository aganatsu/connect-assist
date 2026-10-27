// Broker vs bot price log (Impulse-on-V3 step 4c; owner decision S3 = measure first, 2026-10-27).
//
// bot-scanner mirrors every paper fill to MT5 and mirrors the bot's SL / TP close. MT5 prices differ from our feed (spread,
// slippage, the 21:00 UTC rollover spike), and MT5 can close its copy on a price our feed never printed. Before choosing a rollover
// rule (S3 options b / c) we measure: each mirrored position records the bot's price next to MT5's at open and at close, and a
// close where MT5 no longer held the trade looks up MT5's own close.
//
// MEASUREMENT ONLY. Every function here is best-effort: it never throws, never changes what the mirror does, and is called only
// after the existing mirror call. One extra MetaApi read per fill (the opened position) and one per broker-only close (the deals).
import { SPECS } from "./smcAnalysis.ts";

// deno-lint-ignore no-explicit-any
type Client = { from: (table: string) => any };
/** metaFetch bound to one connection (region failover included). */
export type MetaCall = (path: (base: string) => string, init?: RequestInit) => Promise<{ res: Response; body: string }>;
type Dir = "long" | "short";

/** 20:50–21:30 UTC: the broker's daily rollover, where spreads blow out and spike wicks appear on MT5 charts only. */
export const ROLLOVER_FROM_MIN = 20 * 60 + 50, ROLLOVER_TO_MIN = 21 * 60 + 30;
export function inRolloverWindow(iso: string | null | undefined): boolean | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  const m = t.getUTCHours() * 60 + t.getUTCMinutes();
  return m >= ROLLOVER_FROM_MIN && m < ROLLOVER_TO_MIN;
}

const pipOf = (symbol: string) => (SPECS[symbol] ?? SPECS["EUR/USD"]).pipSize;
/** Signed pips, positive = MT5 got the worse price for us (paid more on a buy, received less on a sell). */
export function slippagePips(kind: "open" | "close", dir: Dir, bot: number | null, broker: number | null, symbol: string): number | null {
  if (bot == null || broker == null || !Number.isFinite(bot) || !Number.isFinite(broker)) return null;
  const buying = (kind === "open") === (dir === "long");
  const worse = buying ? broker - bot : bot - broker;
  return Math.round((worse / pipOf(symbol)) * 100) / 100;
}

const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const tagMatches = (comment: unknown, positionId: string) => {
  const tag = `paper:${positionId}`;
  return typeof comment === "string" && (comment.includes(tag) || comment.startsWith(tag.slice(0, 28)));
};
const OK_CODES = new Set(["TRADE_RETCODE_DONE", "TRADE_RETCODE_DONE_PARTIAL", "TRADE_RETCODE_PLACED", "ERR_NO_ERROR"]);

/** The MetaApi /trade reply: the broker position id when the open went through, else the reason it did not. */
export function parseTradeReply(ok: boolean, status: number, body: string): { opened: true; brokerPositionId: string | null; code: string | null } | { opened: false; code: string } {
  let j: Record<string, unknown> = {};
  try { j = JSON.parse(body); } catch { /* non-JSON reply */ }
  const code = typeof j.stringCode === "string" ? j.stringCode : null;
  if (!ok) return { opened: false, code: code ?? `HTTP ${status}` };
  if (code && !OK_CODES.has(code)) return { opened: false, code };
  const id = j.positionId ?? j.orderId;
  return { opened: true, brokerPositionId: id == null ? null : String(id), code };
}

export interface BrokerClose { brokerPositionId: string | null; openPrice: number | null; closePrice: number | null; closeTime: string | null; reason: string | null }
/**
 * MT5's own close from its deal history: the opening deal is the one carrying our comment (or the known broker position id);
 * the close is that position's last DEAL_ENTRY_OUT. Volume-weighted when MT5 closed in parts.
 */
export function brokerCloseFromDeals(deals: unknown, positionId: string, brokerPositionId: string | null): BrokerClose | null {
  if (!Array.isArray(deals)) return null;
  // deno-lint-ignore no-explicit-any
  const ds = deals as any[];
  const opening = ds.find((d) => d?.entryType === "DEAL_ENTRY_IN" && (brokerPositionId ? String(d.positionId) === brokerPositionId : tagMatches(d.comment, positionId)));
  const pid = brokerPositionId ?? (opening ? String(opening.positionId) : null);
  if (!pid) return null;
  const outs = ds.filter((d) => String(d?.positionId) === pid && (d.entryType === "DEAL_ENTRY_OUT" || d.entryType === "DEAL_ENTRY_OUT_BY"))
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const vol = outs.reduce((s, d) => s + (num(d.volume) ?? 0), 0);
  const closePrice = !outs.length ? null : vol > 0 ? outs.reduce((s, d) => s + (num(d.price) ?? 0) * (num(d.volume) ?? 0), 0) / vol : num(outs.at(-1).price);
  return { brokerPositionId: pid, openPrice: num(opening?.price), closePrice, closeTime: outs.at(-1)?.time ?? null, reason: outs.at(-1)?.reason ?? null };
}

interface Base { userId: string; botId: string; positionId: string; connectionId: string; symbol: string; direction: Dir; entryZoneType: string | null }

async function insert(db: Client, row: Record<string, unknown>): Promise<void> {
  try {
    const { error } = await db.from("broker_price_log").insert(row);
    // 23505 = already recorded for this position / connection / event (a retried cycle): fine
    if (error && error.code !== "23505") console.warn(`[broker-price-log] insert ${row.event} ${row.position_id}: ${error.message}`);
  } catch (e) {
    console.warn(`[broker-price-log] insert ${row.event} ${row.position_id}: ${(e as Error)?.message}`);
  }
}
const baseRow = (b: Base) => ({
  user_id: b.userId, bot_id: b.botId, position_id: b.positionId, connection_id: b.connectionId, symbol: b.symbol, direction: b.direction,
  entry_zone_type: b.entryZoneType,
});

/** The mirror skipped this fill (spread too wide): the paper position runs with no broker copy. */
export async function recordBrokerOpenSkipped(db: Client, b: Base & { botPrice: number; reason: string; detail?: Record<string, unknown> }): Promise<void> {
  await insert(db, { ...baseRow(b), event: "open_skipped", bot_price: b.botPrice, detail: { reason: b.reason, ...(b.detail ?? {}) } });
}

/** After the MT5 open: the broker position id and MT5's open price next to the bot's fill (one extra read of that position). */
export async function recordBrokerOpen(db: Client, meta: MetaCall, b: Base & { botPrice: number; ok: boolean; status: number; reply: string; spread?: { bid: number; ask: number; spreadPips: number } | null }): Promise<void> {
  try {
    const r = parseTradeReply(b.ok, b.status, b.reply);
    const spread = b.spread ? { bid: b.spread.bid, ask: b.spread.ask, spreadPips: b.spread.spreadPips } : null;
    if (!r.opened) {
      await insert(db, { ...baseRow(b), event: "open_failed", bot_price: b.botPrice, detail: { code: r.code, status: b.status, spread } });
      return;
    }
    let openPrice: number | null = null, openTime: string | null = null;
    if (r.brokerPositionId) {
      try {
        const { res, body } = await meta((base) => `${base}/positions/${encodeURIComponent(r.brokerPositionId!)}`);
        if (res.ok) { const p = JSON.parse(body); openPrice = num(p?.openPrice); openTime = typeof p?.time === "string" ? p.time : null; }
      } catch { /* price stays unknown */ }
    }
    await insert(db, {
      ...baseRow(b), event: "open", bot_price: b.botPrice, broker_price: openPrice, broker_open_price: openPrice,
      slippage_pips: slippagePips("open", b.direction, b.botPrice, openPrice, b.symbol), broker_position_id: r.brokerPositionId,
      broker_time: openTime, rollover_window: inRolloverWindow(openTime), detail: { code: r.code, spread },
    });
  } catch (e) {
    console.warn(`[broker-price-log] open ${b.positionId}: ${(e as Error)?.message}`);
  }
}

/**
 * At the bot's SL / TP close, per mirrored connection. `brokerPos` is the matching entry of the /positions list the close mirror
 * already fetched: present = MT5 still held it (record MT5's price at that moment); absent = MT5 closed it first (look up MT5's
 * own close in its deal history, from the position's open time).
 */
export async function recordBrokerClose(db: Client, meta: MetaCall, b: Base & {
  // deno-lint-ignore no-explicit-any
  botExitPrice: number; botCloseReason: string; openTime: string | null; brokerPos: any | null; nowIso: string;
}): Promise<void> {
  try {
    if (b.brokerPos) {
      const px = num(b.brokerPos.currentPrice);
      await insert(db, {
        ...baseRow(b), event: "close_mirrored", bot_price: b.botExitPrice, broker_price: px, broker_open_price: num(b.brokerPos.openPrice),
        slippage_pips: slippagePips("close", b.direction, b.botExitPrice, px, b.symbol), broker_position_id: b.brokerPos.id == null ? null : String(b.brokerPos.id),
        broker_time: b.nowIso, bot_close_reason: b.botCloseReason, rollover_window: inRolloverWindow(b.nowIso), detail: {},
      });
      return;
    }
    let known: string | null = null;
    try {
      const { data } = await db.from("broker_price_log").select("broker_position_id").eq("position_id", b.positionId).eq("connection_id", b.connectionId).eq("event", "open").limit(1);
      known = data?.[0]?.broker_position_id ?? null;
    } catch { /* fall back to the comment search */ }
    let close: BrokerClose | null = null, lookup = "none";
    try {
      const from = new Date(Date.parse(b.openTime ?? b.nowIso) - 10 * 60_000).toISOString();
      const path = known ? (base: string) => `${base}/history-deals/position/${encodeURIComponent(known!)}`
        : (base: string) => `${base}/history-deals/time/${from}/${b.nowIso}`;
      const { res, body } = await meta(path);
      lookup = res.ok ? (known ? "position" : "time") : `HTTP ${res.status}`;
      if (res.ok) close = brokerCloseFromDeals(JSON.parse(body), b.positionId, known);
    } catch (e) { lookup = `error: ${(e as Error)?.message}`; }
    await insert(db, {
      ...baseRow(b), event: "broker_closed_first", bot_price: b.botExitPrice, broker_price: close?.closePrice ?? null, broker_open_price: close?.openPrice ?? null,
      slippage_pips: slippagePips("close", b.direction, b.botExitPrice, close?.closePrice ?? null, b.symbol), broker_position_id: close?.brokerPositionId ?? known,
      broker_time: close?.closeTime ?? null, broker_reason: close?.reason ?? null, bot_close_reason: b.botCloseReason,
      rollover_window: inRolloverWindow(close?.closeTime ?? null), detail: { lookup },
    });
  } catch (e) {
    console.warn(`[broker-price-log] close ${b.positionId}: ${(e as Error)?.message}`);
  }
}
