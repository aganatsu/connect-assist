/**
 * Links observation rows to real execution outcomes. PURE, read-only.
 *
 * THE PROBLEM THIS SOLVES. Several IPOs can read VALID_TOUCHED at once and the
 * scanner could not say which one actually traded. Worse, `WOULD_ENTER` was
 * rendered as though it were an entry. It is not:
 *
 *   WOULD_ENTER      the IPO rules admitted the setup. Says nothing about a fill.
 *   INTENT_CREATED   an execution intent exists. Still not a fill.
 *   FILLED           the trade actually entered. This is the only proof of entry.
 *   CLOSED           an entered trade later exited.
 *
 * So the user-facing label always comes from the EXECUTION event, and the
 * strategy verdict is shown underneath as secondary. A row that says
 * `FILLED / WOULD_ENTER` reads "Trade entered"; a row that says
 * `INTENT_CREATED / WOULD_ENTER` reads "Qualified — intent created", and the two
 * are never collapsed.
 *
 * OWNERSHIP IS EXACT OR IT IS NOTHING. A scanner row owns a position only when
 * symbol, timeframe, direction AND the IPO candle all match. Matching on symbol
 * alone — or on "this row is VALID_TOUCHED", or "this row says WOULD_ENTER" —
 * would attribute a trade to the wrong IPO precisely when several are live,
 * which is the case the feature exists for.
 *
 * TIMESTAMPS ARE COMPARED BY INSTANT, NOT BY BYTES. The observation row carries
 * the provider's datetime string verbatim (`2026-09-21T10:00:00Z`) while the
 * position comes back from Postgres as a timestamptz (`2026-09-21 10:00:00+00`).
 * String equality finds nothing. This exact mismatch has already caused two
 * production bugs in this codebase; it is not a hypothetical.
 */

// ── execution events ─────────────────────────────────────────────────────────

export type ExecutionEventKind =
  | "INTENT_CREATED" | "FILLED" | "CLOSED" | "REFUSED"
  | "MANAGED" | "GAP_SUSPENDED" | "GAP_RECOVERED";

export interface EventLike {
  event_type: string;
  strategy_decision: string;
  account_decision: string;
  reason_codes: string[];
  payload: Record<string, unknown>;
}

export interface EventReading {
  /** The headline. Always describes the EXECUTION event, never the verdict. */
  whatHappened: string;
  /** Secondary line. The strategy verdict, explicitly labelled as such. */
  strategyVerdict: string;
  /** One sentence on what this execution state does and does not prove. */
  meaning: string;
  /** True only for FILLED and CLOSED. Anything else has not proven an entry. */
  provesEntry: boolean;
  tone: "good" | "neutral" | "info" | "warn" | "bad";
  /** Raw codes, preserved for debugging. */
  raw: string[];
}

const EXIT_LABEL: Record<string, { label: string; tone: EventReading["tone"] }> = {
  TARGET_2R: { label: "Target hit", tone: "good" },
  S2_CLOSE_INVALIDATION: { label: "Stopped — S2 invalidation", tone: "bad" },
  DATA_GAP_ABORTED: { label: "Aborted — data gap", tone: "bad" },
};

/**
 * Reads one execution event.
 *
 * The ordering here is the point: the execution event decides the headline, and
 * the strategy verdict is demoted to a secondary line. Reversing it is what
 * produced "Strategy would enter" on a row where the trade had actually filled.
 */
export function readEvent(e: EventLike): EventReading {
  const raw = [
    `event ${e.event_type}`,
    `strategy ${e.strategy_decision}`,
    `account ${e.account_decision}`,
    ...(e.reason_codes?.length ? [e.reason_codes.join(", ")] : []),
  ];
  const block = e.payload?.blockReason as string | undefined;
  if (block) raw.push(`block ${block}`);
  const verdict = `Strategy verdict: ${e.strategy_decision}`;

  switch (e.event_type) {
    case "FILLED":
      return {
        whatHappened: "Trade entered", strategyVerdict: verdict, provesEntry: true, tone: "good",
        meaning: "Filled — the trade actually entered. This is the only event that proves entry.",
        raw,
      };
    case "CLOSED": {
      const reason = e.reason_codes?.find((c) => c in EXIT_LABEL);
      const hit = reason ? EXIT_LABEL[reason] : { label: "Closed", tone: "neutral" as const };
      return {
        whatHappened: hit.label, strategyVerdict: verdict, provesEntry: true, tone: hit.tone,
        meaning: "Closed — a filled trade exited.",
        raw,
      };
    }
    case "INTENT_CREATED":
      return {
        whatHappened: "Qualified — intent created", strategyVerdict: verdict, provesEntry: false,
        tone: "info",
        meaning: "Intent created — an order intent exists. This row alone does not prove a fill.",
        raw,
      };
    case "REFUSED":
      return {
        whatHappened: "Did not enter", strategyVerdict: verdict, provesEntry: false, tone: "warn",
        meaning: block === "POSITION_ALREADY_OPEN"
          ? "Execution was refused: another position on this instrument already held the one available slot. The strategy signal stayed valid."
          : block === "ECONOMICALLY_UNTRADEABLE_COST"
            ? "Execution was refused: spread and commission exceeded the cost ceiling in R. The strategy signal stayed valid."
            : "Execution was refused. The strategy signal stayed valid; only the entry was declined.",
        raw,
      };
    case "GAP_SUSPENDED":
      return {
        whatHappened: "Suspended — data gap", strategyVerdict: verdict, provesEntry: false, tone: "bad",
        meaning: "Management paused because bars are missing. Nothing is fabricated while suspended.",
        raw,
      };
    case "GAP_RECOVERED":
      return {
        whatHappened: "Recovered — bars arrived", strategyVerdict: verdict, provesEntry: false, tone: "good",
        meaning: "The missing bars arrived and management resumed on real data.",
        raw,
      };
    case "MANAGED":
      return {
        whatHappened: "Managed", strategyVerdict: verdict, provesEntry: false, tone: "neutral",
        meaning: "An open position was advanced a bar. No entry or exit occurred.",
        raw,
      };
    default:
      return {
        whatHappened: e.event_type, strategyVerdict: verdict, provesEntry: false, tone: "neutral",
        meaning: "Unrecognised execution event — shown raw rather than guessed at.",
        raw,
      };
  }
}

/** The standing clarification, rendered near the event list. */
export const ENTRY_PROOF_NOTE =
  "WOULD_ENTER does not mean entered. FILLED proves entry.";

// ── exact identity ───────────────────────────────────────────────────────────

export interface ObservationIdentity {
  instrument: string;
  timeframe: string;
  direction: string;
  ipoCandleTime: string;
}

export interface TradeIdentity {
  symbol: string;
  timeframe: string;
  direction: string;
  ipo_candle_time: string | null;
}

/**
 * Same moment, regardless of how each side spelled it.
 *
 * Returns false for anything unparseable rather than treating two invalid
 * strings as equal — a broken timestamp must not silently create ownership.
 */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = new Date(a).getTime(), y = new Date(b).getTime();
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

/**
 * Exact identity match between a scanner row and a position or closed trade.
 *
 * All four components are required. Dropping any one of them reintroduces the
 * bug: symbol alone attributes a trade to whichever IPO happens to be listed
 * first, and direction alone cannot separate a long and a short on one pair.
 */
export function isSameIpo(o: ObservationIdentity, t: TradeIdentity): boolean {
  return o.instrument === t.symbol
    && o.timeframe === t.timeframe
    && o.direction === t.direction
    && sameInstant(o.ipoCandleTime, t.ipo_candle_time);
}

// ── trade status ─────────────────────────────────────────────────────────────

export type TradeStatus =
  | "OPEN_POSITION_OWNER"
  | "FILLED_CLOSED"
  | "WOULD_ENTER_NOT_FILLED"
  | "BLOCKED_BY_OPEN_POSITION"
  | "ELIGIBLE_NO_TRADE"
  | "NO_TRADE";

export const TRADE_STATUS_BADGE: Record<TradeStatus, string> = {
  OPEN_POSITION_OWNER: "OPEN POSITION",
  FILLED_CLOSED: "CLOSED TRADE",
  WOULD_ENTER_NOT_FILLED: "QUALIFIED — NOT FILLED",
  BLOCKED_BY_OPEN_POSITION: "BLOCKED BY OPEN POSITION",
  ELIGIBLE_NO_TRADE: "ELIGIBLE",
  NO_TRADE: "NO TRADE",
};

export const TRADE_STATUS_MEANING: Record<TradeStatus, string> = {
  OPEN_POSITION_OWNER: "This exact IPO currently owns the open position.",
  FILLED_CLOSED: "This exact IPO produced a real filled trade that later closed.",
  WOULD_ENTER_NOT_FILLED: "The strategy qualified the setup, but there is no proof of fill.",
  BLOCKED_BY_OPEN_POSITION:
    "The IPO qualified or touched, but another IPO position on the same instrument already owned the one available trade slot.",
  ELIGIBLE_NO_TRADE: "The IPO is valid or eligible but no filled trade exists.",
  NO_TRADE: "No actual trade event exists for this row.",
};

export const TRADE_STATUS_TONE: Record<TradeStatus, EventReading["tone"]> = {
  OPEN_POSITION_OWNER: "info",
  FILLED_CLOSED: "good",
  WOULD_ENTER_NOT_FILLED: "warn",
  BLOCKED_BY_OPEN_POSITION: "warn",
  ELIGIBLE_NO_TRADE: "neutral",
  NO_TRADE: "neutral",
};

export interface RowLike extends ObservationIdentity {
  state: string;
  signalValid: boolean;
  executionEligible: boolean;
}

export interface PositionLike extends TradeIdentity {
  entry_time: string;
  entry_price: number;
  target_price: number;
  s2_invalidation_level: number;
  volatility_bucket: string;
  zone_entry_ordinal: number | null;
  setup_id?: string | null;
  intent_id?: string | null;
  status?: string;
}

export interface ClosedLike extends PositionLike {
  exit_time: string;
  exit_price: number | null;
  exit_reason: string;
  realized_r: number | null;
  realized_pnl_usd: number | null;
}

export interface Linkage {
  status: TradeStatus;
  badge: string;
  meaning: string;
  tone: EventReading["tone"];
  /** The position this row owns, when it owns one. */
  ownedPosition: PositionLike | null;
  /** The closed trade this row produced, when it produced one. */
  closedTrade: ClosedLike | null;
  /** When blocked, the position that actually holds the slot. Never this row's own. */
  blockingOwner: PositionLike | null;
}

/**
 * Classifies one scanner row against real execution outcomes.
 *
 * ORDER MATTERS AND IS DELIBERATE:
 *
 *   1. owns the open position            proven by exact identity
 *   2. produced a closed trade           proven by exact identity
 *   3. blocked by someone else's position  requires an open position on this
 *                                          instrument that is NOT this row, and
 *                                          requires this row to be qualified —
 *                                          an unqualified row was not blocked,
 *                                          it simply had nothing to offer
 *   4. eligible but no trade
 *   5. nothing
 *
 * `WOULD_ENTER_NOT_FILLED` is deliberately NOT derived here from a bare
 * WOULD_ENTER verdict. See `linkRows`.
 */
export function classifyRow(
  row: RowLike,
  openPositions: readonly PositionLike[],
  closedTrades: readonly ClosedLike[],
): Linkage {
  const build = (
    status: TradeStatus,
    extra: Partial<Pick<Linkage, "ownedPosition" | "closedTrade" | "blockingOwner">> = {},
  ): Linkage => ({
    status,
    badge: TRADE_STATUS_BADGE[status],
    meaning: TRADE_STATUS_MEANING[status],
    tone: TRADE_STATUS_TONE[status],
    ownedPosition: null, closedTrade: null, blockingOwner: null,
    ...extra,
  });

  const owned = openPositions.find((p) => isSameIpo(row, p)) ?? null;
  if (owned) return build("OPEN_POSITION_OWNER", { ownedPosition: owned });

  // Newest close wins when one zone produced several entries — the ordinal
  // distinguishes them and the most recent is the one a trader is looking at.
  const closed = closedTrades
    .filter((t) => isSameIpo(row, t))
    .sort((a, b) => new Date(b.exit_time).getTime() - new Date(a.exit_time).getTime())[0] ?? null;
  if (closed) return build("FILLED_CLOSED", { closedTrade: closed });

  const qualified = row.signalValid || row.executionEligible
    || row.state === "VALID_LIVE" || row.state === "VALID_TOUCHED";

  const otherOwner = openPositions.find((p) => p.symbol === row.instrument) ?? null;
  if (otherOwner && qualified) return build("BLOCKED_BY_OPEN_POSITION", { blockingOwner: otherOwner });

  if (qualified) return build("ELIGIBLE_NO_TRADE");
  return build("NO_TRADE");
}

export interface LinkedRow<R extends RowLike> {
  row: R;
  link: Linkage;
}

/**
 * Classifies every row.
 *
 * WHY `WOULD_ENTER_NOT_FILLED` IS RARELY REACHED, and is never guessed at.
 * Attributing an unfilled intent to a scanner row needs the intent's IPO candle
 * time. `ipo_execution_events` stores `setup_id` and `intent_id` but no
 * `ipo_candle_time`, and an intent that never filled leaves no position or
 * trade row to supply one. So the link is only available when a position or
 * trade exists for that setup — by which point it did fill. The status is
 * modelled and rendered, and is reached only when the caller can supply a
 * genuine setup-level link through `unfilledSetupIds`; it is never inferred
 * from a bare WOULD_ENTER verdict, because that would state as fact the exact
 * thing the whole change exists to stop claiming.
 */
export function linkRows<R extends RowLike>(
  rows: readonly R[],
  openPositions: readonly PositionLike[],
  closedTrades: readonly ClosedLike[],
  unfilledSetupIds: ReadonlySet<string> = new Set(),
): Array<LinkedRow<R>> {
  return rows.map((row) => {
    const link = classifyRow(row, openPositions, closedTrades);
    if (link.status === "ELIGIBLE_NO_TRADE" && unfilledSetupIds.size > 0) {
      const setup = link.ownedPosition?.setup_id ?? link.closedTrade?.setup_id ?? null;
      if (setup && unfilledSetupIds.has(setup)) {
        return { row, link: {
          ...link,
          status: "WOULD_ENTER_NOT_FILLED" as const,
          badge: TRADE_STATUS_BADGE.WOULD_ENTER_NOT_FILLED,
          meaning: TRADE_STATUS_MEANING.WOULD_ENTER_NOT_FILLED,
          tone: TRADE_STATUS_TONE.WOULD_ENTER_NOT_FILLED,
        } };
      }
    }
    return { row, link };
  });
}

/** Exactly the rows that own an open position. Should be at most one per instrument. */
export const ownersOf = <R extends RowLike>(linked: ReadonlyArray<LinkedRow<R>>) =>
  linked.filter((l) => l.link.status === "OPEN_POSITION_OWNER");

// ── zone entry ordinal ───────────────────────────────────────────────────────

/**
 * `zone_entry_ordinal` in trader language.
 *
 * It counts entries FROM THE SAME IPO ZONE. It is not the first trade of the
 * day, not the first IPO on the chart, and not the first trade on the symbol —
 * all three are natural misreadings of a bare "1".
 */
export function ordinalPhrase(n: number | null | undefined): string {
  if (n == null) return "entry number not recorded";
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th"
    : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix} entry from this IPO`;
}

export const ORDINAL_MEANING =
  "How many times this same IPO zone has generated an entry. Not the first trade of the day, not the first IPO on the chart, and not the first trade on the symbol.";

// ── new-entry eligibility vs. the state of the trade that already exists ──────

/**
 * What the engine's raw sequencing fields MEAN for one particular row.
 *
 * THE CONTRADICTION THIS REMOVES. `sequencingState`, `executionEligible` and the
 * reason codes all answer one question: *could a NEW entry be created on this
 * instrument right now?* When a position is open the answer is always no, and
 * the engine correctly reports `BLOCKED_POSITION_OPEN` / `POSITION_ALREADY_OPEN`
 * / `executionEligible: false` on EVERY row for that instrument — including the
 * row whose own IPO opened that position.
 *
 * Rendered verbatim, the owning row therefore read:
 *
 *     Trade status              OPEN POSITION
 *     sequencing                BLOCKED_POSITION_OPEN
 *     would the rules admit it  no
 *     POSITION_ALREADY_OPEN
 *
 * which says a live trade is a rejection. It is not: the slot is occupied BY
 * THIS TRADE. Those fields describe a hypothetical second entry.
 *
 * So the same raw data reads three different ways and the row decides which:
 *
 *   owner   — the block is self-referential. Not a rejection. Audit only.
 *   blocked — someone else holds the slot. A real rejection, and the owner is named.
 *   free    — no position; ordinary eligibility semantics, unchanged.
 */
export type NewEntryVerdict = "OWNS_POSITION" | "BLOCKED_BY_OTHER" | "ORDINARY";

export interface NewEntryCheck {
  verdict: NewEntryVerdict;
  /** True only when this row's own IPO opened the position that is open now. */
  ownsOpenPosition: boolean;
  /** The one dominant status for the primary view. */
  primaryBadge: string;
  /** Headline sentence for the CURRENT STATUS block. */
  headline: string;
  /** What the raw engine fields mean here, in words. */
  rawExplanation: string;
  /**
   * TRUE only when the raw block is a genuine rejection OF THIS ROW. False for
   * the owning row, whose "block" is its own position.
   */
  isRejection: boolean;
  /** Who holds the slot, when it is not this row. */
  blockingOwner: PositionLike | null;
}

const stamp = (iso: string | null | undefined) =>
  iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") : "an earlier bar";

/**
 * Reads the engine's new-entry fields in the context of one row.
 *
 * Derived from `Linkage`, which establishes ownership by EXACT identity —
 * symbol, timeframe, direction and IPO candle instant. Never from display text,
 * never from "this row is VALID_TOUCHED", and never from the reason codes
 * themselves, which are identical for the owner and for a bystander.
 */
export function readNewEntryCheck(link: Linkage | null | undefined): NewEntryCheck {
  if (link?.status === "OPEN_POSITION_OWNER") {
    const p = link.ownedPosition;
    return {
      verdict: "OWNS_POSITION",
      ownsOpenPosition: true,
      primaryBadge: "POSITION ACTIVE",
      headline: "This IPO opened the current paper position.",
      rawExplanation:
        "A second entry would be blocked because this IPO already owns the active position" +
        (p ? ` (opened ${stamp(p.entry_time)}).` : ".") +
        " The engine's sequencing fields describe that hypothetical new entry, not this trade.",
      isRejection: false,
      blockingOwner: null,
    };
  }

  if (link?.status === "BLOCKED_BY_OPEN_POSITION" && link.blockingOwner) {
    const p = link.blockingOwner;
    return {
      verdict: "BLOCKED_BY_OTHER",
      ownsOpenPosition: false,
      primaryBadge: "BLOCKED — POSITION ALREADY OPEN",
      headline:
        `Blocked because ${p.symbol} already has an open IPO position from ${stamp(p.entry_time)}.`,
      rawExplanation:
        "One position per instrument is a frozen rule. A different IPO holds the slot, so this " +
        "setup could not be entered even though the strategy signal stayed valid.",
      isRejection: true,
      blockingOwner: p,
    };
  }

  return {
    verdict: "ORDINARY",
    ownsOpenPosition: false,
    primaryBadge: link?.badge ?? "—",
    headline: link?.meaning ?? "No trade ledger available for this row.",
    rawExplanation:
      "No position is open on this instrument, so the sequencing fields report ordinary " +
      "new-entry eligibility.",
    isRejection: false,
    blockingOwner: null,
  };
}

/**
 * Should a raw reason code be shown as a rejection in the primary view?
 *
 * `POSITION_ALREADY_OPEN` on the owning row is the row describing itself, and
 * showing it beside OPEN POSITION is the contradiction this module exists to
 * end. It stays available under the raw audit section, never above it.
 */
export const SELF_REFERENTIAL_CODES = ["POSITION_ALREADY_OPEN", "BLOCKED_POSITION_OPEN"];

export function primaryReasonCodes(codes: readonly string[], check: NewEntryCheck): string[] {
  if (!check.ownsOpenPosition) return [...codes];
  return codes.filter((c) => !SELF_REFERENTIAL_CODES.includes(c));
}
