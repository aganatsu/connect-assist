import { corsHeaders } from "../_shared/cors.ts";
// Diagnostic only — see the "impulse_debug" action at the bottom of the handler.
import { fetchCandlesWithFallback } from "../_shared/candleSource.ts";
import { enumerateImpulseLegs, mapImpulsePOIs } from "../_shared/impulseZoneEngine.ts";
import { findImpulseBase, detectStructuralOrderBlocks, DEFAULT_MAX_BASE_CANDLES } from "../_shared/structuralOrderBlocks.ts";
import { dropFxClosedBars } from "../_shared/sessions.ts";
import {
  analyzeMarketStructure,
  detectOrderBlocks,
  detectFVGs,
  detectLiquidityPools,
  detectJudasSwing,
  detectReversalCandle,
  calculatePremiumDiscount,
  calculatePDLevels,
  detectSession,
  detectSilverBullet,
  detectMacroWindow,
  detectAMDPhase,
  detectDisplacement,
  tagDisplacementQuality,
  detectBreakerBlocks,
  detectUnicornSetups,
  calculateAnchoredVWAP,
  calculateATR,
  SPECS,
  type Candle,
  type ReasoningFactor,
} from "../_shared/smcAnalysis.ts";

// Safe number formatter — guards against undefined/null/NaN
const fx = (n: any, d = 5) => (typeof n === "number" && Number.isFinite(n) ? n.toFixed(d) : "n/a");

// ─── Currency Strength (standalone, not in shared) ──────────────────
function calculateCurrencyStrength(pairData: Record<string, { change: number }>): any[] {
  const currencies = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "NZD", "CHF"];
  const scores: Record<string, number> = {};
  currencies.forEach(c => (scores[c] = 0));
  for (const [pair, data] of Object.entries(pairData)) {
    const base = pair.slice(0, 3).toUpperCase();
    const quote = pair.slice(4, 7).toUpperCase();
    if (scores[base] !== undefined) scores[base] += data.change;
    if (scores[quote] !== undefined) scores[quote] -= data.change;
  }
  return currencies.map(c => ({ currency: c, strength: Math.round(scores[c] * 100) / 100 }));
}

// ─── Correlation (standalone, not in shared) ────────────────────────
function calculateCorrelation(data1: number[], data2: number[]): number {
  const n = Math.min(data1.length, data2.length);
  if (n < 5) return 0;
  const x = data1.slice(0, n), y = data2.slice(0, n);
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i] - mx, yi = y[i] - my;
    num += xi * yi; dx += xi * xi; dy += yi * yi;
  }
  const denom = Math.sqrt(dx * dy);
  return denom > 0 ? Math.round((num / denom) * 1000) / 1000 : 0;
}

// ─── Full Confluence Analysis (mirrors scanner's 21-factor scoring) ──
// C1 fix: This now uses the SAME shared detection functions as the bot-scanner,
// producing identical scores. The old simplified scoring is replaced.
function runFullAnalysis(candles: Candle[], dailyCandles?: Candle[]) {
  // Core detections (same functions as scanner)
  const structure = analyzeMarketStructure(candles);
  const structureBreaks = [...structure.bos, ...structure.choch];
  const orderBlocks = detectOrderBlocks(candles, structureBreaks);
  const fvgs = detectFVGs(candles, structureBreaks);

  // FVG adjacency bonus (same as scanner)
  for (const ob of orderBlocks) {
    const hasFVGNearby = fvgs.some(f => Math.abs(f.index - ob.index) <= 5);
    (ob as any).hasFVGAdjacency = hasFVGNearby;
  }

  // Uses default ATR-based tolerance (0.20 × ATR) for entry timeframe
  const liquidityPools = detectLiquidityPools(candles);
  const judasSwing = detectJudasSwing(candles);
  const reversalCandle = detectReversalCandle(candles);
  const pd = calculatePremiumDiscount(candles);
  const session = detectSession();
  const pdLevels = dailyCandles ? calculatePDLevels(dailyCandles) : null;
  const lastPrice = candles[candles.length - 1].close;

  // Extended detections (same as scanner)
  const displacement = detectDisplacement(candles);
  tagDisplacementQuality(orderBlocks, fvgs, displacement.displacementCandles);
  const breakerBlocks = detectBreakerBlocks(orderBlocks, candles, structureBreaks);
  const unicornSetups = detectUnicornSetups(breakerBlocks, fvgs);
  const silverBullet = detectSilverBullet();
  const macroWindow = detectMacroWindow();
  const amd = detectAMDPhase(candles);
  const vwap = calculateAnchoredVWAP(candles, 0.0001); // default forex pip

  // ── 21-Factor Confluence Scoring (mirrors scanner exactly) ──
  let score = 0;
  const factors: ReasoningFactor[] = [];

  // Factor 1: Market Structure / BOS/CHoCH (max 1.5)
  {
    let pts = 0;
    let detail = "";
    if (structure.choch.length > 0) {
      pts = 1.5;
      detail = `${structure.choch.length} CHoCH detected — trend reversal confirmed`;
    } else if (structure.bos.length > 0) {
      pts = 1.0;
      detail = `${structure.bos.length} BOS detected — trend continuation`;
    } else {
      detail = "No BOS or CHoCH detected";
    }
    score += pts;
    factors.push({ name: "Market Structure", present: pts > 0, weight: pts, detail, group: "Market Structure" });
  }

  // Factor 2: Order Block (max 2.0)
  {
    let pts = 0;
    let detail = "";
    const activeOBs = orderBlocks.filter(ob => !ob.mitigated);
    const insideOB = activeOBs.find(ob => lastPrice >= ob.low && lastPrice <= ob.high);
    if (insideOB) {
      pts = 2.0;
      const tags: string[] = [];
      if ((insideOB as any).hasDisplacement) tags.push("displacement");
      if ((insideOB as any).hasFVGAdjacency) tags.push("FVG adjacent");
      detail = `Price inside ${insideOB.type} OB at ${fx(insideOB.low)}-${fx(insideOB.high)}`;
      if (tags.length > 0) detail += ` [${tags.join(", ")}]`;
    } else if (activeOBs.length > 0) {
      pts = 0.5;
      detail = `${activeOBs.length} active OBs nearby`;
    } else {
      detail = "No active order blocks";
    }
    score += pts;
    factors.push({ name: "Order Block", present: pts > 0, weight: pts, detail, group: "Order Flow Zones" });
  }

  // Factor 3: Fair Value Gap (max 2.0)
  {
    let pts = 0;
    let detail = "";
    const activeFVGs = fvgs.filter(f => !f.mitigated);
    const insideFVG = activeFVGs.find(f => lastPrice >= f.low && lastPrice <= f.high);
    if (insideFVG) {
      const ce = (insideFVG.high + insideFVG.low) / 2;
      const fvgRange = insideFVG.high - insideFVG.low;
      const distFromCE = Math.abs(lastPrice - ce);
      const nearCE = fvgRange > 0 && (distFromCE / fvgRange) <= 0.15;
      if (nearCE) {
        pts = 2.0;
        detail = `Price at CE (${fx(ce)}) of ${insideFVG.type} FVG — optimal entry`;
      } else {
        pts = 1.5;
        detail = `Price inside ${insideFVG.type} FVG (CE: ${fx(ce)})`;
      }
    } else if (activeFVGs.length > 0) {
      pts = 0.5;
      detail = `${activeFVGs.length} unfilled FVGs in range`;
    } else {
      detail = "No active FVGs";
    }
    score += pts;
    factors.push({ name: "Fair Value Gap", present: pts > 0, weight: pts, detail, group: "Order Flow Zones" });
  }

  // Factor 4: Premium/Discount (max 1.5)
  {
    let pts = 0;
    let detail = "";
    if (pd.currentZone !== "equilibrium") {
      pts = pd.oteZone ? 1.5 : 1.0;
      detail = `Price in ${pd.currentZone} zone (${fx(pd.zonePercent, 0)}%)${pd.oteZone ? " — OTE zone" : ""}`;
    } else {
      detail = "Price at equilibrium";
    }
    score += pts;
    factors.push({ name: "Premium/Discount", present: pts > 0, weight: pts, detail, group: "Price Zones" });
  }

  // Factor 5: Liquidity Sweep (max 1.5)
  {
    let pts = 0;
    let detail = "";
    const sweptPool = liquidityPools.find(lp => lp.swept);
    if (sweptPool) {
      pts = 1.5;
      detail = `${sweptPool.type} liquidity swept at ${fx(sweptPool.price)}`;
    } else if (liquidityPools.length > 0) {
      pts = 0.3;
      detail = `${liquidityPools.length} liquidity pools identified`;
    } else {
      detail = "No liquidity pools detected";
    }
    score += pts;
    factors.push({ name: "Liquidity Sweep", present: pts > 0, weight: pts, detail, group: "Liquidity" });
  }

  // Factor 6: Session/Kill Zone (max 1.0)
  {
    let pts = 0;
    let detail = "";
    if (session.isKillZone) {
      pts = 1.0;
      detail = `${session.name} kill zone active`;
    } else {
      pts = 0.3;
      detail = `${session.name} session (no kill zone)`;
    }
    score += pts;
    factors.push({ name: "Session/Kill Zone", present: pts > 0, weight: pts, detail, group: "Timing" });
  }

  // Factor 7: Judas Swing (max 1.0)
  {
    let pts = 0;
    let detail = "";
    if (judasSwing.detected) {
      pts = judasSwing.confirmed ? 1.0 : 0.5;
      detail = `Judas Swing: ${judasSwing.type}${judasSwing.confirmed ? " (confirmed)" : " (unconfirmed)"}`;
    } else {
      detail = "No Judas Swing detected";
    }
    score += pts;
    factors.push({ name: "Judas Swing", present: pts > 0, weight: pts, detail, group: "Timing" });
  }

  // Factor 8: PD/PW Levels (max 0.5)
  {
    let pts = 0;
    let detail = "";
    if (pdLevels) {
      const { pdh, pdl, pwh, pwl } = pdLevels;
      const nearPD = Math.abs(lastPrice - pdh) / lastPrice < 0.002 || Math.abs(lastPrice - pdl) / lastPrice < 0.002;
      const nearPW = Math.abs(lastPrice - pwh) / lastPrice < 0.003 || Math.abs(lastPrice - pwl) / lastPrice < 0.003;
      if (nearPD) { pts = 0.5; detail = "Price near PD high/low"; }
      else if (nearPW) { pts = 0.3; detail = "Price near PW high/low"; }
      else { pts = 0.1; detail = "PD/PW levels available"; }
    } else {
      detail = "No daily candles for PD/PW";
    }
    score += pts;
    factors.push({ name: "PD/PW Levels", present: pts > 0, weight: pts, detail, group: "Price Zones" });
  }

  // Factor 9: Reversal Candle (max 0.5)
  {
    let pts = 0;
    let detail = "";
    if (reversalCandle.detected) {
      pts = 0.5;
      detail = reversalCandle.pattern ? `${reversalCandle.pattern} detected` : `${reversalCandle.type} reversal candle detected`;
    } else {
      detail = "No reversal candle";
    }
    score += pts;
    factors.push({ name: "Reversal Candle", present: pts > 0, weight: pts, detail, group: "Market Structure" });
  }

  // Factor 10: Displacement (max 1.5)
  {
    let pts = 0;
    let detail = "";
    if (displacement.isDisplacement) {
      pts = 1.5;
      detail = `Displacement: ${displacement.displacementCandles.length} large-body candle(s), last ${displacement.lastDirection}`;
    } else {
      detail = "No displacement detected";
    }
    score += pts;
    factors.push({ name: "Displacement", present: pts > 0, weight: pts, detail, group: "Market Structure" });
  }

  // Factor 11: Breaker Blocks (max 1.0)
  {
    let pts = 0;
    let detail = "";
    if (breakerBlocks.length > 0) {
      pts = 1.0;
      const bbCount = breakerBlocks.filter(b => b.subtype === "breaker").length;
      const mbCount = breakerBlocks.filter(b => b.subtype === "mitigation_block").length;
      const parts: string[] = [];
      if (bbCount > 0) parts.push(`${bbCount} BB`);
      if (mbCount > 0) parts.push(`${mbCount} MB`);
      detail = `${breakerBlocks.length} breaker block(s) detected (${parts.join(", ")})`;
    } else {
      detail = "No breaker blocks";
    }
    score += pts;
    factors.push({ name: "Breaker Blocks", present: pts > 0, weight: pts, detail, group: "Order Flow Zones" });
  }

  // Factor 12: Unicorn Setups (max 1.5)
  {
    let pts = 0;
    let detail = "";
    if (unicornSetups.length > 0) {
      pts = 1.5;
      detail = `${unicornSetups.length} Unicorn setup(s) (breaker + FVG overlap)`;
    } else {
      detail = "No Unicorn setups";
    }
    score += pts;
    factors.push({ name: "Unicorn Setup", present: pts > 0, weight: pts, detail, group: "Order Flow Zones" });
  }

  // Factor 13: Silver Bullet (max 1.0)
  {
    let pts = 0;
    let detail = "";
    if (silverBullet.active) {
      pts = 1.0;
      detail = `Silver Bullet ${silverBullet.window} active`;
    } else {
      detail = "No Silver Bullet window";
    }
    score += pts;
    factors.push({ name: "Silver Bullet", present: pts > 0, weight: pts, detail, group: "Timing" });
  }

  // Factor 14: Macro Time (max 0.5)
  {
    let pts = 0;
    let detail = "";
    if (macroWindow.active) {
      pts = 0.5;
      detail = `Macro time window active`;
    } else {
      detail = "No macro window";
    }
    score += pts;
    factors.push({ name: "Macro Time", present: pts > 0, weight: pts, detail, group: "Timing" });
  }

  // Factor 15: AMD Phase (max 1.0)
  {
    let pts = 0;
    let detail = "";
    if (amd.phase !== "unknown") {
      pts = amd.phase === "distribution" ? 1.0 : 0.5;
      detail = `AMD: ${amd.phase} phase detected`;
    } else {
      detail = "No AMD phase detected";
    }
    score += pts;
    factors.push({ name: "AMD Phase", present: pts > 0, weight: pts, detail, group: "Timing" });
  }

  // Factor 16: VWAP (max 0.5)
  {
    let pts = 0;
    let detail = "";
    if (vwap.value !== null) {
      pts = 0.5;
      const position = lastPrice > vwap.value ? "above" : "below";
      detail = `Price ${position} VWAP (${fx(vwap.value)})`;
    } else {
      detail = "VWAP not available";
    }
    score += pts;
    factors.push({ name: "VWAP", present: pts > 0, weight: pts, detail, group: "Price Zones" });
  }

  // Clamp score to 0-10
  score = Math.min(10, Math.round(score * 10) / 10);

  // Determine direction
  let direction: "long" | "short" | null = null;
  if (structure.trend === "bullish" && pd.currentZone !== "premium") direction = "long";
  else if (structure.trend === "bearish" && pd.currentZone !== "discount") direction = "short";

  const bias = direction === "long" ? "bullish" : direction === "short" ? "bearish" : "neutral";
  const presentFactors = factors.filter(f => f.present);
  const groupNames = [...new Set(factors.filter(f => f.group).map(f => f.group!))];
  const activeGroups = groupNames.filter(g => factors.some(f => f.group === g && f.present));

  const summary = direction
    ? `${direction === "long" ? "BUY" : "SELL"}: ${presentFactors.length}/${factors.length} factors aligned (score: ${score}/10)`
    : `No signal: ${presentFactors.length}/${factors.length} factors (score: ${score}/10)`;

  // Build backward-compatible response + new factor breakdown
  // Legacy fields: confluenceScore, bias, reasoning, structure, orderBlocks, fvgs, etc.
  // New fields: score, direction, factors, summary (same shape as scanner)
  const reasoning = presentFactors.map(f => f.detail);

  return {
    // Legacy fields (backward compat with IctAnalysis.tsx)
    confluenceScore: score,
    bias,
    reasoning,
    structure,
    orderBlocks,
    fvgs,
    liquidityPools,
    pdLevels,
    judasSwing,
    session,
    premiumDiscount: pd,
    // New scanner-equivalent fields
    score,
    direction,
    factors,
    summary,
    lastPrice,
    // Extended detections
    extendedFactors: { displacement, breakerBlocks, unicornSetups, silverBullet, macroWindow, vwap, amd },
    extendedConfluenceScore: score, // now unified — same as main score
    extendedReasoning: reasoning,
    reversalCandle,
  };
}

// ─── HTTP Handler ───────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { action, candles, dailyCandles, pairData, data1, data2, symbol, interval, from, to, legBos, boxes } = body;

    // ── impulse_debug ────────────────────────────────────────────────────
    // Answers one question and changes nothing: for a symbol/timeframe and a
    // date window, what structure exists and which impulses does the engine
    // build from it?
    //
    // Exists because the AUD/USD daily supply zone at 0.70000-0.70584 is on the
    // reference chart and V2 has no bearish block with a March or April origin.
    // Every other explanation has been eliminated — enumeration, candle depth,
    // broken origins, weekend bars — so the remaining question is upstream:
    // does Daily structure even see a bearish break there?
    //
    // Read-only. No table is written, no decision is taken.
    // ── qualification_debug ──────────────────────────────────────────────
    // WHICH single candles qualify as order blocks. Read-only, no thresholds,
    // no selection logic — this produces the evidence a rule would be built
    // from, across every known-good candle at once.
    //
    // Geometry is FROZEN (#572) and is not re-litigated here. The open question
    // is selection: V2 builds one block per leg at the origin, while the
    // reference charts mark the origin AND rebases inside the leg.
    //
    // For each marked candle: find its leg, enumerate EVERY opposite-colour
    // candle in that same leg, and label one marked and the rest not. A rule
    // has to separate them across pairs and legs — a feature that only splits
    // one AUD/USD example is a fit, which is how the causedBreak hypothesis
    // died.
    //
    // Origin and continuation candidates are reported under separate roles and
    // must NOT be assumed to share a rule.
    if (action === "qualification_debug") {
      const targets = Array.isArray(body?.targets) ? body.targets : [];
      const results: any[] = [];

      for (const tgt of targets) {
        const sym = String(tgt.symbol);
        const tf = String(tgt.interval ?? "1d");
        const res = await fetchCandlesWithFallback({ symbol: sym, interval: tf, limit: 800, skipBroker: true });
        const isFx = (SPECS as any)[sym]?.type === "forex";
        const series = dropFxClosedBars(res.candles ?? [], isFx);
        if (series.length < 30) { results.push({ symbol: sym, error: `only ${series.length} bars` }); continue; }

        const struct = analyzeMarketStructure(series);
        const breaks = [...struct.bos.map((b: any) => ({ ...b, kind: "BOS" })),
                        ...struct.choch.map((b: any) => ({ ...b, kind: "CHoCH" }))];
        const fvgs = detectFVGs(series, breaks as any) ?? [];
        const legs = enumerateImpulseLegs(series, tf === "1d" ? "D" : "4H", { includeBrokenOrigin: true });

        const idxAt = (iso: string) => {
          const want = Date.parse(String(iso).endsWith("Z") ? String(iso) : String(iso) + "Z");
          let best = -1, gap = Infinity;
          for (let i = 0; i < series.length; i++) {
            const t = Date.parse(series[i].datetime.endsWith("Z") ? series[i].datetime : series[i].datetime + "Z");
            const g = Math.abs(t - want);
            if (g < gap) { gap = g; best = i; }
          }
          return { i: best, gapHours: Math.round((gap / 3600000) * 100) / 100 };
        };

        const atrAt = (i: number) => {
          const from = Math.max(0, i - 14);
          const sl = series.slice(from, i);
          return sl.length ? sl.reduce((a: number, c: Candle) => a + (c.high - c.low), 0) / sl.length : 0;
        };

        for (const mk of (tgt.marked ?? [])) {
          const { i: markIdx, gapHours } = idxAt(mk.anchorTime);
          if (markIdx < 0) { results.push({ symbol: sym, anchorTime: mk.anchorTime, error: "no bar" }); continue; }

          // AN ORDER BLOCK IS DEFINED BY THE MOVE IT PRECEDES, not the move it
          // sits inside.
          //
          //   supply = an UP candle before a DOWN move    -> bearish leg
          //   demand = a DOWN candle before an UP move    -> bullish leg
          //
          // The first version of this paired each candle with whatever leg
          // contained it and then filtered for "opposite colour to that leg".
          // A supply block is an up candle, so when it sat inside a BULLISH leg
          // it was filtered out as going with the move. Five of seven known-good
          // candles vanished that way — and the two that survived did so only
          // because their containing leg happened to oppose them.
          const markBar = series[markIdx];
          const markIsUp = markBar.close >= markBar.open;
          const side = mk.side ?? (markIsUp ? "supply" : "demand");
          const wantDir = side === "supply" ? "bearish" : "bullish";

          // STRICT association. Three ways a candle can belong to a leg:
          //
          //   startsAt    the leg begins on this candle        (origin)
          //   startsNext  the leg begins on the NEXT candle    (origin; it
          //               launches the move without being counted in it)
          //   contains    the candle sits inside the leg       (continuation)
          //
          // Deliberately NO "nearest future opposing leg" fallback. That would
          // pair a candle with a leg weeks away and report a match, turning the
          // 7/7 check into something that cannot fail — which is worse than a
          // miss, because a miss is visible.
          const opposing = legs.filter((l: any) => l.direction === wantDir);
          let association: string | null = null;
          let leg: any = opposing.find((l: any) => l.startIndex === markIdx);
          if (leg) association = "startsAt";
          if (!leg) {
            leg = opposing.find((l: any) => l.startIndex === markIdx + 1);
            if (leg) association = "startsNext";
          }
          if (!leg) {
            leg = opposing.find((l: any) => markIdx > l.startIndex && markIdx <= l.endIndex);
            if (leg) association = "contains";
          }
          if (!leg) {
            const nearest = opposing
              .map((l: any) => ({ l, d: l.startIndex - markIdx }))
              .sort((a: any, b: any) => Math.abs(a.d) - Math.abs(b.d))[0];
            // ── Forensics: structure miss, or an OB that never became a leg? ──
            //
            // Two explanations compete when no opposing leg exists:
            //
            //   A  the move DID break structure and analyzeMarketStructure
            //      missed it
            //   B  the reference method allows an OB wherever a qualifying
            //      expansion launches, whether or not it ever becomes a formal
            //      BOS/CHoCH leg
            //
            // These need different fixes, so measure rather than assume. The
            // deciding question: did price objectively cross the level a break
            // would require, and on a CLOSE?
            const c0 = series[markIdx];
            const WIN = 15;
            const wEnd = Math.min(markIdx + WIN, series.length - 1);
            const fwd = series.slice(markIdx + 1, wEnd + 1);

            const atrM = (() => {
              const sl = series.slice(Math.max(0, markIdx - 14), markIdx);
              return sl.length ? sl.reduce((a: number, x: Candle) => a + (x.high - x.low), 0) / sl.length : 0;
            })();

            // Favourable = the direction the OB side implies.
            const goesDown = wantDir === "bearish";
            const anchorPx = goesDown ? c0.low : c0.high;
            let ext = goesDown ? Infinity : -Infinity;
            for (const b of fwd) ext = goesDown ? Math.min(ext, b.low) : Math.max(ext, b.high);
            const maxDisp = Number.isFinite(ext) ? Math.abs(ext - anchorPx) : 0;

            // The level a break would have to take out.
            const needType = goesDown ? "low" : "high";
            const priorSwing = struct.swingPoints
              .filter((sp: any) => sp.type === needType && sp.index < markIdx)
              .sort((a: any, b: any) => b.index - a.index)[0];

            let wickCrossed = false, closeCrossed = false, closeCrossBar: string | null = null;
            if (priorSwing) {
              for (const b of fwd) {
                if (goesDown ? b.low < priorSwing.price : b.high > priorSwing.price) wickCrossed = true;
                if (goesDown ? b.close < priorSwing.price : b.close > priorSwing.price) {
                  if (!closeCrossed) closeCrossBar = b.datetime;
                  closeCrossed = true;
                }
              }
            }
            // Match the break to THE SWING UNDER TEST, not merely to direction.
            // Any bearish break in a 15-bar window would otherwise report
            // "structure did emit" while the level we are actually asking about
            // went untouched.
            //
            // StructureBreak.level is the swing that was broken, so the match is
            // on level rather than on the break's own price.
            const inWindow = breaks.filter((b: any) =>
              b.type === wantDir && b.index > markIdx && b.index <= wEnd);
            // EXACT match, not a tolerance. StructureBreak.level and
            // priorSwing.price both come out of the SAME analyzeMarketStructure
            // call, so they are the same float — not two measurements that need
            // reconciling. An ATR-scaled window could span a neighbouring swing
            // and let a break of a different level count as a break of this one,
            // which is the error this whole fix exists to prevent.
            const levelTol = 1e-8;
            // No fallback to b.price. price is where the break was DETECTED;
            // level is the structural level broken. Substituting one for the
            // other would quietly compare the wrong quantity.
            const breaksWithLevel = inWindow.filter((b: any) => typeof b.level === "number");
            const breaksMissingLevel = inWindow.filter((b: any) => typeof b.level !== "number");
            const breakHere = priorSwing
              ? breaksWithLevel.filter((b: any) => Math.abs(b.level - priorSwing.price) <= levelTol)
              : [];
            // Same-direction breaks at OTHER levels. Reported rather than
            // dropped — a break elsewhere is information, it just is not
            // evidence about this swing.
            const otherBreaks = breaksWithLevel.filter((b: any) => !breakHere.includes(b));

            results.push({
              symbol: sym, anchorTime: mk.anchorTime, markedBar: series[markIdx]?.datetime,
              side, requiredLegDirection: wantDir, association: null,
              error: `no ${wantDir} leg starts at, starts after, or contains this candle`,
              markedCandle: { o: c0.open, h: c0.high, l: c0.low, c: c0.close,
                              dir: c0.close >= c0.open ? "up" : "down" },
              // Reported so a near-miss is distinguishable from no leg at all.
              nearestOpposingLeg: nearest
                ? { origin: series[nearest.l.startIndex]?.datetime,
                    bos: series[nearest.l.endIndex]?.datetime,
                    barsToLegStart: nearest.d }
                : null,
              expansionAfter: {
                bars: fwd.length,
                direction: goesDown ? "down" : "up",
                maxDisplacement: Math.round(maxDisp * 100000) / 10,
                displacementAtr: atrM > 0 ? Math.round((maxDisp / atrM) * 100) / 100 : null,
                extremeReached: Number.isFinite(ext) ? ext : null,
              },
              breakItWouldNeed: priorSwing ? {
                swingType: needType,
                swingIndex: priorSwing.index,
                swingTime: series[priorSwing.index]?.datetime,
                swingPrice: priorSwing.price,
                levelMatchTolerance: levelTol,
                matchIsExact: true,
                significance: priorSwing.significance,
                wickCrossed,
                closeCrossed,
                firstCloseCrossBar: closeCrossBar,
              } : null,
              structureEmitted: breakItWouldNeedEmitted(breakHere, series),
              otherSameDirectionBreaksInWindow: breakItWouldNeedEmitted(otherBreaks, series),
              // Surfaced rather than silently excluded: a break with no level
              // cannot be matched, and pretending it was absent would be a
              // different claim from "it could not be tested".
              breaksMissingLevelField: breaksMissingLevel.length
                ? breakItWouldNeedEmitted(breaksMissingLevel, series) : null,
              // The discriminator, stated rather than left to be worked out.
              reading: !priorSwing ? "no prior swing to break — cannot classify"
                : closeCrossed && breakHere.length === 0
                  ? "A: price CLOSED through THIS level and structure emitted no break at it"
                  : closeCrossed && breakHere.length > 0
                    ? "structure DID emit at this level — the leg exists but association still failed"
                    : wickCrossed
                      ? "B: wick only, no close through — no break was due"
                      : "B: expansion never reached the level a break needs",
              nextBars: fwd.slice(0, WIN).map((b: Candle) => ({
                t: b.datetime, o: b.open, h: b.high, l: b.low, c: b.close })),
            });
            continue;
          }
          const barsToLegStart = leg.startIndex - markIdx;

          const legDir = leg.direction;
          const legRange = Math.abs(leg.high - leg.low);
          const cands: any[] = [];

          // Start one bar early when the marked candle sits immediately before
          // the leg it launches — it IS the origin block, and excluding it
          // would reproduce the bug this fix exists for.
          const scanFrom = Math.min(leg.startIndex, markIdx);
          for (let i = scanFrom; i <= Math.min(leg.endIndex, series.length - 1); i++) {
            const c = series[i];
            const isUp = c.close >= c.open;
            const opposes = legDir === "bullish" ? !isUp : isUp;
            // The origin candle counts even when it goes WITH the leg — it is
            // the base V2 already builds from, and must appear for comparison.
            // The leg's own origin is kept even when it goes with the move —
            // it is the base V2 already builds from and the comparison needs it.
            if (!opposes && i !== leg.startIndex && i !== markIdx) continue;

            const atr = atrAt(i);
            const LOOK = 5;
            const end = Math.min(i + LOOK, series.length - 1);
            let ext = legDir === "bullish" ? -Infinity : Infinity;
            for (let j = i + 1; j <= end; j++) {
              ext = legDir === "bullish" ? Math.max(ext, series[j].high) : Math.min(ext, series[j].low);
            }
            const anchorPx = legDir === "bullish" ? c.high : c.low;
            const disp = Number.isFinite(ext) ? Math.abs(ext - anchorPx) : 0;

            // Consecutive opposite run this candle belongs to.
            let runStart = i;
            while (runStart - 1 >= leg.startIndex) {
              const p = series[runStart - 1];
              const pOpp = legDir === "bullish" ? p.close < p.open : p.close >= p.open;
              if (!pOpp) break;
              runStart--;
            }
            const next = series[i + 1];
            const nextWithLeg = next ? (legDir === "bullish" ? next.close >= next.open : next.close < next.open) : false;

            const brk = breaks.filter((b: any) => b.type === legDir && b.index > i && b.index <= end);
            const clearedSwing = struct.swingPoints
              .filter((sp: any) => sp.index < i &&
                (legDir === "bullish" ? sp.type === "high" && ext > sp.price
                                      : sp.type === "low" && ext < sp.price))
              .sort((a: any, b: any) => b.index - a.index)[0];

            const fvg = fvgs.find((f: any) => f.type === legDir && f.index >= i && f.index <= i + 3);

            cands.push({
              t: c.datetime,
              marked: i === markIdx,
              // Directional. A candle AT or BEFORE the leg start launches it;
              // anything after it is inside the move. abs(diff) <= 1 also
              // labelled the bar AFTER the start as an origin, which it is not.
              role: i <= leg.startIndex ? "origin" : "continuation",
              o: c.open, h: c.high, l: c.low, c: c.close,
              dir: isUp ? "up" : "down",
              // ── pullback shape ──
              runLength: i - runStart + 1,
              isLastOfRun: nextWithLeg,
              barsFromLegStart: i - leg.startIndex,
              fractionThroughLeg: leg.endIndex > leg.startIndex
                ? Math.round(((i - leg.startIndex) / (leg.endIndex - leg.startIndex)) * 100) / 100 : 0,
              // ── ATR-normalised size ──
              rangeAtr: atr > 0 ? Math.round(((c.high - c.low) / atr) * 100) / 100 : null,
              bodyAtr: atr > 0 ? Math.round((Math.abs(c.close - c.open) / atr) * 100) / 100 : null,
              // ── displacement after ──
              dispAtr: atr > 0 ? Math.round((disp / atr) * 100) / 100 : null,
              dispFracOfLeg: legRange > 0 ? Math.round((disp / legRange) * 100) / 100 : null,
              // ── structure ──
              causedBreak: brk.length > 0,
              breakKind: brk[0]?.kind ?? null,
              clearedSwing: clearedSwing
                ? { t: series[clearedSwing.index]?.datetime, significance: clearedSwing.significance } : null,
              fvgCreated: !!fvg,
              fvgAtr: fvg && atr > 0 ? Math.round(((fvg.high - fvg.low) / atr) * 100) / 100 : null,
            });
          }

          // Within-leg ranks. Rank 1 = largest. Comparable across pairs in a
          // way raw pips are not.
          const rank = (key: string) => {
            const sorted = [...cands].filter(x => x[key] != null).sort((a, b) => b[key] - a[key]);
            cands.forEach(x => { x[key + "Rank"] = x[key] == null ? null : sorted.indexOf(x) + 1; });
          };
          rank("dispAtr"); rank("rangeAtr"); rank("bodyAtr");

          results.push({
            symbol: sym, interval: tf,
            markedBar: series[markIdx]?.datetime, gapHours, side: mk.side ?? null,
            leg: { direction: legDir, origin: series[leg.startIndex]?.datetime,
                   bos: series[leg.endIndex]?.datetime, bars: leg.endIndex - leg.startIndex,
                   originBroken: leg.originBroken === true },
            association, barsToLegStart,
            markedRole: cands.find((x: any) => x.marked)?.role ?? "NOT AMONG CANDIDATES",
            candidateCount: cands.length,
            candidates: cands,
          });
        }
      }
      // Verification first. Feature analysis is meaningless until every
      // known-good candle actually appears in its own candidate set.
      const found = results.filter((r: any) => r.markedRole && r.markedRole !== "NOT AMONG CANDIDATES").length;
      return respond({
        note: "read-only; no thresholds, no selection logic",
        verification: {
          markedTotal: results.length,
          markedFound: found,
          markedMissing: results.length - found,
          missing: results.filter((r: any) => !r.markedRole || r.markedRole === "NOT AMONG CANDIDATES")
            .map((r: any) => ({ symbol: r.symbol, bar: r.markedBar ?? r.anchorTime, side: r.side, error: r.error ?? null })),
          readyForFeatureAnalysis: found === results.length,
        },
        results,
      });
    }

    if (action === "impulse_debug") {
      const sym = String(symbol ?? "AUD/USD");
      const tf = String(interval ?? "1d");
      const res = await fetchCandlesWithFallback({ symbol: sym, interval: tf, limit: 800, skipBroker: true });
      const raw = res.candles ?? [];
      // Same series V2 reads, so the answer reflects V2 rather than an
      // approximation of it.
      // Asset type from SPECS, not a regex over the symbol. A pattern that
      // accidentally matched an index would silently delete its bars and the
      // box matcher would then fail for a reason that has nothing to do with
      // geometry — the same class of drift as a hardcoded lookback.
      const isForexSym = (SPECS as any)[sym]?.type === "forex";
      const series = dropFxClosedBars(raw, isForexSym);
      const inWin = (dt?: string) => !!dt && (!from || dt >= String(from)) && (!to || dt <= String(to));

      const structure = analyzeMarketStructure(series);
      const breaks = [...structure.bos.map((b: any) => ({ ...b, kind: "BOS" })),
                      ...structure.choch.map((b: any) => ({ ...b, kind: "CHoCH" }))]
        .map((b: any) => ({ ...b, datetime: series[b.index]?.datetime }))
        .filter((b: any) => inWin(b.datetime))
        .sort((a: any, b: any) => a.index - b.index);

      const swings = structure.swingPoints
        .map((sp: any) => ({ ...sp, datetime: series[sp.index]?.datetime }))
        .filter((sp: any) => inWin(sp.datetime));

      // Why a bearish break in the window produced no leg. Mirrors the checks
      // inside validateImpulseFromBOS, which is module-private.
      const rejections = breaks.filter((b: any) => b.type === "bearish").map((b: any) => {
        const candidates = structure.swingPoints
          .filter((sp: any) => sp.type === "high" && sp.index < b.index)
          .sort((a: any, c: any) => c.index - a.index)
          .slice(0, 5);
        if (candidates.length === 0) return { break: b.datetime, reason: "no swing-high candidate before the break" };
        const tried = candidates.map((o: any) => {
          const span = b.index - o.index;
          if (span < 3) return { origin: series[o.index]?.datetime, reject: `leg too short (${span} bars, needs 3)` };
          let hi = -Infinity, lo = Infinity;
          for (let i = o.index; i <= Math.min(b.index, series.length - 1); i++) {
            if (series[i].high > hi) hi = series[i].high;
            if (series[i].low < lo) lo = series[i].low;
          }
          if (!(hi - lo > 0)) return { origin: series[o.index]?.datetime, reject: "zero range" };
          let broken = false;
          for (let j = b.index + 1; j < series.length; j++) {
            if (series[j].close > hi) { broken = true; break; }
          }
          return { origin: series[o.index]?.datetime, accepted: true, originBroken: broken, high: hi, low: lo };
        });
        return { break: b.datetime, price: b.price, tried };
      });

      const legs = enumerateImpulseLegs(series, tf === "1d" ? "D" : "4H", { includeBrokenOrigin: true })
        .filter((l: any) => inWin(series[l.startIndex]?.datetime) || inWin(series[l.endIndex]?.datetime))
        .map((l: any) => ({
          direction: l.direction, origin: series[l.startIndex]?.datetime,
          bos: series[l.endIndex]?.datetime, high: l.high, low: l.low,
          isValid: l.isValid, originBroken: l.originBroken,
        }));

      // ── Track A / Track B for one leg ───────────────────────────────────
      // Which leg: the one whose BOS date matches `legBos`, else the first
      // bearish leg in the window.
      // ── Box matcher ──────────────────────────────────────────────────────
      // Given hand-drawn rectangles as {proximal, distal}, find the single
      // candle each one was drawn from, using the confirmed geometry:
      //
      //   distal = (high + low) / 2   =>   extent = 2*distal - proximal
      //
      // A demand box has proximal above distal, so proximal is the candle high
      // and extent its low; supply is the mirror. Reported in POINTS of error
      // so a match is arithmetic rather than eyeballed.
      //
      // The point is to test the geometry on an instrument it was NOT derived
      // from. It was fitted to three AUD/USD daily boxes; if it reproduces
      // NASDAQ 4H rectangles it is a rule, and if it does not it was a fit.
      const boxMatches = Array.isArray(boxes) ? boxes.map((box: any) => {
        const prox = Number(box.proximal), dist = Number(box.distal);
        const ext = 2 * dist - prox;
        const demand = prox > dist;              // price falls INTO it from above
        const wantHigh = demand ? prox : ext;
        const wantLow = demand ? ext : prox;
        // NOTE ON THE METRICS BELOW.
        //
        //   highOffset - lowOffset
        //     = (high - wantHigh) - (low - wantLow)
        //     = (high - low) - (wantHigh - wantLow)
        //     = actualRange - expectedRange
        //
        // So "shapeErr" and "rangeErr" are ALGEBRAICALLY IDENTICAL. Ranking by
        // both double-counts one quantity and dresses it up as two independent
        // checks. Range agreement alone proves nothing either: any candle in
        // the window with the right range scores perfectly.
        //
        // Range search is therefore DISCOVERY ONLY. Proof needs anchorTime.

        // Expected candle range. A drawn box is half the candle, so the candle
        // spans twice the box.
        const expectedRange = 2 * Math.abs(prox - dist);
        const r2 = (x: number) => Math.round(x * 100) / 100;
        const scored = series
          .map((c: Candle, i: number) => ({ c, i }))
          // Restricted to the requested window. Without this the best match
          // could come from anywhere in 800 bars and look convincing.
          .filter(({ c }: any) => inWin(c.datetime))
          .map(({ c, i }: any) => {
            const highOffset = c.high - wantHigh;
            const lowOffset = c.low - wantLow;
            return {
              i, t: c.datetime, o: c.open, h: c.high, l: c.low, c: c.close,
              dir: c.close >= c.open ? "up" : "down",
              highOffset, lowOffset,
              // FEED-OFFSET INVARIANT. The chart is CME futures; the bot reads
              // cash from TwelveData or Polygon. A constant basis shifts high
              // and low by the SAME amount, so shapeErr stays near zero even
              // when the absolute offsets are tens of points. rangeErr says
              // whether the candle is the right SIZE. Judge the geometry on
              // these two, not on highOffset/lowOffset.
              rangeErr: (c.high - c.low) - expectedRange,
              total: Math.abs((c.high - c.low) - expectedRange),
            };
          })
          .sort((a: any, b: any) => a.total - b.total).slice(0, 3);
        // ── Anchored match: the only evidence that counts ──────────────────
        // Given the bar the box was drawn on, compare THAT candle rather than
        // hunting for one with a convenient range. Feed differences still show
        // up in highOffset/lowOffset, but they no longer decide which candle
        // is being judged.
        let anchored: any = null;
        if (box.anchorTime) {
          const want = Date.parse(String(box.anchorTime).endsWith("Z")
            ? String(box.anchorTime)
            : String(box.anchorTime).replace(" ", "T") + "Z");
          let best: any = null;
          for (let i = 0; i < series.length; i++) {
            const t = Date.parse(series[i].datetime.endsWith("Z")
              ? series[i].datetime : series[i].datetime + "Z");
            const gap = Math.abs(t - want);
            if (!best || gap < best.gap) best = { i, gap, c: series[i] };
          }
          if (best) {
            const c = best.c;
            const highOffset = c.high - wantHigh;
            const lowOffset = c.low - wantLow;
            anchored = {
              anchorTime: box.anchorTime,
              providerTime: c.datetime,
              gapHours: r2(best.gap / 3600000),
              actualHigh: c.high, actualLow: c.low,
              actualRange: r2(c.high - c.low),
              expectedRange: r2(expectedRange),
              rangeErrPoints: r2((c.high - c.low) - expectedRange),
              highOffset: r2(highOffset),
              lowOffset: r2(lowOffset),
              // Identical to rangeErr by construction; reported because it is
              // what the review asked for and makes the identity visible.
              offsetDifference: r2(highOffset - lowOffset),
              dir: c.close >= c.open ? "up" : "down",
              zoneIfChosen: demand
                ? { proximal: c.high, distal: (c.high + c.low) / 2, extent: c.low }
                : { proximal: c.low, distal: (c.high + c.low) / 2, extent: c.high },
            };
          }
        }

        return {
          box: { proximal: prox, distal: dist, anchorTime: box.anchorTime ?? null },
          side: demand ? "demand" : "supply",
          anchored,
          predicted: { high: wantHigh, low: wantLow, extent: ext, expectedRange: r2(expectedRange) },
          rankedBy: "rangeErr only — DISCOVERY, not proof. See anchored below.",
          bestMatches: scored.map((m: any) => ({
            t: m.t, i: m.i, o: m.o, h: m.h, l: m.l, c: m.c, dir: m.dir,
            highOffsetPoints: r2(m.highOffset), lowOffsetPoints: r2(m.lowOffset),
            rangeErrPoints: r2(m.rangeErr),
            candleRange: r2(m.h - m.l),
            // So a rerun can target this candle's leg explicitly rather than
            // relying on whatever the selector picked.
            containingLegBos: null as string | null,
            // What this candle would produce under the confirmed rule.
            zoneIfChosen: demand
              ? { proximal: m.h, distal: (m.h + m.l) / 2, extent: m.l }
              : { proximal: m.l, distal: (m.h + m.l) / 2, extent: m.h },
          })),
        };
      }) : null;

      const allLegs = enumerateImpulseLegs(series, tf === "1d" ? "D" : "4H", { includeBrokenOrigin: true });
      // A base sits BEFORE its leg's origin, so a leg whose origin is just past
      // the window can still own the base being looked for. Widen by a few bars
      // rather than miss it.
      const allLegsForBases = allLegs.filter((l: any) => {
        const o = series[l.startIndex]?.datetime, e = series[l.endIndex]?.datetime;
        const near = (dt?: string) => !!dt && (!from || dt >= String(from)) && (!to || dt <= String(to));
        // Widened by the detector's own base limit, not a literal — a base
        // can start that many bars before its leg's origin, and a hardcoded
        // number here would drift the moment maxBaseCandles changed.
        return near(o) || near(e) ||
          near(series[Math.max(0, l.startIndex - DEFAULT_MAX_BASE_CANDLES)]?.datetime);
      });
      // Which leg the candidate enumeration runs on, chosen EXPLICITLY and
      // reported. Falling back to "first bearish leg in the window" while boxes
      // were supplied would enumerate a leg unrelated to them, and a clean list
      // from the wrong leg reads as a confident negative.
      const legContaining = (idx: number) =>
        allLegs.find((l: any) => idx > l.startIndex && idx <= l.endIndex)
        ?? allLegs.find((l: any) => idx === l.startIndex);
      // Prefer the anchored candle. A range-search winner is discovery only,
      // so selecting a leg from it would build on the weaker signal.
      const firstAnchored = boxMatches?.find((b: any) => b.anchored)?.anchored;
      const firstBoxIdx = firstAnchored
        ? series.findIndex((c: Candle) => c.datetime === firstAnchored.providerTime)
        : boxMatches?.[0]?.bestMatches?.[0]?.i;

      // Now that the legs exist, tell each box which leg its candidate sits in.
      for (const bm of (boxMatches ?? [])) {
        for (const m of bm.bestMatches) {
          const l = allLegs.find((x: any) => m.i > x.startIndex && m.i <= x.endIndex)
                 ?? allLegs.find((x: any) => m.i === x.startIndex);
          m.containingLegBos = l ? (series[l.endIndex]?.datetime ?? null) : null;
        }
      }

      let targetSelection = "none";
      let target: any = undefined;
      if (legBos) {
        target = allLegs.find((l: any) => series[l.endIndex]?.datetime?.startsWith(String(legBos)));
        targetSelection = target ? "explicit legBos" : "legBos supplied but no leg matched";
      } else if (typeof firstBoxIdx === "number") {
        target = legContaining(firstBoxIdx);
        targetSelection = target
          ? `leg containing box 1's ${firstAnchored ? "ANCHORED" : "range-matched"} candle (${series[firstBoxIdx]?.datetime})`
          : `box 1's best candle (${series[firstBoxIdx]?.datetime}) is inside NO enumerated leg`;
      } else {
        target = allLegs.find((l: any) => l.direction === "bearish" && inWin(series[l.endIndex]?.datetime));
        targetSelection = target ? "first bearish leg in window (no boxes supplied)" : "none";
      }

      let trackA: any = { note: "no target leg found" };
      let trackB: any = { note: "no target leg found" };

      if (target) {
        // TRACK A — the origin block.
        const base = findImpulseBase(series, target);
        const alone = detectStructuralOrderBlocks(series, [target], { symbol: sym, timeframe: tf === "1d" ? "D" : "4H" });
        const withAll = detectStructuralOrderBlocks(series, allLegs, { symbol: sym, timeframe: tf === "1d" ? "D" : "4H" });
        const mine = withAll.filter((b: any) => b.baseEndIndex === target.startIndex);
        trackA = {
          leg: { origin: series[target.startIndex]?.datetime, bos: series[target.endIndex]?.datetime,
                 direction: target.direction, originBroken: target.originBroken },
          baseFound: !!base,
          base: base ? {
            startsAt: series[base.startIndex]?.datetime, endsAt: series[base.endIndex]?.datetime,
            candles: base.endIndex - base.startIndex + 1,
            bodyHigh: base.bodyHigh, bodyLow: base.bodyLow,
            wickHigh: base.wickHigh, wickLow: base.wickLow,
            compactnessAtr: Number(base.compactnessAtr?.toFixed(3)),
          } : null,
          blockWhenLegIsAlone: alone.map((b: any) => ({
            proximal: b.proximal, distal: b.distal, status: b.status, score: b.score })),
          survivesFullRun: mine.length > 0,
          // If it exists alone but not in the full run, duplicate suppression
          // took it — so report what could have beaten it.
          overlappingKeptBlocks: alone.length && !mine.length
            ? withAll.filter((b: any) =>
                b.direction === target.direction &&
                Math.min(b.proximal, b.distal) <= Math.max(alone[0].proximal, alone[0].distal) &&
                Math.max(b.proximal, b.distal) >= Math.min(alone[0].proximal, alone[0].distal))
               .map((b: any) => ({ proximal: b.proximal, distal: b.distal, score: b.score,
                                   origin: b.originTime }))
            : [],
        };

        // TRACK B — POIs created INSIDE the leg.
        // mapImpulsePOIs opens with `if (!impulse.isValid) return []`, so a leg
        // whose origin was later broken yields nothing — the same
        // current-setup-vs-inventory rule again. Evaluated here as the leg
        // stood at its BOS, by passing a copy with isValid forced true. The
        // live function is not touched.
        const asAtBos = { ...target, isValid: true };
        const pois = mapImpulsePOIs(series, asAtBos as any);
        const REF_HI = 0.70584, REF_LO = 0.70000;
        trackB = {
          poiCountWithGuard: mapImpulsePOIs(series, target as any).length,
          poiCountAsAtBos: pois.length,
          pois: pois.map((poi: any) => {
            const c = series[poi.candleIndex];
            const bh = c ? Math.max(c.open, c.close) : null;
            const bl = c ? Math.min(c.open, c.close) : null;
            return {
              t: c?.datetime, type: poi.type, direction: poi.direction,
              high: poi.high, low: poi.low, bodyHigh: bh, bodyLow: bl,
              // Distance from the reference box, in pips, on bodies.
              vsReferenceBoxPips: bh != null && bl != null
                ? { top: Math.round((bh - REF_HI) * 100000) / 10,
                    bottom: Math.round((bl - REF_LO) * 100000) / 10 }
                : null,
            };
          }),
        };
      }

      // Raw bars for the window. The reference box on AUD/USD daily is
      // 0.70002 -> 0.70534 anchored at 19 March, while V2's base is 17-18
      // March at 0.70361 -> 0.71033 — one day apart and 35 pips lower. Which
      // candle's body matches the drawn box is a question about the DATA, so
      // print the data.
      const REF = { hi: 0.70534, lo: 0.70002 };
      const barsInWindow = series
        .map((c: Candle, i: number) => ({ i, c }))
        .filter(({ c }: any) => inWin(c.datetime))
        .map(({ i, c }: any) => {
          const bh = Math.max(c.open, c.close), bl = Math.min(c.open, c.close);
          return {
            i, t: c.datetime,
            o: c.open, h: c.high, l: c.low, c: c.close,
            bodyHigh: bh, bodyLow: bl,
            dir: c.close >= c.open ? "up" : "down",
            // Pips from the drawn box, on bodies then on wicks. Whichever pair
            // reads ~0 is the rule being used.
            bodyVsBox: { top: Math.round((bh - REF.hi) * 100000) / 10,
                         bottom: Math.round((bl - REF.lo) * 100000) / 10 },
            wickVsBox: { top: Math.round((c.high - REF.hi) * 100000) / 10,
                         bottom: Math.round((c.low - REF.lo) * 100000) / 10 },
          };
        });

      // findImpulseBase output for EVERY leg touching the window, with the
      // aggregate-vs-body comparison the geometry decision turns on.
      //
      // The reference boxes resolve to: proximal = the extreme price meets
      // first, distal = the 50% of the base's full wick range. Confirmed on
      // four single-candle edges to within 1.4 pips. What is unsettled is
      // whether a MULTI-candle base uses the aggregate wick range or one
      // anchor candle inside it — so print both and let the numbers say.
      const allBases = allLegsForBases.map((l: any) => {
        const b = findImpulseBase(series, l);
        if (!b) return { origin: series[l.startIndex]?.datetime, direction: l.direction, base: null };
        const mid = (b.wickHigh + b.wickLow) / 2;
        const bull = l.direction === "bullish";
        return {
          origin: series[l.startIndex]?.datetime,
          bos: series[l.endIndex]?.datetime,
          direction: l.direction,
          baseStart: series[b.startIndex]?.datetime,
          baseEnd: series[b.endIndex]?.datetime,
          candles: b.endIndex - b.startIndex + 1,
          wickHigh: b.wickHigh, wickLow: b.wickLow,
          bodyHigh: b.bodyHigh, bodyLow: b.bodyLow,
          // What the CURRENT rule produces.
          currentZone: { proximal: bull ? b.bodyHigh : b.bodyLow, distal: bull ? b.bodyLow : b.bodyHigh },
          // What the AGGREGATE wick-range-and-half rule would produce.
          proposedZone: { proximal: bull ? b.wickHigh : b.wickLow, distal: mid },
        };
      });

      // ── Continuation candidates ──────────────────────────────────────────
      // Every opposite-colour candle INSIDE the target leg, with what happened
      // after it. Testing one hypothesis: a continuation block is the last
      // opposite candle before a displacement that has STRUCTURAL CONSEQUENCE,
      // not merely before any push.
      //
      // The reference chart supplies both a positive and a negative on the same
      // leg — 3 April is marked, 10 April is not, and both are down candles
      // inside a bullish move. If 3 April produced a fresh break and 10 April
      // did not, the rule holds.
      let continuationCandidates: any = { note: "no target leg" };
      if (target) {
        const legDir = target.direction;
        const structAll = analyzeMarketStructure(series);
        const breaksAll = [...structAll.bos.map((b: any) => ({ ...b, kind: "BOS" })),
                           ...structAll.choch.map((b: any) => ({ ...b, kind: "CHoCH" }))];
        // 4 bars is arbitrary and, on a daily leg, too short — the 3 April
        // move ran nine bars to its CHoCH. Kept because lengthening it makes
        // causedBreak useless rather than useful: every candidate precedes the
        // same eventual break. Read displacement and rank, not causedBreak.
        const LOOKAHEAD = 4;
        const fvgsAll = detectFVGs(series, breaksAll as any) ?? [];
        const out: any[] = [];
        for (let i = target.startIndex + 1; i < target.endIndex && i < series.length; i++) {
          const c = series[i];
          const isUp = c.close >= c.open;
          const opposes = legDir === "bullish" ? !isUp : isUp;
          if (!opposes) continue;

          // ATR from the 14 bars before the candidate, never including the move
          // it is being measured against.
          const from14 = Math.max(0, i - 14);
          const atrSlice = series.slice(from14, i);
          const atr = atrSlice.length
            ? atrSlice.reduce((a: number, x: Candle) => a + (x.high - x.low), 0) / atrSlice.length : 0;

          // What the next few bars did in the leg's direction.
          const end = Math.min(i + LOOKAHEAD, series.length - 1);
          let ext = legDir === "bullish" ? -Infinity : Infinity;
          for (let j = i + 1; j <= end; j++) {
            ext = legDir === "bullish" ? Math.max(ext, series[j].high) : Math.min(ext, series[j].low);
          }
          const anchor = legDir === "bullish" ? c.high : c.low;
          const displacement = Math.abs(ext - anchor);

          // Did a break of the leg's direction land in that window?
          const caused = breaksAll.filter((b: any) =>
            b.type === legDir && b.index > i && b.index <= end);

          // Which prior swing did the move clear?
          const cleared = structAll.swingPoints.filter((sp: any) => {
            if (sp.index >= i) return false;
            return legDir === "bullish" ? sp.type === "high" && ext > sp.price
                                        : sp.type === "low"  && ext < sp.price;
          }).sort((a: any, b: any) => b.index - a.index).slice(0, 1)
            .map((sp: any) => ({ t: series[sp.index]?.datetime, price: sp.price, significance: sp.significance }));

          // Last opposite candle of its run: the next bar goes with the leg.
          const next = series[i + 1];
          const nextWithLeg = next
            ? (legDir === "bullish" ? next.close >= next.open : next.close < next.open)
            : false;

          // Did an FVG of the leg's direction form at or just after this bar?
          const fvgNear = fvgsAll.some((f: any) =>
            f.type === legDir && f.index >= i && f.index <= i + 3);

          out.push({
            t: c.datetime,
            o: c.open, h: c.high, l: c.low, c: c.close,
            lastOppositeOfPullback: nextWithLeg,
            fvgCreated: fvgNear,
            bodyPips: Math.round(Math.abs(c.close - c.open) * 100000) / 10,
            displacementPips: Math.round(displacement * 100000) / 10,
            atrMultiple: atr > 0 ? Math.round((displacement / atr) * 100) / 100 : null,
            causedBreak: caused.length > 0,
            breaks: caused.map((b: any) => ({ t: series[b.index]?.datetime, kind: b.kind, price: b.price })),
            clearedPriorSwing: cleared,
            // Geometry this candle WOULD produce, for comparison with a drawn box.
            zoneIfChosen: legDir === "bullish"
              ? { proximal: c.high, distal: (c.high + c.low) / 2, extent: c.low }
              : { proximal: c.low, distal: (c.high + c.low) / 2, extent: c.high },
          });
        }
        // Rank by displacement within this leg — 1 is the strongest push after
        // an opposite candle. A rank is comparable across instruments in a way
        // a raw pip figure is not.
        const byDisp = [...out].sort((a, b) => b.displacementPips - a.displacementPips);
        out.forEach((o: any) => { o.displacementRank = byDisp.indexOf(o) + 1; });

        continuationCandidates = {
          leg: { direction: legDir, origin: series[target.startIndex]?.datetime, bos: series[target.endIndex]?.datetime },
          lookaheadBars: LOOKAHEAD,
          candidateCount: out.length,
          candidates: out,
        };
      }

      return respond({
        symbol: sym, interval: tf, window: { from, to },
        source: res.source, rawBars: raw.length, barsAfterWeekendFilter: series.length,
        referenceBox: REF,
        boxMatches,
        targetSelection,
        continuationCandidates,
        allBases,
        barsInWindow,
        trackA, trackB,
        firstBar: series[0]?.datetime, lastBar: series[series.length - 1]?.datetime,
        swingsInWindow: swings.map((s: any) => ({ t: s.datetime, type: s.type, price: s.price, significance: s.significance })),
        breaksInWindow: breaks.map((b: any) => ({ t: b.datetime, kind: b.kind, type: b.type, price: b.price })),
        bearishBreakDiagnosis: rejections,
        legsTouchingWindow: legs,
      });
    }


    if (action === "full_analysis") return respond(runFullAnalysis(candles, dailyCandles));
    if (action === "currency_strength") return respond(calculateCurrencyStrength(pairData || {}));
    if (action === "correlation") return respond({ coefficient: calculateCorrelation(data1 || [], data2 || []) });
    if (action === "structure") return respond(analyzeMarketStructure(candles));
    if (action === "order_blocks") return respond(detectOrderBlocks(candles));
    if (action === "fvgs") {
      const s = analyzeMarketStructure(candles);
      return respond(detectFVGs(candles, [...s.bos, ...s.choch]));
    }
    if (action === "liquidity") return respond(detectLiquidityPools(candles)); // default 0.20 × ATR
    if (action === "session") return respond(detectSession());

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function breakItWouldNeedEmitted(brk: any[], series: any[]) {
  // level is the swing that was broken; price is where the break was detected.
  // closeBased says whether a BODY closed through, which is the same
  // distinction the wick-vs-close test turns on.
  return brk.length === 0 ? null : brk.map((b: any) => ({
    t: series[b.index]?.datetime, kind: b.kind,
    level: b.level ?? null, price: b.price,
    closeBased: b.closeBased ?? null, significance: b.significance ?? null,
  }));
}

function respond(data: any) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
