/**
 * reconcileBrokerState.ts — Broker-Authoritative Reconciliation
 * ══════════════════════════════════════════════════════════════
 * Single broker-writer: only bot-scanner's manage cycle calls this.
 * Paper-trading is read-only (no broker pushes).
 *
 * Design:
 *   1. Batch-fetch broker positions ONCE per connection (not per position)
 *   2. Compare DB's intended SL/TP vs broker's actual SL/TP
 *   3. If mismatch: attempt to push DB's intended value to broker
 *   4. Read back broker's ACTUAL confirmed value → write to DB (broker is authoritative)
 *   5. Track consecutive mismatch cycles in-memory (Map keyed by position_id)
 *   6. At 5+ consecutive cycles: fire Telegram alert (informational, does NOT gate correction)
 *
 * No new DB tables. No new columns. Lightweight, efficient.
 */

import { SPECS, normalizeSymKey } from "./smcAnalysis.ts";
import { resolveSymbol } from "./brokerSymbols.ts";
import { metaFetch } from "./metaApiClient.ts";

// ─── Types ──────────────────────────────────────────────────────────────
export interface ReconcilePosition {
  id: string;             // paper_positions.id (UUID)
  position_id: string;    // paper_positions.position_id (our internal ID)
  symbol: string;
  direction: "long" | "short";
  stop_loss: number | null;
  take_profit: number | null;
  mirrored_connection_ids: string[];
}

export interface BrokerConnection {
  id: string;
  account_id: string;
  api_key: string;
  broker_type: string;
  display_name: string;
  symbol_suffix?: string;
  symbol_overrides?: Record<string, string>;
  is_active: boolean;
}

export interface ReconcileResult {
  positionId: string;
  symbol: string;
  status: "synced" | "corrected" | "rejected" | "not_found" | "error";
  intendedSL?: number;
  brokerSL?: number;
  detail?: string;
}

export interface ReconcileOptions {
  supabase: any;
  userId: string;
  positions: ReconcilePosition[];
  connections: BrokerConnection[];
  telegramChatIds: string[];
  shouldNotify: (category: string) => boolean;
  scanCycleId?: string;
}

// ─── In-Memory Mismatch Tracker ─────────────────────────────────────────
// Keyed by position_id. Resets to 0 when broker confirms match.
// Acceptable to lose on function cold-start (edge function lifecycle).
const mismatchCycles = new Map<string, number>();
const alertedPositions = new Set<string>(); // Only alert once per position

// metaFetch is now imported from ./metaApiClient.ts (single source of truth)
// resolveSymbol is now imported from ./brokerSymbols.ts (single source of truth)

// ─── Core Reconciliation ────────────────────────────────────────────────
export async function reconcileBrokerState(opts: ReconcileOptions): Promise<ReconcileResult[]> {
  const { supabase, userId, positions, connections, telegramChatIds, shouldNotify, scanCycleId } = opts;
  const results: ReconcileResult[] = [];

  if (positions.length === 0 || connections.length === 0) return results;

  // Group positions by which connections they're mirrored to
  // Then batch-fetch broker positions ONCE per connection
  const connPositionMap = new Map<string, ReconcilePosition[]>();
  for (const pos of positions) {
    for (const connId of pos.mirrored_connection_ids) {
      if (!connPositionMap.has(connId)) connPositionMap.set(connId, []);
      connPositionMap.get(connId)!.push(pos);
    }
  }

  for (const [connId, positionsForConn] of connPositionMap) {
    const conn = connections.find(c => c.id === connId);
    if (!conn || conn.broker_type !== "metaapi") continue;

    // Resolve auth credentials (handle swapped fields)
    let authToken = conn.api_key;
    let metaAccountId = conn.account_id;
    if (metaAccountId.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
      authToken = conn.account_id;
      metaAccountId = conn.api_key;
    }

    // ── Batch fetch all broker positions for this connection ──
    let brokerPositions: any[];
    try {
      const { res, body } = await metaFetch(metaAccountId, authToken, (base) => `${base}/positions`);
      if (!res.ok) {
        console.warn(`[reconcile] ${conn.display_name}: positions fetch failed ${res.status}`);
        for (const pos of positionsForConn) {
          results.push({ positionId: pos.position_id, symbol: pos.symbol, status: "error", detail: `fetch failed ${res.status}` });
        }
        continue;
      }
      brokerPositions = JSON.parse(body);
    } catch (e: any) {
      console.warn(`[reconcile] ${conn.display_name}: positions fetch error: ${e?.message}`);
      for (const pos of positionsForConn) {
        results.push({ positionId: pos.position_id, symbol: pos.symbol, status: "error", detail: e?.message });
      }
      continue;
    }

    // ── For each position, find its broker counterpart and reconcile ──
    for (const pos of positionsForConn) {
      try {
        // Match by comment tag (B1 safety: no symbol+direction fallback)
        const commentTag = `paper:${pos.position_id}`;
        const shortTag = commentTag.slice(0, 28);
        const brokerPos = brokerPositions.find((p: any) =>
          p.comment && (p.comment.includes(commentTag) || p.comment.startsWith(shortTag))
        );

        if (!brokerPos) {
          results.push({ positionId: pos.position_id, symbol: pos.symbol, status: "not_found", detail: "no comment-tag match" });
          continue;
        }

        // Read broker's actual SL
        const brokerSL = brokerPos.stopLoss ?? null;
        const brokerTP = brokerPos.takeProfit ?? null;
        const intendedSL = pos.stop_loss;

        // Check if SL matches (within tolerance of 0.5 pips to avoid float noise)
        const spec = SPECS[pos.symbol] || SPECS["EUR/USD"];
        const tolerance = spec.pipSize * 0.5;
        const slMatches = intendedSL === null && brokerSL === null ||
          (intendedSL !== null && brokerSL !== null && Math.abs(intendedSL - brokerSL) <= tolerance);

        if (slMatches) {
          // In sync — reset mismatch counter
          mismatchCycles.set(pos.position_id, 0);
          results.push({ positionId: pos.position_id, symbol: pos.symbol, status: "synced", intendedSL: intendedSL ?? undefined, brokerSL: brokerSL ?? undefined });
          continue;
        }

        // ── Mismatch detected: attempt to push intended SL to broker ──
        const safetyBuffer = spec.pipSize; // 1 pip safety buffer
        const adjustedSL = intendedSL !== null
          ? (pos.direction === "long" ? intendedSL - safetyBuffer : intendedSL + safetyBuffer)
          : null;

        // Freeze-level guard: check if SL is too close to current price
        let finalSL = adjustedSL;
        if (finalSL !== null && brokerPos.currentPrice) {
          const relevantPrice = pos.direction === "long"
            ? (brokerPos.currentPrice - (brokerPos.currentPrice - (brokerPos.profit >= 0 ? brokerPos.openPrice : brokerPos.currentPrice)) * 0) // Use currentPrice as bid approximation
            : brokerPos.currentPrice;
          const minSLDistance = spec.pipSize * 3;
          const slDistance = pos.direction === "long"
            ? relevantPrice - finalSL
            : finalSL - relevantPrice;
          if (slDistance < minSLDistance && slDistance >= 0) {
            finalSL = pos.direction === "long"
              ? relevantPrice - minSLDistance
              : relevantPrice + minSLDistance;
            const precision = spec.pipSize < 0.01 ? 5 : spec.pipSize < 1 ? 3 : 1;
            finalSL = parseFloat(finalSL!.toFixed(precision));
          }
        }

        // Attempt modify
        let pushSuccess = false;
        let confirmedBrokerSL = brokerSL; // Default: keep broker's current value

        if (finalSL !== null) {
          const modifyBody: any = {
            actionType: "POSITION_MODIFY",
            positionId: brokerPos.id,
            stopLoss: finalSL,
          };
          // Include TP to prevent broker from dropping it
          if (pos.take_profit != null && pos.take_profit > 0) {
            modifyBody.takeProfit = pos.take_profit;
          }

          const { res, body: resBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/trade`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(modifyBody),
          });

          if (res.ok) {
            let modParsed: any = null;
            try { modParsed = JSON.parse(resBody); } catch {}
            if (modParsed?.stringCode && modParsed.stringCode !== "TRADE_RETCODE_DONE" && modParsed.stringCode !== "ERR_NO_ERROR") {
              // Broker rejected the modify
              console.warn(`[reconcile] ${conn.display_name}: SL modify REJECTED — ${modParsed.stringCode}: ${modParsed.message || ""} | ${pos.symbol} SL→${finalSL}`);
              pushSuccess = false;
              confirmedBrokerSL = brokerSL; // Broker didn't change
            } else {
              pushSuccess = true;
              confirmedBrokerSL = finalSL; // Broker accepted
              console.log(`[reconcile] ${conn.display_name}: SL synced to ${finalSL} for ${pos.symbol} (${pos.position_id})`);
            }
          } else {
            console.warn(`[reconcile] ${conn.display_name}: SL modify failed [${res.status}]: ${resBody.slice(0, 200)}`);
            pushSuccess = false;
            confirmedBrokerSL = brokerSL;
          }
        }

        // ── Broker-authoritative: write broker's ACTUAL value back to DB ──
        if (confirmedBrokerSL !== null && confirmedBrokerSL !== intendedSL) {
          // DB must reflect what broker actually has
          await supabase.from("paper_positions")
            .update({ stop_loss: confirmedBrokerSL.toString() })
            .eq("id", pos.id);
          console.log(`[reconcile] DB corrected: ${pos.symbol} (${pos.position_id}) SL → ${confirmedBrokerSL} (broker-authoritative)`);
        }

        // ── Track mismatch cycles ──
        if (!pushSuccess) {
          const count = (mismatchCycles.get(pos.position_id) || 0) + 1;
          mismatchCycles.set(pos.position_id, count);

          // Alert at 5+ consecutive mismatches (once per position)
          if (count >= 5 && !alertedPositions.has(pos.position_id)) {
            alertedPositions.add(pos.position_id);
            if (telegramChatIds.length > 0 && shouldNotify("trade_management")) {
              const alertMsg = `⚠️ <b>Broker Sync Alert</b>\n\n` +
                `<b>Symbol:</b> ${pos.symbol}\n` +
                `<b>Position:</b> ${pos.position_id}\n` +
                `<b>Issue:</b> ${count} consecutive SL sync failures\n` +
                `<b>DB SL:</b> ${intendedSL?.toFixed(5) ?? "null"}\n` +
                `<b>Broker SL:</b> ${brokerSL?.toFixed(5) ?? "null"}\n` +
                `<b>Status:</b> Correction still running — broker value written to DB`;
              const supabaseUrl = Deno.env.get("SUPABASE_URL");
              const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
              for (const chatId of telegramChatIds) {
                try {
                  await fetch(`${supabaseUrl}/functions/v1/telegram-notify`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
                    body: JSON.stringify({ chat_id: chatId, message: alertMsg }),
                  });
                } catch {}
              }
            }
            console.warn(`[reconcile] ALERT: ${pos.symbol} (${pos.position_id}) — ${count} consecutive SL mismatches`);
          }

          results.push({
            positionId: pos.position_id, symbol: pos.symbol, status: "rejected",
            intendedSL: intendedSL ?? undefined, brokerSL: confirmedBrokerSL ?? undefined,
            detail: `mismatch cycle ${count}`,
          });
        } else {
          mismatchCycles.set(pos.position_id, 0);
          results.push({
            positionId: pos.position_id, symbol: pos.symbol, status: "corrected",
            intendedSL: intendedSL ?? undefined, brokerSL: confirmedBrokerSL ?? undefined,
          });
        }
      } catch (e: any) {
        results.push({ positionId: pos.position_id, symbol: pos.symbol, status: "error", detail: e?.message });
      }
    }
  }

  if (results.length > 0) {
    const synced = results.filter(r => r.status === "synced").length;
    const corrected = results.filter(r => r.status === "corrected").length;
    const rejected = results.filter(r => r.status === "rejected").length;
    const notFound = results.filter(r => r.status === "not_found").length;
    const errors = results.filter(r => r.status === "error").length;
    console.log(`[reconcile ${scanCycleId || "?"}] Results: ${synced} synced, ${corrected} corrected, ${rejected} rejected, ${notFound} not_found, ${errors} errors`);
  }

  return results;
}

// ─── Partial Close Reconciliation ───────────────────────────────────────
// Executes partial close on broker for positions that scannerManagement flagged.
// This replaces the fire-and-forget partial close block in bot-scanner.
export async function reconcilePartialClose(opts: {
  supabase: any;
  positions: ReconcilePosition[];
  connections: BrokerConnection[];
  partialActions: Array<{ positionId: string; symbol: string; closeFraction: number; direction: "long" | "short" }>;
}): Promise<void> {
  const { supabase, positions, connections, partialActions } = opts;
  if (partialActions.length === 0) return;

  for (const action of partialActions) {
    const pos = positions.find(p => p.position_id === action.positionId);
    if (!pos) continue;

    // B2 safety: skip if no mirrored connections
    if (pos.mirrored_connection_ids.length === 0) {
      console.warn(`[reconcile-partial] ${action.symbol} (${action.positionId}): no mirrored_connection_ids — skipping`);
      continue;
    }

    const connsToClose = connections.filter(c => pos.mirrored_connection_ids.includes(c.id) && c.broker_type === "metaapi");

    for (const conn of connsToClose) {
      try {
        let authToken = conn.api_key;
        let metaAccountId = conn.account_id;
        if (metaAccountId.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
          authToken = conn.account_id;
          metaAccountId = conn.api_key;
        }

        const { res: posRes, body: posBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/positions`);
        if (!posRes.ok) { console.warn(`[reconcile-partial] ${conn.display_name}: positions fetch failed`); continue; }
        const brokerPositions: any[] = JSON.parse(posBody);

        // Match by comment tag
        const commentTag = `paper:${action.positionId}`;
        const shortTag = commentTag.slice(0, 28);
        let brokerPos = brokerPositions.find((p: any) =>
          p.comment && (p.comment.includes(commentTag) || p.comment.startsWith(shortTag))
        );

        // Fallback: symbol+direction match (acceptable for partial close since it's less dangerous than SL modify)
        if (!brokerPos) {
          const brokerSymbol = resolveSymbol(action.symbol, conn);
          brokerPos = brokerPositions.find((p: any) =>
            (p.symbol === brokerSymbol || p.symbol === action.symbol.replace("/", "") ||
             p.symbol?.replace(/[._\-]/g, "").toUpperCase() === action.symbol.replace("/", "").toUpperCase()) &&
            ((p.type === "POSITION_TYPE_BUY" && action.direction === "long") ||
             (p.type === "POSITION_TYPE_SELL" && action.direction === "short"))
          );
        }

        if (!brokerPos) { console.warn(`[reconcile-partial] ${conn.display_name}: position not found for ${action.symbol}`); continue; }

        const brokerVolume = brokerPos.volume || brokerPos.currentVolume || 0;
        const closeVolume = Math.max(0.01, Math.round(brokerVolume * action.closeFraction * 100) / 100);

        const { res, body: resBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/trade`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actionType: "POSITION_CLOSE_ID", positionId: brokerPos.id, volume: closeVolume }),
        });

        if (res.ok) {
          console.log(`[reconcile-partial] ${conn.display_name}: partial close ${closeVolume} lots for ${action.symbol}`);
        } else {
          console.warn(`[reconcile-partial] ${conn.display_name}: partial close failed [${res.status}]: ${resBody.slice(0, 200)}`);
        }
      } catch (e: any) {
        console.warn(`[reconcile-partial] ${conn.display_name}: error: ${e?.message}`);
      }
    }
  }
}

// ─── Test Helpers (exported for unit tests only) ────────────────────────
export const _testHelpers = {
  getMismatchCycles: () => mismatchCycles,
  getAlertedPositions: () => alertedPositions,
  resetState: () => { mismatchCycles.clear(); alertedPositions.clear(); },
};
