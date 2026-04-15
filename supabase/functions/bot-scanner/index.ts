import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

// ─── Config ─────────────────────────────────────────────────────────
const SCAN_PAIRS = [
  "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD",
  "GBP/JPY", "EUR/GBP", "NZD/USD", "USD/CHF", "EUR/JPY",
];

const YAHOO_SYMBOLS: Record<string, string> = {
  "EUR/USD": "EURUSD=X", "GBP/USD": "GBPUSD=X", "USD/JPY": "USDJPY=X",
  "GBP/JPY": "GBPJPY=X", "AUD/USD": "AUDUSD=X", "USD/CAD": "USDCAD=X",
  "EUR/GBP": "EURGBP=X", "NZD/USD": "NZDUSD=X", "USD/CHF": "USDCHF=X",
  "EUR/JPY": "EURJPY=X",
};

const SPECS: Record<string, { pipSize: number; lotUnits: number }> = {
  "EUR/USD": { pipSize: 0.0001, lotUnits: 100000 },
  "GBP/USD": { pipSize: 0.0001, lotUnits: 100000 },
  "USD/JPY": { pipSize: 0.01, lotUnits: 100000 },
  "GBP/JPY": { pipSize: 0.01, lotUnits: 100000 },
  "AUD/USD": { pipSize: 0.0001, lotUnits: 100000 },
  "USD/CAD": { pipSize: 0.0001, lotUnits: 100000 },
  "EUR/GBP": { pipSize: 0.0001, lotUnits: 100000 },
  "NZD/USD": { pipSize: 0.0001, lotUnits: 100000 },
  "USD/CHF": { pipSize: 0.0001, lotUnits: 100000 },
  "EUR/JPY": { pipSize: 0.01, lotUnits: 100000 },
};

const MIN_CONFLUENCE = 6; // Minimum score to place a trade
const DEFAULT_RISK_PERCENT = 1; // 1% risk per trade
const MAX_OPEN_POSITIONS = 3;

// ─── Types ──────────────────────────────────────────────────────────
interface Candle { datetime: string; open: number; high: number; low: number; close: number; volume?: number; }
interface SwingPoint { index: number; price: number; type: "high" | "low"; datetime: string; }
interface OrderBlock { index: number; high: number; low: number; type: "bullish" | "bearish"; datetime: string; mitigated: boolean; mitigatedPercent: number; }
interface FairValueGap { index: number; high: number; low: number; type: "bullish" | "bearish"; datetime: string; mitigated: boolean; }

// ─── SMC Analysis (inline to avoid cross-function imports) ──────────
function detectSwingPoints(candles: Candle[], lookback = 3): SwingPoint[] {
  const swings: SwingPoint[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
    }
    if (isHigh) swings.push({ index: i, price: candles[i].high, type: "high", datetime: candles[i].datetime });
    if (isLow) swings.push({ index: i, price: candles[i].low, type: "low", datetime: candles[i].datetime });
  }
  return swings;
}

function analyzeMarketStructure(candles: Candle[]) {
  const swings = detectSwingPoints(candles);
  const highs = swings.filter(s => s.type === "high"), lows = swings.filter(s => s.type === "low");
  let currentTrend = "ranging";
  const bos: any[] = [], choch: any[] = [];
  for (let i = 1; i < highs.length; i++) {
    if (highs[i].price > highs[i - 1].price) {
      if (currentTrend === "bearish") choch.push({ type: "bullish", price: highs[i].price });
      else bos.push({ type: "bullish", price: highs[i].price });
      currentTrend = "bullish";
    }
  }
  for (let i = 1; i < lows.length; i++) {
    if (lows[i].price < lows[i - 1].price) {
      if (currentTrend === "bullish") choch.push({ type: "bearish", price: lows[i].price });
      else bos.push({ type: "bearish", price: lows[i].price });
      currentTrend = "bearish";
    }
  }
  let trend: "bullish" | "bearish" | "ranging" = "ranging";
  if (highs.length >= 2 && lows.length >= 2) {
    const rH = highs.slice(-2), rL = lows.slice(-2);
    if (rH[1].price > rH[0].price && rL[1].price > rL[0].price) trend = "bullish";
    else if (rH[1].price < rH[0].price && rL[1].price < rL[0].price) trend = "bearish";
  }
  return { trend, swingPoints: swings, bos, choch };
}

function detectOrderBlocks(candles: Candle[]): OrderBlock[] {
  const obs: OrderBlock[] = [];
  for (let i = 2; i < candles.length; i++) {
    const prev = candles[i - 1], curr = candles[i];
    if (prev.close < prev.open && curr.close > curr.open && curr.close > prev.high) {
      const ob: OrderBlock = { index: i - 1, high: prev.high, low: prev.low, type: "bullish", datetime: prev.datetime, mitigated: false, mitigatedPercent: 0 };
      for (let j = i + 1; j < candles.length; j++) {
        const mid = (ob.high + ob.low) / 2;
        if (candles[j].low <= mid) { ob.mitigatedPercent = Math.min(100, ((ob.high - candles[j].low) / (ob.high - ob.low)) * 100); if (ob.mitigatedPercent >= 50) ob.mitigated = true; break; }
      }
      obs.push(ob);
    }
    if (prev.close > prev.open && curr.close < curr.open && curr.close < prev.low) {
      const ob: OrderBlock = { index: i - 1, high: prev.high, low: prev.low, type: "bearish", datetime: prev.datetime, mitigated: false, mitigatedPercent: 0 };
      for (let j = i + 1; j < candles.length; j++) {
        const mid = (ob.high + ob.low) / 2;
        if (candles[j].high >= mid) { ob.mitigatedPercent = Math.min(100, ((candles[j].high - ob.low) / (ob.high - ob.low)) * 100); if (ob.mitigatedPercent >= 50) ob.mitigated = true; break; }
      }
      obs.push(ob);
    }
  }
  return obs;
}

function detectFVGs(candles: Candle[]): FairValueGap[] {
  const fvgs: FairValueGap[] = [];
  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2], c2 = candles[i - 1], c3 = candles[i];
    if (c3.low > c1.high && c2.close > c2.open) {
      const fvg: FairValueGap = { index: i - 1, high: c3.low, low: c1.high, type: "bullish", datetime: c2.datetime, mitigated: false };
      for (let j = i + 1; j < candles.length; j++) { if (candles[j].low <= fvg.low) { fvg.mitigated = true; break; } }
      fvgs.push(fvg);
    }
    if (c1.low > c3.high && c2.close < c2.open) {
      const fvg: FairValueGap = { index: i - 1, high: c1.low, low: c3.high, type: "bearish", datetime: c2.datetime, mitigated: false };
      for (let j = i + 1; j < candles.length; j++) { if (candles[j].high >= fvg.high) { fvg.mitigated = true; break; } }
      fvgs.push(fvg);
    }
  }
  return fvgs;
}

function detectSession() {
  const now = new Date();
  const utcH = now.getUTCHours();
  let name = "Off-Hours", active = false, isKillZone = false;
  if (utcH >= 0 && utcH < 8) { name = "Asian"; active = true; isKillZone = utcH >= 0 && utcH < 4; }
  else if (utcH >= 7 && utcH < 16) { name = "London"; active = true; isKillZone = utcH >= 7 && utcH < 10; }
  else if (utcH >= 12 && utcH < 21) { name = "New York"; active = true; isKillZone = utcH >= 12 && utcH < 15; }
  return { name, active, isKillZone };
}

function calculatePremiumDiscount(candles: Candle[]) {
  const swings = detectSwingPoints(candles);
  const highs = swings.filter(s => s.type === "high");
  const lows = swings.filter(s => s.type === "low");
  const sh = highs.length > 0 ? Math.max(...highs.map(h => h.price)) : candles[candles.length - 1].high;
  const sl = lows.length > 0 ? Math.min(...lows.map(l => l.price)) : candles[candles.length - 1].low;
  const range = sh - sl;
  const cp = candles[candles.length - 1].close;
  const zp = range > 0 ? ((cp - sl) / range) * 100 : 50;
  const zone = zp > 55 ? "premium" : zp < 45 ? "discount" : "equilibrium";
  return { swingHigh: sh, swingLow: sl, currentZone: zone, zonePercent: zp };
}

function runConfluenceScore(candles: Candle[]) {
  const structure = analyzeMarketStructure(candles);
  const orderBlocks = detectOrderBlocks(candles);
  const fvgs = detectFVGs(candles);
  const session = detectSession();
  const pd = calculatePremiumDiscount(candles);

  let score = 0;
  const reasoning: string[] = [];

  // Trend confirmation
  if (structure.trend !== "ranging") { score += 2; reasoning.push(`${structure.trend} trend`); }

  // Active order blocks near price
  const activeOBs = orderBlocks.filter(ob => !ob.mitigated);
  const lastPrice = candles[candles.length - 1].close;
  const spec = { pipSize: 0.0001 }; // default
  const nearbyOBs = activeOBs.filter(ob => {
    const dist = Math.abs(lastPrice - (ob.high + ob.low) / 2);
    return dist < lastPrice * 0.005; // within 0.5%
  });
  if (nearbyOBs.length > 0) { score += 2.5; reasoning.push(`${nearbyOBs.length} nearby OBs`); }
  else if (activeOBs.length > 0) { score += 1; reasoning.push(`${activeOBs.length} active OBs (not nearby)`); }

  // FVGs
  const activeFVGs = fvgs.filter(f => !f.mitigated);
  if (activeFVGs.length > 0) { score += 1.5; reasoning.push(`${activeFVGs.length} unfilled FVGs`); }

  // Premium/discount alignment
  if (structure.trend === "bullish" && pd.currentZone === "discount") { score += 2; reasoning.push("Bullish in discount zone"); }
  else if (structure.trend === "bearish" && pd.currentZone === "premium") { score += 2; reasoning.push("Bearish in premium zone"); }
  else if (pd.currentZone !== "equilibrium") { score += 0.5; reasoning.push(`In ${pd.currentZone} zone`); }

  // Kill zone bonus
  if (session.isKillZone) { score += 1; reasoning.push(`${session.name} kill zone`); }

  // BOS/CHoCH recency
  if (structure.bos.length > 0) { score += 0.5; reasoning.push("Recent BOS"); }
  if (structure.choch.length > 0) { score += 0.5; reasoning.push("CHoCH detected"); }

  score = Math.min(10, Math.round(score * 10) / 10);

  // Determine trade direction
  let direction: "long" | "short" | null = null;
  if (structure.trend === "bullish" && pd.currentZone !== "premium") direction = "long";
  else if (structure.trend === "bearish" && pd.currentZone !== "discount") direction = "short";

  // Calculate SL/TP from nearest OB or swing
  let stopLoss: number | null = null;
  let takeProfit: number | null = null;
  const swings = structure.swingPoints;

  if (direction === "long") {
    const recentLows = swings.filter(s => s.type === "low").slice(-3);
    if (recentLows.length > 0) stopLoss = Math.min(...recentLows.map(s => s.price)) - lastPrice * 0.0005;
    const recentHighs = swings.filter(s => s.type === "high").slice(-3);
    if (recentHighs.length > 0 && stopLoss) {
      const risk = lastPrice - stopLoss;
      takeProfit = lastPrice + risk * 2; // 2:1 RR
    }
  } else if (direction === "short") {
    const recentHighs = swings.filter(s => s.type === "high").slice(-3);
    if (recentHighs.length > 0) stopLoss = Math.max(...recentHighs.map(s => s.price)) + lastPrice * 0.0005;
    if (stopLoss) {
      const risk = stopLoss - lastPrice;
      takeProfit = lastPrice - risk * 2;
    }
  }

  return { score, reasoning, direction, structure, session, pd, stopLoss, takeProfit, lastPrice };
}

// ─── Fetch candles from Yahoo ───────────────────────────────────────
async function fetchCandles(symbol: string): Promise<Candle[]> {
  const yahooSymbol = YAHOO_SYMBOLS[symbol];
  if (!yahooSymbol) return [];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=15m&range=5d`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "SMC-Bot-Scanner/1.0" } });
    const data = await res.json();
    if (!data?.chart?.result?.[0]) return [];
    const result = data.chart.result[0];
    const timestamps: number[] = result.timestamp || [];
    const quotes = result.indicators?.quote?.[0];
    if (!quotes) return [];
    const candles: Candle[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = quotes.open?.[i], h = quotes.high?.[i], l = quotes.low?.[i], c = quotes.close?.[i];
      if (o == null || h == null || l == null || c == null) continue;
      candles.push({ datetime: new Date(timestamps[i] * 1000).toISOString(), open: o, high: h, low: l, close: c });
    }
    return candles;
  } catch { return []; }
}

// ─── Calculate position size based on risk ──────────────────────────
function calculatePositionSize(balance: number, riskPercent: number, entryPrice: number, stopLoss: number, symbol: string): number {
  const spec = SPECS[symbol] || SPECS["EUR/USD"];
  const riskAmount = balance * (riskPercent / 100);
  const slDistance = Math.abs(entryPrice - stopLoss);
  if (slDistance === 0) return 0.01;
  const size = riskAmount / (slDistance * spec.lotUnits);
  return Math.max(0.01, Math.min(1, Math.round(size * 100) / 100)); // 0.01 to 1 lot
}

// ─── Main Handler ───────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Support both authenticated user calls and cron (service role)
    const authHeader = req.headers.get("Authorization");
    let userId: string | null = null;

    if (authHeader && authHeader !== `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}`) {
      // User-initiated scan
      const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user } } = await userClient.auth.getUser();
      if (user) userId = user.id;
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action || "scan";

    // If user-initiated, use their ID. For cron, scan all running accounts.
    const adminClient = createClient(supabaseUrl, supabaseKey);

    if (action === "scan_logs") {
      // Return recent scan logs for a user
      if (!userId) return respond({ error: "Unauthorized" }, 401);
      const { data } = await adminClient.from("scan_logs").select("*")
        .eq("user_id", userId).order("scanned_at", { ascending: false }).limit(20);
      return respond(data || []);
    }

    if (action === "manual_scan") {
      if (!userId) return respond({ error: "Unauthorized" }, 401);
      const result = await runScanForUser(adminClient, userId);
      return respond(result);
    }

    // Cron scan: find all accounts with is_running=true
    if (action === "scan" || action === "cron") {
      const { data: accounts } = await adminClient.from("paper_accounts").select("*").eq("is_running", true).eq("kill_switch_active", false);
      if (!accounts || accounts.length === 0) return respond({ message: "No active accounts", scanned: 0 });

      const results = [];
      for (const account of accounts) {
        try {
          const result = await runScanForUser(adminClient, account.user_id);
          results.push({ userId: account.user_id, ...result });
        } catch (e: any) {
          results.push({ userId: account.user_id, error: e.message });
        }
      }
      return respond({ scanned: results.length, results });
    }

    return respond({ error: "Unknown action" }, 400);
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function runScanForUser(supabase: any, userId: string) {
  // Get account
  const { data: account } = await supabase.from("paper_accounts").select("*").eq("user_id", userId).maybeSingle();
  if (!account) return { error: "No paper account" };

  const balance = parseFloat(account.balance || "10000");
  const isPaused = account.is_paused;

  // Count open positions
  const { data: openPositions } = await supabase.from("paper_positions").select("symbol").eq("user_id", userId).eq("position_status", "open");
  const openCount = openPositions?.length || 0;
  const openSymbols = new Set((openPositions || []).map((p: any) => p.symbol));

  // Get user risk settings
  const { data: settings } = await supabase.from("user_settings").select("risk_settings_json").eq("user_id", userId).maybeSingle();
  const riskPercent = settings?.risk_settings_json?.riskPerTrade || DEFAULT_RISK_PERCENT;

  const scanDetails: any[] = [];
  let signalsFound = 0;
  let tradesPlaced = 0;

  // Scan each pair
  for (const pair of SCAN_PAIRS) {
    if (openSymbols.has(pair)) {
      scanDetails.push({ pair, status: "skipped", reason: "Position already open" });
      continue;
    }

    const candles = await fetchCandles(pair);
    if (candles.length < 30) {
      scanDetails.push({ pair, status: "skipped", reason: "Insufficient data" });
      continue;
    }

    const analysis = runConfluenceScore(candles);
    const detail: any = {
      pair,
      score: analysis.score,
      direction: analysis.direction,
      trend: analysis.structure.trend,
      zone: analysis.pd.currentZone,
      session: analysis.session.name,
      killZone: analysis.session.isKillZone,
      reasoning: analysis.reasoning,
      status: "analyzed",
    };

    if (analysis.score >= MIN_CONFLUENCE && analysis.direction && !isPaused) {
      signalsFound++;

      if (openCount + tradesPlaced < MAX_OPEN_POSITIONS && analysis.stopLoss) {
        // Calculate position size
        const size = calculatePositionSize(balance, riskPercent, analysis.lastPrice, analysis.stopLoss, pair);
        const positionId = crypto.randomUUID().slice(0, 8);
        const orderId = crypto.randomUUID().slice(0, 8);
        const now = new Date().toISOString();

        await supabase.from("paper_positions").insert({
          user_id: userId,
          position_id: positionId,
          symbol: pair,
          direction: analysis.direction === "long" ? "long" : "short",
          size: size.toString(),
          entry_price: analysis.lastPrice.toString(),
          current_price: analysis.lastPrice.toString(),
          stop_loss: analysis.stopLoss?.toString() || null,
          take_profit: analysis.takeProfit?.toString() || null,
          open_time: now,
          signal_reason: analysis.reasoning.join("; "),
          signal_score: analysis.score.toString(),
          order_id: orderId,
          position_status: "open",
        });

        tradesPlaced++;
        detail.status = "trade_placed";
        detail.size = size;
        detail.entryPrice = analysis.lastPrice;
        detail.stopLoss = analysis.stopLoss;
        detail.takeProfit = analysis.takeProfit;
      } else {
        detail.status = "signal_only";
        detail.reason = openCount + tradesPlaced >= MAX_OPEN_POSITIONS ? "Max positions reached" : "No valid SL";
      }
    } else {
      detail.status = analysis.score >= MIN_CONFLUENCE ? "paused" : "below_threshold";
    }

    scanDetails.push(detail);
  }

  // Update scan counters
  await supabase.from("paper_accounts").update({
    scan_count: (account.scan_count || 0) + 1,
    signal_count: (account.signal_count || 0) + signalsFound,
  }).eq("user_id", userId);

  // Log the scan
  await supabase.from("scan_logs").insert({
    user_id: userId,
    pairs_scanned: SCAN_PAIRS.length,
    signals_found: signalsFound,
    trades_placed: tradesPlaced,
    details_json: scanDetails,
  });

  return { pairsScanned: SCAN_PAIRS.length, signalsFound, tradesPlaced, details: scanDetails };
}

function respond(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
