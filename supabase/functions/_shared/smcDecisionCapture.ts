/**
 * Per-symbol decision capture. PURE — no database, no network, no clock.
 *
 * WHY. The zone slice could be extracted and proved because its inputs were
 * stored: 140 captured scans, each replayed and compared field-by-field against
 * what production actually recorded. Every other stage — direction, confluence,
 * safety gates, portfolio, ICT, risk, session/news — has no stored inputs, so
 * that proof is impossible and extracting them would mean shipping unverified
 * strategy code.
 *
 * This builds the row that closes the gap. It records INPUTS, plus the handful
 * of outputs `scan_logs.details_json` never carried. Outputs that detail
 * already has are deliberately not duplicated: a second copy is a second thing
 * that can disagree with the first.
 *
 * HOW IT IS USED. The caller creates one capture per symbol at the top of the
 * pair loop, pushes it once, and then MUTATES it as stages run. Because it is
 * held by reference, the 24 different exit paths through that loop need no
 * changes — a pair that skips at `no_direction` simply has fewer stages filled
 * in, which is itself the funnel data. Nothing here can throw into a decision:
 * every method is an assignment.
 */

export const DECISION_CAPTURE_CONTRACT = "smc-zone-impulse-control-v1";

/** How far the pair got. Ordered; later values imply the earlier ones ran. */
export type ReachedStage =
  | "unsupported" | "session_skipped" | "market_closed" | "insufficient_data"
  | "direction" | "confluence" | "zone" | "ict" | "gates" | "portfolio" | "final";

export interface DecisionCapture {
  scan_cycle_id: string;
  user_id: string;
  bot_id: string;
  symbol: string;
  style: string | null;
  reached_stage: ReachedStage;

  direction_input: unknown;
  confluence_input: unknown;
  gates_input: unknown;
  portfolio_input: unknown;
  ict_input: unknown;
  risk_input: unknown;
  session_news_input: unknown;

  cascade_input: unknown;

  gates_output: unknown;
  portfolio_output: unknown;
  cascade_output: unknown;
  final_decision: unknown;

  contract_version: string;
}

export function newCapture(
  scanCycleId: string, userId: string, botId: string, symbol: string, style: string | null,
): DecisionCapture {
  return {
    scan_cycle_id: scanCycleId, user_id: userId, bot_id: botId, symbol, style,
    reached_stage: "unsupported",
    direction_input: null, confluence_input: null, gates_input: null,
    portfolio_input: null, ict_input: null, risk_input: null, session_news_input: null,
    cascade_input: null,
    gates_output: null, portfolio_output: null, cascade_output: null, final_decision: null,
    contract_version: DECISION_CAPTURE_CONTRACT,
  };
}

/**
 * Digest over an arbitrary structure, key-order independent.
 *
 * Same construction the zone snapshot uses. Non-cryptographic on purpose: this
 * is tamper-evidence inside one project's own tables, not a security token, and
 * staying synchronous keeps the module pure.
 */
export function hashPart(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) {
        if (typeof o[k] === "function" || o[k] === undefined) continue;
        out[k] = norm(o[k]);
      }
      return out;
    }
    if (typeof v === "number" && Object.is(v, -0)) return 0;
    return v;
  };
  let s: string;
  try {
    s = JSON.stringify(norm(value)) ?? "null";
  } catch {
    return "unhashable";          // a cycle is a caller bug, not a crash here
  }
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + s.charCodeAt(i) + 1, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/**
 * Trim an open-position list to the fields that reach a decision.
 *
 * Positions carry broker ids, timestamps and audit columns that change between
 * scans without changing any outcome; storing them whole would make every
 * digest differ for reasons that are not decisions. Sorted by position_id so
 * row order from the database cannot alter the digest.
 */
export function slimPositions(rows: unknown[]): unknown[] {
  return (rows ?? []).map((r) => {
    const p = r as Record<string, unknown>;
    return {
      position_id: p.position_id ?? null,
      symbol: p.symbol ?? null,
      direction: p.direction ?? null,
      size: p.size ?? null,
      entry_price: p.entry_price ?? null,
      stop_loss: p.stop_loss ?? null,
      take_profit: p.take_profit ?? null,
      position_status: p.position_status ?? null,
      bot_id: p.bot_id ?? null,
    };
  }).sort((a, b) => String(a.position_id).localeCompare(String(b.position_id)));
}

/**
 * Strip the bulky arrays production injects into pairConfig before scoring.
 *
 * `_htfFibLevels`, `_htfPD`, `_htfLiquidityPools` and `_h4Candles` are attached
 * to the config object as a transport mechanism. The liquidity pools are
 * already stored verbatim on smc_scan_context and the rest are derivable from
 * snapshotted bars, so keeping them here would multiply the row size for a
 * second copy that can disagree. Each is replaced by its digest, which is
 * enough to prove a replay rebuilt the same thing.
 */
export function sanitizeConfigForCapture(cfg: unknown): Record<string, unknown> {
  const c = { ...(cfg as Record<string, unknown>) };
  const out: Record<string, unknown> = {};
  // `_structureCandles` is a 300-bar array and `_h4Candles` another — both are
  // already snapshotted as bars, so storing them inline would multiply the row
  // for a second copy. `_fotsiResult` and `_smtResult` are deliberately NOT
  // here: they are small, market-derived, and nothing else records them, so a
  // replay of confluence needs them kept in full.
  const heavy = [
    "_htfFibLevels", "_htfPD", "_htfLiquidityPools",
    "_h4Candles", "_structureCandles", "_fotsi",
  ];
  for (const k of heavy) {
    if (k in c) { out[`${k}__hash`] = hashPart(c[k]); delete c[k]; }
  }
  // Functions and undefined never survive jsonb; drop them here so the stored
  // value and the hashed value are the same thing.
  for (const [k, v] of Object.entries(c)) {
    if (typeof v === "function" || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/** The row written to `smc_scan_decision`, digests included. */
export function toRow(c: DecisionCapture): Record<string, unknown> {
  return {
    scan_cycle_id: c.scan_cycle_id,
    user_id: c.user_id,
    bot_id: c.bot_id,
    symbol: c.symbol,
    style: c.style,
    reached_stage: c.reached_stage,

    direction_input: c.direction_input,
    confluence_input: c.confluence_input,
    gates_input: c.gates_input,
    portfolio_input: c.portfolio_input,
    ict_input: c.ict_input,
    risk_input: c.risk_input,
    session_news_input: c.session_news_input,
    cascade_input: c.cascade_input,

    gates_output: c.gates_output,
    portfolio_output: c.portfolio_output,
    cascade_output: c.cascade_output,
    final_decision: c.final_decision,

    direction_hash: hashPart(c.direction_input),
    confluence_hash: hashPart(c.confluence_input),
    gates_hash: hashPart(c.gates_input),
    portfolio_hash: hashPart(c.portfolio_input),
    ict_hash: hashPart(c.ict_input),
    risk_hash: hashPart(c.risk_input),
    session_news_hash: hashPart(c.session_news_input),
    // The two outputs `detail` never carried get their own digests — the input
    // hashes above cover the inputs only, and an artefact with no digest is the
    // one thing in this corpus a replay could not detect drift in.
    gates_output_hash: hashPart(c.gates_output),
    portfolio_output_hash: hashPart(c.portfolio_output),
    cascade_input_hash: hashPart(c.cascade_input),
    cascade_output_hash: hashPart(c.cascade_output),
    final_hash: hashPart(c.final_decision),

    contract_version: c.contract_version,
  };
}

/**
 * Which stages a row can actually support an extraction-parity proof for.
 *
 * A stage is ready only when its inputs were recorded AND the pair got far
 * enough for them to be meaningful. Used by the readiness matrix so "ready" is
 * a measured property of the corpus rather than an assertion.
 */
export function readiness(row: Record<string, unknown>): Record<string, boolean> {
  const has = (k: string) => row[k] !== null && row[k] !== undefined;
  return {
    direction: has("direction_input") && has("direction_hash"),
    confluence: has("confluence_input") && has("confluence_hash"),
    gates: has("gates_input") && has("gates_output"),
    portfolio: has("portfolio_input") && has("portfolio_output"),
    ict: has("ict_input"),
    risk: has("risk_input"),
    session_news: has("session_news_input"),
    // Cascade only runs for swing_trader. Under scalper this is always false,
    // and that is a true statement about the corpus rather than a defect.
    cascade: has("cascade_input") && has("cascade_output"),
    final: has("final_decision"),
  };
}
