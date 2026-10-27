// The OFF / SHADOW / ON switch rules (owner decisions 2026-10-26). PURE — the structure-mode function does the I/O.
//
//   OFF ↔ SHADOW: always allowed (SHADOW changes no trade, so no new cohort: the value lives outside config_json).
//   → ON: only when ON exists (step 4 deployed: ON_AVAILABLE) AND the unlock rule is met:
//         ≥ 7 days continuously in SHADOW, OR ≥ 5 shadow setups the owner marked "looks right";
//         AND the plumbing is clean since SHADOW began (no V3 state repaint, no hour still missing 3 h later, no shadow mismatch /
//         error rows). Late-arriving hours are not missed hours.
//   ON → OFF / SHADOW: always allowed.
export type Mode = "OFF" | "SHADOW" | "ON";
export const MODES: readonly Mode[] = ["OFF", "SHADOW", "ON"];
/** Step 3 ships the switch with ON visible but unavailable; step 4 (ON wiring in the scanner) flips this. */
export const ON_AVAILABLE = false;
export const UNLOCK_DAYS = 7, UNLOCK_RIGHT = 5;

export interface UnlockInput { mode: Mode; setAtMs: number; nowMs: number; rightCount: number; v3AuditSince: number; shadowAuditSince: number; onAvailable?: boolean }
export interface Unlock { met: boolean; onAvailable: boolean; daysInShadow: number; right: number; plumbingClean: boolean; reason: string }

export function evaluateUnlock(u: UnlockInput): Unlock {
  const onAvailable = u.onAvailable ?? ON_AVAILABLE;
  const inShadow = u.mode === "SHADOW" || u.mode === "ON";
  const daysInShadow = inShadow ? Math.max(0, (u.nowMs - u.setAtMs) / 86_400_000) : 0;
  const plumbingClean = u.v3AuditSince === 0 && u.shadowAuditSince === 0;
  const evidence = daysInShadow >= UNLOCK_DAYS || u.rightCount >= UNLOCK_RIGHT;
  const met = inShadow && evidence && plumbingClean;
  const reason = !onAvailable ? "ON is being built (step 4)"
    : !inShadow ? "turn on SHADOW first"
    : !plumbingClean ? `plumbing not clean since SHADOW began (${u.v3AuditSince} V3 repaints / missed hours + ${u.shadowAuditSince} shadow audit events)`
    : !evidence ? `unlocks after ${UNLOCK_DAYS} days in SHADOW (${daysInShadow.toFixed(1)} so far) or ${UNLOCK_RIGHT} setups marked ✓ (${u.rightCount} so far)`
    : "unlocked";
  return { met, onAvailable, daysInShadow: +daysInShadow.toFixed(2), right: u.rightCount, plumbingClean, reason };
}

export function checkTransition(from: Mode, to: Mode, unlock: Unlock): { ok: true } | { ok: false; reason: string } {
  if (!MODES.includes(to)) return { ok: false, reason: `unknown mode ${to}` };
  if (from === to) return { ok: false, reason: `already ${to}` };
  if (to !== "ON") return { ok: true };
  if (!unlock.onAvailable || !unlock.met) return { ok: false, reason: unlock.reason };
  return { ok: true };
}

export interface ShadowSummary { placed: number; filled: number; wins: number; losses: number; open: number; voided: number; cancelled: number; netR: number }
/** Counts from shadow events (any cohort of the current SHADOW period). */
export function summarize(events: { order_id: string; type: string; payload: { net?: number; result?: string } }[]): ShadowSummary {
  const s: ShadowSummary = { placed: 0, filled: 0, wins: 0, losses: 0, open: 0, voided: 0, cancelled: 0, netR: 0 };
  const filled = new Set<string>(), closed = new Set<string>();
  for (const e of events) {
    if (e.type === "placed") s.placed++;
    else if (e.type === "filled") { s.filled++; filled.add(e.order_id); }
    else if (e.type === "closed") { closed.add(e.order_id); if (e.payload.result === "TP") s.wins++; else s.losses++; s.netR += Number(e.payload.net ?? 0); }
    else if (e.type === "voided") { s.voided++; closed.add(e.order_id); }
    else if (e.type === "cancelled") s.cancelled++;
  }
  for (const id of filled) if (!closed.has(id)) s.open++;
  s.netR = +s.netR.toFixed(2);
  return s;
}
