import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

// ─── Yahoo Finance Symbol Mapping ───────────────────────────────────
const YAHOO_SYMBOLS: Record<string, string> = {
  "EUR/USD": "EURUSD=X", "GBP/USD": "GBPUSD=X", "USD/JPY": "USDJPY=X",
  "GBP/JPY": "GBPJPY=X", "AUD/USD": "AUDUSD=X", "USD/CAD": "USDCAD=X",
  "EUR/GBP": "EURGBP=X", "NZD/USD": "NZDUSD=X", "USD/CHF": "USDCHF=X",
  "EUR/JPY": "EURJPY=X", "BTC/USD": "BTC-USD", "ETH/USD": "ETH-USD",
  "XAU/USD": "GC=F", "XAG/USD": "SI=F",
};

async function fetchLivePrice(symbol: string): Promise<number | null> {
  const yahooSymbol = YAHOO_SYMBOLS[symbol];
  if (!yahooSymbol) return null;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "SMC-Trading-Dashboard/1.0" } });
    const data = await res.json();
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return price ? Number(price) : null;
  } catch {
    return null;
  }
}

async function updatePositionPrices(supabase: any, positions: any[]): Promise<void> {
  if (!positions || positions.length === 0) return;
  const symbols = [...new Set(positions.map((p: any) => p.symbol))];
  const priceMap: Record<string, number> = {};
  await Promise.all(symbols.map(async (sym) => {
    const price = await fetchLivePrice(sym);
    if (price !== null) priceMap[sym] = price;
  }));
  await Promise.all(positions.map(async (p: any) => {
    const livePrice = priceMap[p.symbol];
    if (livePrice !== undefined) {
      await supabase.from("paper_positions").update({ current_price: livePrice.toString() }).eq("id", p.id);
    }
  }));
}

// ─── Instrument Specs ───────────────────────────────────────────────
const SPECS: Record<string, { pipSize: number; lotUnits: number; marginPerLot: number }> = {
  "EUR/USD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1000 },
  "GBP/USD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1000 },
  "USD/JPY": { pipSize: 0.01, lotUnits: 100000, marginPerLot: 1000 },
  "GBP/JPY": { pipSize: 0.01, lotUnits: 100000, marginPerLot: 1500 },
  "AUD/USD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 800 },
  "USD/CAD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1000 },
  "EUR/GBP": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1200 },
  "NZD/USD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 700 },
  "USD/CHF": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1000 },
  "EUR/JPY": { pipSize: 0.01, lotUnits: 100000, marginPerLot: 1200 },
  "BTC/USD": { pipSize: 1, lotUnits: 1, marginPerLot: 5000 },
  "ETH/USD": { pipSize: 0.01, lotUnits: 1, marginPerLot: 1000 },
  "XAU/USD": { pipSize: 0.01, lotUnits: 100, marginPerLot: 2000 },
  "XAG/USD": { pipSize: 0.001, lotUnits: 5000, marginPerLot: 1500 },
};

function calcPnl(dir: string, entry: number, current: number, size: number, symbol: string) {
  const spec = SPECS[symbol] || SPECS["EUR/USD"];
  const diff = dir === "long" ? current - entry : entry - current;
  return { pnl: diff * spec.lotUnits * size, pnlPips: diff / spec.pipSize };
}

// ─── MT5 Mirror Helper ──────────────────────────────────────────────
async function mirrorToMT5(supabase: any, userId: string, params: {
  action: "open" | "close";
  symbol: string;
  direction?: string;
  size?: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  positionId?: string;
}): Promise<{ success: boolean; mt5Result?: any; error?: string }> {
  try {
    // Find active metaapi broker connection
    const { data: connections } = await supabase.from("broker_connections")
      .select("*").eq("user_id", userId).eq("broker_type", "metaapi").eq("is_active", true);
    if (!connections || connections.length === 0) return { success: false, error: "no_connection" };
    const conn = connections[0];

    const baseUrl = `https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${conn.account_id}`;
    const headers: Record<string, string> = { "auth-token": conn.api_key, "Content-Type": "application/json" };

    if (params.action === "open") {
      const body: any = {
        actionType: params.direction === "long" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
        symbol: params.symbol.replace("/", ""),
        volume: params.size,
      };
      if (params.stopLoss) body.stopLoss = params.stopLoss;
      if (params.takeProfit) body.takeProfit = params.takeProfit;
      if (params.positionId) body.comment = `paper:${params.positionId}`;

      const res = await fetch(`${baseUrl}/trade`, { method: "POST", headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const errText = await res.text();
        console.error(`MT5 mirror open failed [${res.status}]: ${errText}`);
        return { success: false, error: `MT5 order failed: ${res.status}` };
      }
      return { success: true, mt5Result: await res.json() };
    }

    if (params.action === "close") {
      // Find MT5 position by comment matching paper position ID
      const posRes = await fetch(`${baseUrl}/positions`, { headers });
      if (!posRes.ok) return { success: false, error: `MT5 positions fetch failed: ${posRes.status}` };
      const mt5Positions = await posRes.json();
      const mt5Pos = mt5Positions.find((p: any) =>
        p.comment?.includes(`paper:${params.positionId}`) ||
        p.symbol === params.symbol?.replace("/", "")
      );
      if (!mt5Pos) return { success: false, error: "MT5 position not found" };

      const closeBody = { actionType: "POSITION_CLOSE_ID", positionId: mt5Pos.id };
      const res = await fetch(`${baseUrl}/trade`, { method: "POST", headers, body: JSON.stringify(closeBody) });
      if (!res.ok) return { success: false, error: `MT5 close failed: ${res.status}` };
      return { success: true, mt5Result: await res.json() };
    }

    return { success: false, error: "unknown action" };
  } catch (e: any) {
    console.error("MT5 mirror error:", e.message);
    return { success: false, error: e.message };
  }
}

// ─── Post-Mortem Generation ─────────────────────────────────────────
function generatePostMortem(
  position: any, exitPrice: number, pnl: number, pnlPips: number, closeReason: string,
): any {
  const entryPrice = parseFloat(position.entry_price);
  const signalScore = parseFloat(position.signal_score || "0");
  const signalReason = position.signal_reason || "";
  const openTime = position.open_time;
  const closedAt = new Date().toISOString();

  // Determine outcome
  const outcome = pnl > 0 ? "Win" : pnl < 0 ? "Loss" : "Breakeven";

  // Parse factors from signal reason
  const factorNames = [
    "Market Structure", "Order Block", "Fair Value Gap", "Premium/Discount",
    "Session/Kill Zone", "Judas Swing", "PD/PW Levels", "Reversal Candle", "Liquidity Sweep",
  ];
  const presentFactors = factorNames.filter(f => signalReason.includes(f));
  const absentFactors = factorNames.filter(f => !signalReason.includes(f));

  // Calculate hold duration
  let holdDuration = "Unknown";
  try {
    const openMs = new Date(openTime).getTime();
    const closeMs = new Date(closedAt).getTime();
    const diffMs = closeMs - openMs;
    const hours = Math.floor(diffMs / 3600000);
    const minutes = Math.floor((diffMs % 3600000) / 60000);
    holdDuration = `${hours}h ${minutes}m`;
  } catch {}

  // Generate insights
  let whatWorked = "";
  let whatFailed = "";
  let lessonLearned = "";

  if (outcome === "Win") {
    whatWorked = presentFactors.length > 0
      ? `Confluence factors aligned correctly: ${presentFactors.join(", ")}`
      : "Trade direction was correct";
    whatFailed = absentFactors.length > 0
      ? `Not all factors were present: missing ${absentFactors.join(", ")}`
      : "All factors aligned — textbook setup";
    lessonLearned = signalScore >= 7
      ? "High-confluence setup played out as expected. Continue targeting similar setups."
      : "Trade won despite moderate confluence. Consider if the setup was fortunate or skill-based.";
  } else if (outcome === "Loss") {
    whatWorked = presentFactors.length > 0
      ? `These factors were correctly identified: ${presentFactors.join(", ")}`
      : "Signal was generated but lacked strong confluence";
    whatFailed = closeReason === "sl_hit"
      ? "Stop loss was hit — market structure changed after entry or SL was too tight"
      : `Trade closed with loss: ${closeReason}`;
    lessonLearned = signalScore < 7
      ? `Confluence score was ${signalScore}/10. Consider raising minimum threshold to reduce weak signals.`
      : "Setup had good confluence but market conditions shifted. Review if HTF bias was truly aligned.";
  } else {
    whatWorked = "Trade reached breakeven — partial validation of the setup";
    whatFailed = "Insufficient momentum for follow-through to TP";
    lessonLearned = "Consider tighter entry timing or wider TP targets for similar setups.";
  }

  return {
    outcome,
    pnl,
    pnlPips,
    holdDuration,
    exitReason: closeReason,
    confluenceScore: signalScore,
    factorsPresent: presentFactors,
    factorsAbsent: absentFactors,
    whatWorked,
    whatFailed,
    lessonLearned,
    entryPrice,
    exitPrice,
    direction: position.direction,
    symbol: position.symbol,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization");

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) throw new Error("Unauthorized");

    const { action, ...payload } = await req.json();

    // ── Get account state ──
    if (action === "status") {
      const { data: account } = await supabase.from("paper_accounts").select("*").eq("user_id", user.id).maybeSingle();
      let { data: positions } = await supabase.from("paper_positions").select("*").eq("user_id", user.id).eq("position_status", "open");
      // Update current prices from live market data
      if (positions && positions.length > 0) {
        await updatePositionPrices(supabase, positions);
        // Re-fetch with updated prices
        const { data: refreshed } = await supabase.from("paper_positions").select("*").eq("user_id", user.id).eq("position_status", "open");
        positions = refreshed || positions;
      }
      const { data: pending } = await supabase.from("paper_positions").select("*").eq("user_id", user.id).eq("position_status", "pending");
      const { data: history } = await supabase.from("paper_trade_history").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(50);

      const balance = parseFloat(account?.balance || "10000");
      const peakBalance = parseFloat(account?.peak_balance || "10000");
      const posArr = (positions || []).map((p: any) => ({
        id: p.position_id, symbol: p.symbol, direction: p.direction,
        size: parseFloat(p.size), entryPrice: parseFloat(p.entry_price),
        currentPrice: parseFloat(p.current_price),
        pnl: calcPnl(p.direction, parseFloat(p.entry_price), parseFloat(p.current_price), parseFloat(p.size), p.symbol).pnl,
        stopLoss: p.stop_loss ? parseFloat(p.stop_loss) : null,
        takeProfit: p.take_profit ? parseFloat(p.take_profit) : null,
        openTime: p.open_time, signalReason: p.signal_reason || "",
        signalScore: parseFloat(p.signal_score || "0"), orderId: p.order_id,
      }));
      const unrealizedPnl = posArr.reduce((s: number, p: any) => s + p.pnl, 0);
      const histArr = (history || []).map((t: any) => ({
        id: t.position_id, symbol: t.symbol, direction: t.direction,
        size: parseFloat(t.size), entryPrice: parseFloat(t.entry_price),
        exitPrice: parseFloat(t.exit_price), pnl: parseFloat(t.pnl),
        pnlPips: parseFloat(t.pnl_pips), openTime: t.open_time,
        closedAt: t.closed_at, closeReason: t.close_reason,
        signalReason: t.signal_reason || "", signalScore: parseFloat(t.signal_score || "0"),
        orderId: t.order_id,
      }));
      const wins = histArr.filter((t: any) => t.pnl > 0).length;
      const losses = histArr.filter((t: any) => t.pnl <= 0).length;
      const drawdown = peakBalance > 0 ? ((peakBalance - balance) / peakBalance) * 100 : 0;

      // Compute daily P&L from today's closed trades
      const todayStr = new Date().toISOString().split("T")[0];
      const dailyPnl = histArr
        .filter((t: any) => t.closedAt?.startsWith(todayStr))
        .reduce((s: number, t: any) => s + t.pnl, 0);

      // Build equity curve from trade history
      const equityCurve: { date: string; equity: number }[] = [];
      if (histArr.length > 0) {
        const sorted = [...histArr].sort((a: any, b: any) => (a.closedAt || "").localeCompare(b.closedAt || ""));
        let runningBalance = 10000;
        for (const t of sorted) {
          runningBalance += t.pnl;
          equityCurve.push({ date: t.closedAt, equity: runningBalance });
        }
      }

      return respond({
        balance, equity: balance + unrealizedPnl, unrealizedPnl,
        positions: posArr, pendingOrders: pending || [],
        tradeHistory: histArr, isRunning: account?.is_running || false,
        isPaused: account?.is_paused || false,
        startedAt: account?.started_at, totalTrades: histArr.length,
        winRate: histArr.length > 0 ? (wins / histArr.length) * 100 : 0,
        wins, losses, scanCount: account?.scan_count || 0,
        signalCount: account?.signal_count || 0,
        rejectedCount: account?.rejected_count || 0,
        executionMode: account?.execution_mode || "paper",
        killSwitchActive: account?.kill_switch_active || false,
        dailyPnl, drawdown, equityCurve,
        marginUsed: 0, freeMargin: balance + unrealizedPnl,
        marginLevel: 0, uptime: 0,
        strategy: {
          name: "SMC Default",
          winRate: histArr.length > 0 ? (wins / histArr.length) * 100 : 0,
          avgRR: 0, profitFactor: 0, expectancy: 0, maxDrawdown: drawdown,
        },
        log: [],
      });
    }

    // ── Place order ──
    if (action === "place_order") {
      const { symbol, direction, size, stopLoss, takeProfit, signalReason, signalScore } = payload;
      const { data: account } = await supabase.from("paper_accounts").select("*").eq("user_id", user.id).maybeSingle();
      if (!account) {
        await supabase.from("paper_accounts").insert({ user_id: user.id, balance: "10000", peak_balance: "10000", daily_pnl_base: "10000" });
      }
      const positionId = crypto.randomUUID().slice(0, 8);
      const orderId = crypto.randomUUID().slice(0, 8);
      const now = new Date().toISOString();
      let entryPrice = payload.entryPrice || 0;

      // For market orders with no entry price, fetch live price
      if (!entryPrice || entryPrice === 0) {
        const livePrice = await fetchLivePrice(symbol);
        if (livePrice) {
          entryPrice = livePrice;
        } else {
          throw new Error("Could not fetch live price for " + symbol);
        }
      }

      await supabase.from("paper_positions").insert({
        user_id: user.id, position_id: positionId, symbol, direction, size: size.toString(),
        entry_price: entryPrice.toString(), current_price: entryPrice.toString(),
        stop_loss: stopLoss?.toString() || null, take_profit: takeProfit?.toString() || null,
        open_time: now, signal_reason: signalReason || "", signal_score: (signalScore || 0).toString(),
        order_id: orderId, position_status: "open",
      });

      // Mirror to MT5 if connected
      let mt5Mirror: any = null;
      const { data: acctForMode } = await supabase.from("paper_accounts").select("execution_mode").eq("user_id", user.id).maybeSingle();
      if (acctForMode) {
        mt5Mirror = await mirrorToMT5(supabase, user.id, {
          action: "open", symbol, direction, size, stopLoss, takeProfit, positionId,
        });
        if (mt5Mirror.success) {
          console.log(`MT5 mirror: opened ${symbol} ${direction} ${size} lots`);
        } else if (mt5Mirror.error !== "no_connection") {
          console.warn(`MT5 mirror failed: ${mt5Mirror.error}`);
        }
      }

      return respond({ success: true, positionId, orderId, mt5Mirror });
    }

    // ── Close position ──
    if (action === "close_position") {
      const { positionId, exitPrice } = payload;
      const { data: pos } = await supabase.from("paper_positions").select("*")
        .eq("user_id", user.id).eq("position_id", positionId).single();
      if (!pos) throw new Error("Position not found");

      const ep = exitPrice || parseFloat(pos.current_price);
      const { pnl, pnlPips } = calcPnl(pos.direction, parseFloat(pos.entry_price), ep, parseFloat(pos.size), pos.symbol);
      const closeReason = payload.reason || "manual";

      // Record in history
      await supabase.from("paper_trade_history").insert({
        user_id: user.id, position_id: pos.position_id, symbol: pos.symbol,
        direction: pos.direction, size: pos.size, entry_price: pos.entry_price,
        exit_price: ep.toString(), pnl: pnl.toString(), pnl_pips: pnlPips.toString(),
        open_time: pos.open_time, closed_at: new Date().toISOString(),
        close_reason: closeReason, signal_reason: pos.signal_reason || "",
        signal_score: pos.signal_score, order_id: pos.order_id,
      });

      // Update balance
      const { data: account } = await supabase.from("paper_accounts").select("*").eq("user_id", user.id).single();
      const newBalance = parseFloat(account.balance) + pnl;
      const newPeak = Math.max(parseFloat(account.peak_balance), newBalance);
      await supabase.from("paper_accounts").update({
        balance: newBalance.toString(),
        peak_balance: newPeak.toString(),
      }).eq("user_id", user.id);

      // Generate post-mortem
      const postMortem = generatePostMortem(pos, ep, pnl, pnlPips, closeReason);
      await supabase.from("trade_post_mortems").insert({
        user_id: user.id,
        position_id: pos.position_id,
        symbol: pos.symbol,
        exit_reason: closeReason,
        exit_price: ep.toString(),
        pnl: pnl.toString(),
        what_worked: postMortem.whatWorked,
        what_failed: postMortem.whatFailed,
        lesson_learned: postMortem.lessonLearned,
        detail_json: postMortem,
      });

      // Remove position
      await supabase.from("paper_positions").delete().eq("id", pos.id);

      return respond({ success: true, pnl, pnlPips, postMortem });
    }

    // ── Engine controls ──
    if (action === "start_engine") {
      await ensureAccount(supabase, user.id);
      await supabase.from("paper_accounts").update({ is_running: true, is_paused: false, started_at: new Date().toISOString() }).eq("user_id", user.id);
      return respond({ success: true });
    }
    if (action === "pause_engine") {
      await supabase.from("paper_accounts").update({ is_paused: true }).eq("user_id", user.id);
      return respond({ success: true });
    }
    if (action === "stop_engine") {
      await supabase.from("paper_accounts").update({ is_running: false, is_paused: false }).eq("user_id", user.id);
      return respond({ success: true });
    }
    if (action === "kill_switch") {
      const active = payload.active;
      if (active) {
        // Close all open positions
        const { data: positions } = await supabase.from("paper_positions").select("*")
          .eq("user_id", user.id).eq("position_status", "open");
        const { data: account } = await supabase.from("paper_accounts").select("*").eq("user_id", user.id).single();

        if (positions && positions.length > 0) {
          let totalPnl = 0;
          for (const pos of positions) {
            const ep = parseFloat(pos.current_price);
            const { pnl, pnlPips } = calcPnl(pos.direction, parseFloat(pos.entry_price), ep, parseFloat(pos.size), pos.symbol);
            totalPnl += pnl;

            await supabase.from("paper_trade_history").insert({
              user_id: user.id, position_id: pos.position_id, symbol: pos.symbol,
              direction: pos.direction, size: pos.size, entry_price: pos.entry_price,
              exit_price: ep.toString(), pnl: pnl.toString(), pnl_pips: pnlPips.toString(),
              open_time: pos.open_time, closed_at: new Date().toISOString(),
              close_reason: "kill_switch", signal_reason: pos.signal_reason || "",
              signal_score: pos.signal_score, order_id: pos.order_id,
            });

            const postMortem = generatePostMortem(pos, ep, pnl, pnlPips, "kill_switch");
            await supabase.from("trade_post_mortems").insert({
              user_id: user.id, position_id: pos.position_id, symbol: pos.symbol,
              exit_reason: "kill_switch", exit_price: ep.toString(), pnl: pnl.toString(),
              what_worked: postMortem.whatWorked, what_failed: postMortem.whatFailed,
              lesson_learned: postMortem.lessonLearned, detail_json: postMortem,
            });
          }

          await supabase.from("paper_positions").delete().eq("user_id", user.id);

          if (account) {
            const newBal = parseFloat(account.balance) + totalPnl;
            await supabase.from("paper_accounts").update({
              balance: newBal.toString(),
              peak_balance: Math.max(parseFloat(account.peak_balance), newBal).toString(),
            }).eq("user_id", user.id);
          }
        }

        await supabase.from("paper_accounts").update({
          kill_switch_active: true, is_running: false, is_paused: false,
        }).eq("user_id", user.id);
      } else {
        await supabase.from("paper_accounts").update({ kill_switch_active: false }).eq("user_id", user.id);
      }
      return respond({ success: true });
    }

    if (action === "reset_account") {
      await supabase.from("paper_positions").delete().eq("user_id", user.id);
      await supabase.from("paper_trade_history").delete().eq("user_id", user.id);
      await supabase.from("trade_reasonings").delete().eq("user_id", user.id);
      await supabase.from("trade_post_mortems").delete().eq("user_id", user.id);
      await supabase.from("scan_logs").delete().eq("user_id", user.id);
      await supabase.from("paper_accounts").update({
        balance: "10000", peak_balance: "10000", is_running: false, is_paused: false,
        scan_count: 0, signal_count: 0, rejected_count: 0, daily_pnl_base: "10000",
        daily_pnl_date: "", kill_switch_active: false, execution_mode: "paper",
      }).eq("user_id", user.id);
      return respond({ success: true });
    }

    if (action === "set_execution_mode") {
      await supabase.from("paper_accounts").update({ execution_mode: payload.mode }).eq("user_id", user.id);
      return respond({ success: true });
    }

    return respond({ error: "Unknown action" });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function ensureAccount(supabase: any, userId: string) {
  const { data } = await supabase.from("paper_accounts").select("id").eq("user_id", userId).maybeSingle();
  if (!data) {
    await supabase.from("paper_accounts").insert({ user_id: userId, balance: "10000", peak_balance: "10000", daily_pnl_base: "10000" });
  }
}

function respond(data: any) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
