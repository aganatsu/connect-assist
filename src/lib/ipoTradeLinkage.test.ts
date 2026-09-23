import { describe, it, expect } from "vitest";
import {
  readEvent, ENTRY_PROOF_NOTE, sameInstant, isSameIpo, classifyRow, linkRows, ownersOf,
  ordinalPhrase, ORDINAL_MEANING, TRADE_STATUS_BADGE, TRADE_STATUS_MEANING,
  type EventLike, type RowLike, type PositionLike, type ClosedLike,
} from "./ipoTradeLinkage";

const ev = (over: Partial<EventLike> = {}): EventLike => ({
  event_type: "MANAGED", strategy_decision: "HOLD", account_decision: "UNAVAILABLE",
  reason_codes: [], payload: {}, ...over,
});

const row = (over: Partial<RowLike> = {}): RowLike => ({
  instrument: "USD/JPY", timeframe: "30min", direction: "short",
  // Provider form: the exact bytes the engine saw.
  ipoCandleTime: "2026-09-22T07:30:00Z",
  state: "VALID_TOUCHED", signalValid: true, executionEligible: false, ...over,
});

const pos = (over: Partial<PositionLike> = {}): PositionLike => ({
  symbol: "USD/JPY", timeframe: "30min", direction: "short",
  // Postgres form for the SAME instant. String equality would miss this.
  ipo_candle_time: "2026-09-22 07:30:00+00",
  entry_time: "2026-09-22T09:00:00Z", entry_price: 157.5, target_price: 156.5,
  s2_invalidation_level: 158.0, volatility_bucket: "HIGH_VOL", zone_entry_ordinal: 1,
  setup_id: "stp_4444a16ec717d0b4", intent_id: "int_10ef91e52f8a79d0", status: "open", ...over,
});

const closed = (over: Partial<ClosedLike> = {}): ClosedLike => ({
  ...pos(), exit_time: "2026-09-23T07:00:00Z", exit_price: 157.77,
  exit_reason: "S2_CLOSE_INVALIDATION", realized_r: -1.599, realized_pnl_usd: -319.8, ...over,
});

// ── 1. a verdict is not an entry ─────────────────────────────────────────────

describe("strategy decision and execution event are never collapsed", () => {
  it("WOULD_ENTER alone is never shown as a filled trade", () => {
    // The verdict on its own — on any non-fill event — must not claim entry.
    for (const type of ["INTENT_CREATED", "REFUSED", "MANAGED"]) {
      const r = readEvent(ev({ event_type: type, strategy_decision: "WOULD_ENTER" }));
      expect(r.provesEntry).toBe(false);
      expect(r.whatHappened).not.toMatch(/entered/i);
    }
  });

  it("INTENT_CREATED + WOULD_ENTER reads qualified/intent-created, not entered", () => {
    const r = readEvent(ev({ event_type: "INTENT_CREATED", strategy_decision: "WOULD_ENTER" }));
    expect(r.whatHappened).toBe("Qualified — intent created");
    expect(r.strategyVerdict).toBe("Strategy verdict: WOULD_ENTER");
    expect(r.meaning).toMatch(/does not prove a fill/i);
    expect(r.provesEntry).toBe(false);
  });

  it("FILLED + WOULD_ENTER reads trade entered, with the verdict demoted", () => {
    const r = readEvent(ev({ event_type: "FILLED", strategy_decision: "WOULD_ENTER" }));
    expect(r.whatHappened).toBe("Trade entered");
    expect(r.strategyVerdict).toBe("Strategy verdict: WOULD_ENTER");
    expect(r.provesEntry).toBe(true);
    // The old bug: the verdict became the headline.
    expect(r.whatHappened).not.toMatch(/would enter/i);
  });

  it("the two WOULD_ENTER rows do not produce the same label", () => {
    const intent = readEvent(ev({ event_type: "INTENT_CREATED", strategy_decision: "WOULD_ENTER" }));
    const filled = readEvent(ev({ event_type: "FILLED", strategy_decision: "WOULD_ENTER" }));
    expect(intent.whatHappened).not.toBe(filled.whatHappened);
  });

  it("CLOSED + TARGET_2R reads target hit", () => {
    const r = readEvent(ev({ event_type: "CLOSED", strategy_decision: "WOULD_EXIT",
                             reason_codes: ["TARGET_2R"] }));
    expect(r.whatHappened).toBe("Target hit");
    expect(r.tone).toBe("good");
    expect(r.provesEntry).toBe(true);
  });

  it("CLOSED + S2_CLOSE_INVALIDATION reads stopped by S2", () => {
    const r = readEvent(ev({ event_type: "CLOSED", strategy_decision: "WOULD_EXIT",
                             reason_codes: ["S2_CLOSE_INVALIDATION"] }));
    expect(r.whatHappened).toBe("Stopped — S2 invalidation");
    expect(r.tone).toBe("bad");
  });

  it("an execution refusal reads did not enter, and names the block", () => {
    const r = readEvent(ev({ event_type: "REFUSED", strategy_decision: "WOULD_ENTER",
                             payload: { blockReason: "POSITION_ALREADY_OPEN" } }));
    expect(r.whatHappened).toBe("Did not enter");
    expect(r.meaning).toMatch(/already held the one available slot/i);
    expect(r.raw).toContain("block POSITION_ALREADY_OPEN");
  });

  it("keeps the raw codes on every reading", () => {
    const r = readEvent(ev({ event_type: "FILLED", strategy_decision: "WOULD_ENTER" }));
    expect(r.raw).toContain("event FILLED");
    expect(r.raw).toContain("strategy WOULD_ENTER");
  });

  it("states the rule in one line", () => {
    expect(ENTRY_PROOF_NOTE).toBe("WOULD_ENTER does not mean entered. FILLED proves entry.");
  });
});

// ── 2. exact identity ────────────────────────────────────────────────────────

describe("ownership requires exact IPO identity", () => {
  it("matches across the two timestamp spellings of the same instant", () => {
    expect(sameInstant("2026-09-22T07:30:00Z", "2026-09-22 07:30:00+00")).toBe(true);
    expect(isSameIpo(row(), pos())).toBe(true);
  });

  it("refuses a match on symbol alone", () => {
    // Same pair, different IPO candle — the exact case that misattributed trades.
    expect(isSameIpo(row({ ipoCandleTime: "2026-09-22T06:30:00Z" }), pos())).toBe(false);
  });

  it("refuses a match on the wrong direction or timeframe", () => {
    expect(isSameIpo(row({ direction: "long" }), pos())).toBe(false);
    expect(isSameIpo(row({ timeframe: "1h" }), pos())).toBe(false);
  });

  it("never treats a missing or unparseable timestamp as a match", () => {
    expect(sameInstant(null, "2026-09-22 07:30:00+00")).toBe(false);
    expect(sameInstant("not a date", "also not a date")).toBe(false);
    expect(isSameIpo(row(), pos({ ipo_candle_time: null }))).toBe(false);
  });
});

// ── 3. trade status ──────────────────────────────────────────────────────────

describe("trade status", () => {
  it("marks the exact owner of the open position", () => {
    const l = classifyRow(row(), [pos()], []);
    expect(l.status).toBe("OPEN_POSITION_OWNER");
    expect(l.ownedPosition?.setup_id).toBe("stp_4444a16ec717d0b4");
    expect(l.badge).toBe("OPEN POSITION");
  });

  it("marks exactly one row as owner when several are VALID_TOUCHED", () => {
    const rows = [
      row({ ipoCandleTime: "2026-09-22T07:30:00Z" }),   // the real owner
      row({ ipoCandleTime: "2026-09-22T06:30:00Z" }),
      row({ ipoCandleTime: "2026-09-22T05:30:00Z" }),
    ];
    const linked = linkRows(rows, [pos()], []);
    const owners = ownersOf(linked);
    expect(owners).toHaveLength(1);
    expect(owners[0].row.ipoCandleTime).toBe("2026-09-22T07:30:00Z");
  });

  it("VALID_TOUCHED alone never implies a trade entered", () => {
    const linked = linkRows([row({ state: "VALID_TOUCHED" })], [], []);
    expect(linked[0].link.status).toBe("ELIGIBLE_NO_TRADE");
    expect(linked[0].link.ownedPosition).toBeNull();
    expect(linked[0].link.badge).toBe("ELIGIBLE");
  });

  it("no open position means no row is falsely marked owner", () => {
    const rows = [row(), row({ ipoCandleTime: "2026-09-22T06:30:00Z" })];
    expect(ownersOf(linkRows(rows, [], []))).toHaveLength(0);
  });

  it("marks a closed trade against the IPO that produced it", () => {
    const l = classifyRow(row(), [], [closed()]);
    expect(l.status).toBe("FILLED_CLOSED");
    expect(l.closedTrade?.exit_reason).toBe("S2_CLOSE_INVALIDATION");
    expect(l.badge).toBe("CLOSED TRADE");
  });

  it("maps a closed trade back to the correct originating IPO, not a neighbour", () => {
    const mine = closed({ ipo_candle_time: "2026-09-22 07:30:00+00", setup_id: "stp_mine" });
    const other = closed({ ipo_candle_time: "2026-09-18 06:30:00+00", setup_id: "stp_other" });
    const l = classifyRow(row(), [], [other, mine]);
    expect(l.closedTrade?.setup_id).toBe("stp_mine");
  });

  it("picks the most recent close when one zone produced several entries", () => {
    const first = closed({ exit_time: "2026-09-20T10:00:00Z", zone_entry_ordinal: 1, setup_id: "a" });
    const third = closed({ exit_time: "2026-09-23T10:00:00Z", zone_entry_ordinal: 3, setup_id: "c" });
    expect(classifyRow(row(), [], [first, third]).closedTrade?.setup_id).toBe("c");
  });

  it("blocks a qualified row and names the ACTUAL owner, not itself", () => {
    const blockedRow = row({ ipoCandleTime: "2026-09-22T06:30:00Z", state: "VALID_TOUCHED" });
    const owner = pos({ ipo_candle_time: "2026-09-22 07:30:00+00", direction: "short", setup_id: "stp_owner" });
    const l = classifyRow(blockedRow, [owner], []);
    expect(l.status).toBe("BLOCKED_BY_OPEN_POSITION");
    expect(l.blockingOwner?.setup_id).toBe("stp_owner");
    expect(isSameIpo(blockedRow, l.blockingOwner!)).toBe(false);
  });

  it("does not call an unqualified row blocked — it had nothing to offer", () => {
    const dead = row({ state: "PENDING_DEAD", signalValid: false, executionEligible: false,
                       ipoCandleTime: "2026-09-22T06:30:00Z" });
    expect(classifyRow(dead, [pos()], []).status).toBe("NO_TRADE");
  });

  it("does not block on a position belonging to a different instrument", () => {
    const l = classifyRow(row({ ipoCandleTime: "2026-09-22T06:30:00Z" }),
                          [pos({ symbol: "EUR/USD" })], []);
    expect(l.status).toBe("ELIGIBLE_NO_TRADE");
  });

  it("never invents WOULD_ENTER_NOT_FILLED from a bare verdict", () => {
    // It requires a real setup-level link. Without one the row stays eligible.
    const linked = linkRows([row({ signalValid: true })], [], [], new Set(["stp_unrelated"]));
    expect(linked[0].link.status).toBe("ELIGIBLE_NO_TRADE");
  });

  it("gives every status a badge and a meaning", () => {
    for (const k of Object.keys(TRADE_STATUS_BADGE) as Array<keyof typeof TRADE_STATUS_BADGE>) {
      expect(TRADE_STATUS_BADGE[k].length).toBeGreaterThan(0);
      expect(TRADE_STATUS_MEANING[k].length).toBeGreaterThan(20);
    }
  });
});

// ── 4. ordinal ───────────────────────────────────────────────────────────────

describe("zone entry ordinal in trader language", () => {
  it("maps to the correct human-readable entry number", () => {
    expect(ordinalPhrase(1)).toBe("1st entry from this IPO");
    expect(ordinalPhrase(2)).toBe("2nd entry from this IPO");
    expect(ordinalPhrase(3)).toBe("3rd entry from this IPO");
    expect(ordinalPhrase(4)).toBe("4th entry from this IPO");
  });

  it("handles the teens, which the naive rule gets wrong", () => {
    expect(ordinalPhrase(11)).toBe("11th entry from this IPO");
    expect(ordinalPhrase(12)).toBe("12th entry from this IPO");
    expect(ordinalPhrase(13)).toBe("13th entry from this IPO");
    expect(ordinalPhrase(21)).toBe("21st entry from this IPO");
  });

  it("says so when the ordinal was never recorded", () => {
    expect(ordinalPhrase(null)).toBe("entry number not recorded");
    expect(ordinalPhrase(undefined)).toBe("entry number not recorded");
  });

  it("rules out the three natural misreadings in its own definition", () => {
    expect(ORDINAL_MEANING).toMatch(/same IPO zone/i);
    expect(ORDINAL_MEANING).toMatch(/not the first trade of the day/i);
    expect(ORDINAL_MEANING).toMatch(/not the first IPO on the chart/i);
    expect(ORDINAL_MEANING).toMatch(/not the first trade on the symbol/i);
  });
});
