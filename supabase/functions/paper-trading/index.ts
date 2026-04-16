import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

// ─── Yahoo Finance Symbol Mapping ───────────────────────────────────
const YAHOO_SYMBOLS: Record<string, string> = {
  // Forex Majors
  "EUR/USD": "EURUSD=X", "GBP/USD": "GBPUSD=X", "USD/JPY": "USDJPY=X",
  "AUD/USD": "AUDUSD=X", "NZD/USD": "NZDUSD=X", "USD/CAD": "USDCAD=X",
  "USD/CHF": "USDCHF=X",
  // Forex Crosses
  "EUR/GBP": "EURGBP=X", "EUR/JPY": "EURJPY=X", "GBP/JPY": "GBPJPY=X",
  "EUR/AUD": "EURAUD=X", "EUR/CAD": "EURCAD=X", "EUR/CHF": "EURCHF=X",
  "EUR/NZD": "EURNZD=X", "GBP/AUD": "GBPAUD=X", "GBP/CAD": "GBPCAD=X",
  "GBP/CHF": "GBPCHF=X", "GBP/NZD": "GBPNZD=X", "AUD/CAD": "AUDCAD=X",
  "AUD/JPY": "AUDJPY=X", "CAD/JPY": "CADJPY=X",
  // Indices
  "US30": "YM=F", "NAS100": "NQ=F", "SPX500": "ES=F",
  // Commodities
  "XAU/USD": "GC=F", "XAG/USD": "SI=F", "US Oil": "CL=F",
  // Crypto
  "BTC/USD": "BTC-USD", "ETH/USD": "ETH-USD",
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
  // Forex Majors
  "EUR/USD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1000 },
  "GBP/USD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1000 },
  "USD/JPY": { pipSize: 0.01, lotUnits: 100000, marginPerLot: 1000 },
  "AUD/USD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 800 },
  "NZD/USD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 700 },
  "USD/CAD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1000 },
  "USD/CHF": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1000 },
  // Forex Crosses
  "EUR/GBP": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1200 },
  "EUR/JPY": { pipSize: 0.01, lotUnits: 100000, marginPerLot: 1200 },
  "GBP/JPY": { pipSize: 0.01, lotUnits: 100000, marginPerLot: 1500 },
  "EUR/AUD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1200 },
  "EUR/CAD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1200 },
  "EUR/CHF": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1200 },
  "EUR/NZD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1200 },
  "GBP/AUD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1500 },
  "GBP/CAD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1500 },
  "GBP/CHF": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1500 },
  "GBP/NZD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1500 },
  "AUD/CAD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 800 },
  "AUD/JPY": { pipSize: 0.01, lotUnits: 100000, marginPerLot: 800 },
  "CAD/JPY": { pipSize: 0.01, lotUnits: 100000, marginPerLot: 1000 },
  // Indices
  "US30": { pipSize: 1.0, lotUnits: 1, marginPerLot: 5000 },
  "NAS100": { pipSize: 0.25, lotUnits: 1, marginPerLot: 3000 },
  "SPX500": { pipSize: 0.25, lotUnits: 1, marginPerLot: 3000 },
  // Commodities
  "XAU/USD": { pipSize: 0.01, lotUnits: 100, marginPerLot: 2000 },
  "XAG/USD": { pipSize: 0.001, lotUnits: 5000, marginPerLot: 1500 },
  "US Oil": { pipSize: 0.01, lotUnits: 1000, marginPerLot: 2000 },
  // Crypto
  "BTC/USD": { pipSize: 1, lotUnits: 1, marginPerLot: 5000 },
  "ETH/USD": { pipSize: 0.01, lotUnits: 1, marginPerLot: 1000 },
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

    // Auto-detect swapped fields: JWT tokens start with "eyJ", account IDs are UUIDs
    let authToken = conn.api_key;
    let metaAccountId = conn.account_id;
    if (metaAccountId.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
      authToken = conn.account_id;
      metaAccountId = conn.api_key;
    }

    const baseUrl = `https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${metaAccountId}`;
    const headers: Record<string, string> = { "auth-token": authToken, "Content-Type": "application/json" };

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
    const msg = e?.message || String(e);
    if (msg.includes("invalid peer certificate") || msg.includes("UnknownIssuer")) {
      console.warn("MT5 mirror SSL issue — credentials saved, trade may still execute:", msg);
      return { success: false, error: "SSL certificate issue — credentials are saved" };
    }
    console.error("MT5 mirror error:", msg);
    return { success: false, error: msg };
  }
}
// ─── Close All Broker Positions for a paper position ────────────────
async function closeBrokerPositions(supabase: any, userId: string, positionId: string, symbol: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const { data: account } = await supabase.from("paper_accounts").select("execution_mode").eq("user_id", userId).single();
    if (account?.execution_mode !== "live") return ["skipped_paper_mode"];

    const { data: connections } = await supabase.from("broker_connections")
      .select("*").eq("user_id", userId).eq("broker_type", "metaapi").eq("is_active", true);
    if (!connections || connections.length === 0) return ["no_connection"];

    for (const conn of connections) {
      try {
        let authToken = conn.api_key;
        let metaAccountId = conn.account_id;
        if (metaAccountId.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
          authToken = conn.account_id;
          metaAccountId = conn.api_key;
        }
        const baseUrl = `https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${metaAccountId}`;
        const headers: Record<string, string> = { "auth-token": authToken, "Content-Type": "application/json" };

        // Find broker position by comment tag
        const posRes = await fetch(`${baseUrl}/positions`, { headers });
        if (!posRes.ok) { results.push(`${conn.display_name}: positions fetch failed ${posRes.status}`); continue; }
        const brokerPositions: any[] = await posRes.json();
        const brokerPos = brokerPositions.find((p: any) => p.comment?.includes(`paper:${positionId}`));
        if (!brokerPos) {
          // Fallback: match by symbol
          const resolvedSymbol = symbol.replace("/", "") + (conn.symbol_suffix || "");
          const overrides = conn.symbol_overrides || {};
          const base = symbol.replace("/", "");
          const brokerSymbol = overrides[base] || resolvedSymbol;
          const symMatch = brokerPositions.find((p: any) => p.symbol === brokerSymbol || p.symbol === base);
          if (!symMatch) { results.push(`${conn.display_name}: position not found`); continue; }
          const closeBody = { actionType: "POSITION_CLOSE_ID", positionId: symMatch.id };
          const res = await fetch(`${baseUrl}/trade`, { method: "POST", headers, body: JSON.stringify(closeBody) });
          results.push(`${conn.display_name}: ${res.ok ? "closed (symbol match)" : "close failed " + res.status}`);
          continue;
        }
        const closeBody = { actionType: "POSITION_CLOSE_ID", positionId: brokerPos.id };
        const res = await fetch(`${baseUrl}/trade`, { method: "POST", headers, body: JSON.stringify(closeBody) });
        results.push(`${conn.display_name}: ${res.ok ? "closed" : "close failed " + res.status}`);
        if (res.ok) console.log(`Broker close [${conn.display_name}]: closed position for paper:${positionId}`);
        else console.warn(`Broker close [${conn.display_name}]: failed ${res.status}`);
      } catch (e: any) {
        console.warn(`Broker close [${conn.display_name}] error: ${e?.message}`);
        results.push(`${conn.display_name}: error`);
      }
    }
  } catch (e: any) {
    console.warn(`closeBrokerPositions error: ${e?.message}`);
    results.push("error");
  }
  return results;
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
      let { data: positions } = await supabase.from("paper_positions").select("*").eq("user_id", user.id).eq("position_status", "open").order("open_time", { ascending: true });
      // Update current prices from live market data
      if (positions && positions.length > 0) {
        await updatePositionPrices(supabase, positions);
        // Re-fetch with updated prices
        const { data: refreshed } = await supabase.from("paper_positions").select("*").eq("user_id", user.id).eq("position_status", "open").order("open_time", { ascending: true });
        positions = refreshed || positions;

        // ── SL/TP Hit Detection + Exit Flag Logic (Fix #9, #13) ──
        const closedIds: string[] = [];
        for (const pos of (positions || [])) {
          const currentPrice = parseFloat(pos.current_price);
          const entryPrice = parseFloat(pos.entry_price);
          const sl = pos.stop_loss ? parseFloat(pos.stop_loss) : null;
          const tp = pos.take_profit ? parseFloat(pos.take_profit) : null;
          const size = parseFloat(pos.size);
          let closeReason: string | null = null;
          let exitPrice = currentPrice;

          // Parse exit flags from signal_reason
          let exitFlags: any = {};
          try {
            const parsed = JSON.parse(pos.signal_reason || "{}");
            exitFlags = parsed.exitFlags || {};
          } catch {}

          // Check SL hit
          if (sl !== null) {
            if (pos.direction === "long" && currentPrice <= sl) {
              closeReason = "sl_hit"; exitPrice = sl;
            } else if (pos.direction === "short" && currentPrice >= sl) {
              closeReason = "sl_hit"; exitPrice = sl;
            }
          }

          // Check TP hit
          if (!closeReason && tp !== null) {
            if (pos.direction === "long" && currentPrice >= tp) {
              closeReason = "tp_hit"; exitPrice = tp;
            } else if (pos.direction === "short" && currentPrice <= tp) {
              closeReason = "tp_hit"; exitPrice = tp;
            }
          }

          // Check max hold hours
          if (!closeReason && exitFlags.maxHoldHours && exitFlags.maxHoldHours > 0) {
            const openMs = new Date(pos.open_time).getTime();
            const elapsedHours = (Date.now() - openMs) / 3600000;
            if (elapsedHours >= exitFlags.maxHoldHours) {
              closeReason = "time_exit";
            }
          }

          // Break even: move SL to entry if price moved enough in profit
          if (!closeReason && exitFlags.breakEven && exitFlags.breakEvenPips > 0 && sl !== null) {
            const spec = SPECS[pos.symbol] || SPECS["EUR/USD"];
            const profitPips = pos.direction === "long"
              ? (currentPrice - entryPrice) / spec.pipSize
              : (entryPrice - currentPrice) / spec.pipSize;
            if (profitPips >= exitFlags.breakEvenPips) {
              // Move SL to entry (break even)
              const newSL = entryPrice;
              if ((pos.direction === "long" && newSL > sl) || (pos.direction === "short" && newSL < sl)) {
                await supabase.from("paper_positions").update({ stop_loss: newSL.toString() }).eq("id", pos.id);
              }
            }
          }

          // Close position if SL/TP/time triggered
          if (closeReason) {
            const { pnl, pnlPips } = calcPnl(pos.direction, entryPrice, exitPrice, size, pos.symbol);
            await supabase.from("paper_trade_history").insert({
              user_id: user.id, position_id: pos.position_id, symbol: pos.symbol,
              direction: pos.direction, size: pos.size, entry_price: pos.entry_price,
              exit_price: exitPrice.toString(), pnl: pnl.toFixed(2), pnl_pips: pnlPips.toFixed(1),
              open_time: pos.open_time, closed_at: new Date().toISOString(),
              close_reason: closeReason, signal_reason: pos.signal_reason || "",
              signal_score: pos.signal_score, order_id: pos.order_id,
            });
            // Update balance
            const curBal = parseFloat(account?.balance || "10000");
            const newBal = curBal + pnl;
            const newPeak = Math.max(parseFloat(account?.peak_balance || "10000"), newBal);
            await supabase.from("paper_accounts").update({
              balance: newBal.toFixed(2), peak_balance: newPeak.toFixed(2),
            }).eq("user_id", user.id);

            // Generate post-mortem
            const postMortem = generatePostMortem(pos, exitPrice, pnl, pnlPips, closeReason);
            await supabase.from("trade_post_mortems").insert({
              user_id: user.id, position_id: pos.position_id, symbol: pos.symbol,
              exit_reason: closeReason, exit_price: exitPrice.toString(), pnl: pnl.toFixed(2),
              what_worked: postMortem.whatWorked, what_failed: postMortem.whatFailed,
              lesson_learned: postMortem.lessonLearned, detail_json: postMortem,
            });

            await supabase.from("paper_positions").delete().eq("id", pos.id);
            closedIds.push(pos.id);

            // Mirror close to all broker connections
            const brokerCloseResults = await closeBrokerPositions(supabase, user.id, pos.position_id, pos.symbol);
            console.log(`Auto-close broker mirror [${pos.position_id}] ${closeReason}: ${brokerCloseResults.join("; ")}`);
          }
        }

        // Re-fetch positions after auto-closes
        if (closedIds.length > 0) {
          const { data: remaining } = await supabase.from("paper_positions").select("*").eq("user_id", user.id).eq("position_status", "open").order("open_time", { ascending: true });
          positions = remaining || [];
          // Re-fetch account for updated balance
          const { data: updatedAccount } = await supabase.from("paper_accounts").select("*").eq("user_id", user.id).maybeSingle();
          if (updatedAccount) Object.assign(account, updatedAccount);
        }
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
      if (acctForMode?.execution_mode === "live") {
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

      // Mirror close to all broker connections
      const brokerCloseResults = await closeBrokerPositions(supabase, user.id, pos.position_id, pos.symbol);
      console.log(`Manual close broker mirror [${pos.position_id}]: ${brokerCloseResults.join("; ")}`);

      return respond({ success: true, pnl, pnlPips, postMortem, brokerClose: brokerCloseResults });
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
