import { corsHeaders } from "../_shared/cors.ts";
import { provenanceManifest, EVIDENCE_SOURCES } from "../_shared/ipoProvenance.ts";
import { planCorpusInsert, resolveWaveParents, corpusNaturalKey, UnresolvedParentError } from "../_shared/ipoCorpusPlan.ts";
import { detectIPOCandidates, traceIPOCandidateFailure, analyzeLocalConsolidation, traceDepartureOriginHypotheses, originHypothesisBackground, traceEventLocalRecovery, buildIPOInventory, inventorySummary, evaluateDemonstratedCoverage, validateCorpusExamples, inventoryViewBars } from "../_shared/ipoZones.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// Diagnostic only — see the "impulse_debug" action at the bottom of the handler.
import { fetchCandlesWithFallback } from "../_shared/candleSource.ts";
import { enumerateImpulseLegs, mapImpulsePOIs } from "../_shared/impulseZoneEngine.ts";
import { findImpulseBase, detectStructuralOrderBlocks, DEFAULT_MAX_BASE_CANDLES } from "../_shared/structuralOrderBlocks.ts";
import { dropFxClosedBars } from "../_shared/sessions.ts";
import {
  analyzeMarketStructure,
  detectOrderBlocks,
  detectFVGs,
  detectSwingPoints,
  analyzeMarketStructureCanonical,
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
import { buildStructureShadowDiff } from "../_shared/structureShadow.ts";

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
  // SHADOW ONLY — see confluenceScoring. `structure` stays authoritative.
  const structureShadow = buildStructureShadowDiff(
    candles, structure, "smc-analysis.runFullAnalysis",
  );
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
    // Additive shadow diff; null unless the shadow secret is on.
    structureShadow,
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
    // must NOT be assumed to share a rule.    // ── displacement_qualification ───────────────────────────────────────
    // Candidate features WITHOUT requiring an enumerated impulse leg.
    //
    // Labelling, corrected 2026-09-18. Windows around the seven confirmed
    // blocks overlap, so a confirmed block appears inside a neighbour's window.
    // Three labels, not two:
    //
    //   reference       this window's target
    //   known_positive  matches one of the seven confirmed OBs, but is not
    //                   THIS window's target — must never be pooled as a
    //                   negative just because it turned up here
    //   comparison      everything else
    //
    // "comparison", deliberately, NOT "negative". We know the seven recorded
    // boxes are positives. We have NOT established that the reference method
    // rejected every other candle in these windows — it was never asked about
    // them. Treating unexamined candles as proven negatives would invent a
    // label the evidence does not support.
    //
    // Windows are kept overlapping on purpose; de-overlapping would discard
    // real context. The labels, not the geometry, resolve the double-counting.
    //
    //   demand candidate = a DOWN candle   (precedes an up move)
    //   supply candidate = an UP candle    (precedes a down move)
    //
    // No filtering and no thresholds anywhere in here.
    if (action === "displacement_qualification") {
      const targets = Array.isArray(body?.targets) ? body.targets : [];
      const WINDOW = Number(body?.window ?? 15);
      const HORIZONS = [1, 2, 3, 5, 8, 10, 15];
      const out: any[] = [];
      const forensic: any[] = [];

      // Every confirmed block across all targets, so a candidate can be
      // recognised as a positive in a window that is not its own.
      const positiveKey = new Set<string>();
      for (const t of targets) {
        for (const m of (t.marked ?? [])) {
          positiveKey.add(`${t.symbol}|${m.side}|${String(m.anchorTime).slice(0, 10)}`);
        }
      }

      for (const tgt of targets) {
        const sym = String(tgt.symbol);
        const tf = String(tgt.interval ?? "1d");
        const res = await fetchCandlesWithFallback({ symbol: sym, interval: tf, limit: 800, skipBroker: true });
        const isFx = (SPECS as any)[sym]?.type === "forex";
        const series = dropFxClosedBars(res.candles ?? [], isFx);
        if (series.length < 40) { out.push({ symbol: sym, error: `only ${series.length} bars` }); continue; }

        const struct = analyzeMarketStructure(series);
        const allBreaks = [...struct.bos.map((b: any) => ({ ...b, kind: "BOS" })),
                           ...struct.choch.map((b: any) => ({ ...b, kind: "CHoCH" }))];

        const idxAt = (iso: string) => {
          const want = Date.parse(String(iso).endsWith("Z") ? String(iso) : String(iso) + "Z");
          let best = -1, gap = Infinity;
          for (let i = 0; i < series.length; i++) {
            const t = Date.parse(series[i].datetime.endsWith("Z") ? series[i].datetime : series[i].datetime + "Z");
            const g = Math.abs(t - want);
            if (g < gap) { gap = g; best = i; }
          }
          return best;
        };
        const atrAt = (i: number) => {
          const sl = series.slice(Math.max(0, i - 14), i);
          return sl.length ? sl.reduce((a: number, c: Candle) => a + (c.high - c.low), 0) / sl.length : 0;
        };
        const r = (x: number | null, d = 2) => x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;

        // ── FVGs, computed on a LOCAL SLICE ──────────────────────────────
        // detectFVGs() hard-caps itself at the last 50 candles
        // (FVG_RECENCY = 50, startIdx = length - 50). Passing the full 800-bar
        // series returned [] for every historical candidate on the previous
        // run — 0 of 105 — which read as "no FVG here" when in truth the
        // scanner never looked. See the 2026-09-18 finding.
        //
        // So: slice a <=50-bar neighbourhood so startIdx collapses to 2 and the
        // whole slice is scanned. detectFVGs indexes the MIDDLE candle of the
        // three and carries its datetime, so results are matched back by
        // DATETIME rather than by arithmetic on a slice offset.
        //
        // Structure-break indices are full-series and MUST be rebased before
        // being handed to a sliced call; an unremapped index would score
        // quality against the wrong candle.
        const fvgNear = (i: number) => {
          const s0 = Math.max(0, i - 5);
          const s1 = Math.min(series.length, i + 21);   // <= 26 bars
          const slice = series.slice(s0, s1);
          if (slice.length < 3) return [];
          const rebased = allBreaks
            .filter((b: any) => b.index >= s0 && b.index < s1)
            .map((b: any) => ({ index: b.index - s0, type: String(b.type) }));
          const found = detectFVGs(slice, rebased) ?? [];
          // Back to absolute bars by datetime, never by offset arithmetic.
          return found.map((f: any) => {
            const abs = series.findIndex((c: Candle) => c.datetime === f.datetime);
            return { ...f, absIndex: abs };
          }).filter((f: any) => f.absIndex >= 0);
        };

        for (const mk of (tgt.marked ?? [])) {
          const markIdx = idxAt(mk.anchorTime);
          if (markIdx < 0) { out.push({ symbol: sym, anchorTime: mk.anchorTime, error: "no bar" }); continue; }
          const side = String(mk.side);
          const up = side === "supply";            // supply blocks are UP candles
          const favDown = side === "supply";        // and precede a DOWN move

          const lo = Math.max(1, markIdx - WINDOW);
          const hi = Math.min(series.length - 2, markIdx + WINDOW);
          const cands: any[] = [];

          for (let i = lo; i <= hi; i++) {
            const c = series[i];
            const isUp = c.close >= c.open;
            if (isUp !== up) continue;              // same side only

            const atr = atrAt(i);
            const anchorPx = favDown ? c.low : c.high;
            const range = c.high - c.low;

            // Favourable excursion at each horizon.
            const byHorizon: Record<string, number | null> = {};
            let best = favDown ? Infinity : -Infinity, bestBar: number | null = null;
            for (const h of HORIZONS) {
              const end = Math.min(i + h, series.length - 1);
              let ext = favDown ? Infinity : -Infinity;
              for (let j = i + 1; j <= end; j++) {
                const v = favDown ? series[j].low : series[j].high;
                if (favDown ? v < ext : v > ext) ext = v;
                if (favDown ? v < best : v > best) { best = v; bestBar = j; }
              }
              byHorizon["h" + h] = Number.isFinite(ext) && atr > 0
                ? r(Math.abs(ext - anchorPx) / atr) : null;
            }
            const maxDisp = Number.isFinite(best) ? Math.abs(best - anchorPx) : 0;

            let adverse = 0;
            if (bestBar != null) {
              for (let j = i + 1; j <= bestBar; j++) {
                const v = favDown ? series[j].high : series[j].low;
                const a = favDown ? v - anchorPx : anchorPx - v;
                if (a > adverse) adverse = a;
              }
            }

            // ── Three displacement anchors, reported SIDE BY SIDE ────────
            // Terminology, corrected 2026-09-18 against the frozen geometry
            // (structuralOrderBlocks.ts:481-483):
            //
            //   supply (bearish)   proximal = LOW    extent = HIGH
            //   demand (bullish)   proximal = HIGH   extent = LOW
            //
            // proximal is the edge price meets FIRST. So the existing anchor
            // above — supply->low, demand->high — was already proximal. An
            // earlier note in this repo called moving to supply->high
            // "proximal-anchored"; it is extent-anchored, and the two are
            // opposites.
            //
            // Why extent must not quietly replace proximal: extent-anchored
            // displacement mechanically adds the candidate's OWN RANGE to
            // every reading. Measured on GBP/CAD:
            //
            //   08 May   4.90 - 2.69 = 2.21 ATR = its range exactly
            //   11 May   4.21 - 2.91 = 1.30 ATR = its range exactly
            //
            // The difference IS the candle. Switching anchors would therefore
            // hand a free bonus to large candles and manufacture a size bias
            // dressed up as a displacement finding.
            //
            // So all three are reported and NONE overwrites maxDispAtr /
            // adverseAtr, which stay exactly as they were. Which definition
            // represents the qualification question is not yet decided.
            //
            // One difference from the legacy metric, deliberate: favourable
            // excursion here is SIGNED, not absolute. abs() reports a positive
            // displacement even when price never moved favourably at all —
            // it turns adverse movement into apparent displacement. Negative
            // values below mean exactly that: price never went the right way.
            //
            // Adverse is clamped at >= 0 as specified.
            const excursion = (anchorPx2: number) => {
              const byH: Record<string, number | null> = {};
              let ext2 = favDown ? Infinity : -Infinity, extBar: number | null = null;
              for (const h of HORIZONS) {
                const end = Math.min(i + h, series.length - 1);
                let sofar = favDown ? Infinity : -Infinity;
                for (let j = i + 1; j <= end; j++) {
                  const v = favDown ? series[j].low : series[j].high;
                  if (favDown ? v < sofar : v > sofar) sofar = v;
                  if (favDown ? v < ext2 : v > ext2) { ext2 = v; extBar = j; }
                }
                byH["h" + h] = Number.isFinite(sofar) && atr > 0
                  ? r((favDown ? anchorPx2 - sofar : sofar - anchorPx2) / atr) : null;
              }
              let adv = 0;
              const advEnd = extBar ?? Math.min(i + 15, series.length - 1);
              for (let j = i + 1; j <= advEnd; j++) {
                const v = favDown ? series[j].high : series[j].low;
                const a = favDown ? v - anchorPx2 : anchorPx2 - v;
                if (a > adv) adv = a;             // clamped at >= 0
              }
              return {
                disp: byH,
                maxDispAtr: Number.isFinite(ext2) && atr > 0
                  ? r((favDown ? anchorPx2 - ext2 : ext2 - anchorPx2) / atr) : null,
                barsToMax: extBar != null ? extBar - i : null,
                adverseAtr: atr > 0 ? r(adv / atr) : null,
              };
            };
            const proximalPx = favDown ? c.low : c.high;   // edge price meets first
            const extentPx   = favDown ? c.high : c.low;   // far wick extreme
            const exProx = excursion(proximalPx);
            const exExt  = excursion(extentPx);
            const exCls  = excursion(c.close);

            // Consecutive same-side run, both ends.
            let runStart = i;
            while (runStart - 1 >= 0) {
              const p2 = series[runStart - 1];
              if ((p2.close >= p2.open) !== up) break;
              runStart--;
            }
            let runEnd = i;
            while (runEnd + 1 < series.length) {
              const n2 = series[runEnd + 1];
              if ((n2.close >= n2.open) !== up) break;
              runEnd++;
            }
            const nxt = series[i + 1];
            const isLastOfRun = nxt ? ((nxt.close >= nxt.open) !== up) : false;

            // ── Turning-point context ───────────────────────────────────
            // The side that matters is the one price turns from: the HIGH of
            // a supply candle, the LOW of a demand candle.
            const ext = (j: number) => favDown ? series[j].high : series[j].low;
            const better = (a: number, b: number) => favDown ? a > b : a < b;
            const extOver = (a: number, b: number) => {
              let v = ext(Math.max(0, a));
              for (let j = Math.max(0, a); j <= Math.min(series.length - 1, b); j++) {
                if (better(ext(j), v)) v = ext(j);
              }
              return v;
            };
            const mine = ext(i);
            const localBoth = (n: number) => !better(extOver(i - n, i + n), mine);
            const localPast = (n: number) => !better(extOver(i - n, i), mine);
            const prior10 = i - 1 >= 0 ? extOver(i - 10, i - 1) : null;
            // Distance from the local extreme of the two-sided window: 0 means
            // this candle IS the turn.
            const dist10 = atr > 0 ? Math.abs(extOver(i - 10, i + 10) - mine) / atr : null;

            // Liquidity sweep: took out the prior extreme intrabar, then closed
            // back inside it.
            const tookPrior = prior10 != null && better(mine, prior10);
            const closedBack = prior10 != null && tookPrior &&
              (favDown ? c.close < prior10 : c.close > prior10);

            const prev = series[i - 1];
            const outsideBar = prev ? (c.high > prev.high && c.low < prev.low) : null;
            const insideBar = prev ? (c.high <= prev.high && c.low >= prev.low) : null;
            const bodyHi = Math.max(c.open, c.close), bodyLo = Math.min(c.open, c.close);
            const pBodyHi = prev ? Math.max(prev.open, prev.close) : 0;
            const pBodyLo = prev ? Math.min(prev.open, prev.close) : 0;
            const engulfing = prev
              ? (bodyHi >= pBodyHi && bodyLo <= pBodyLo && ((prev.close >= prev.open) !== up))
              : null;

            // Previous same-side candle, and whether this one extended past it.
            let prevSame = -1;
            for (let j = i - 1; j >= Math.max(0, i - 20); j--) {
              if ((series[j].close >= series[j].open) === up) { prevSame = j; break; }
            }
            const extendedPrevSame = prevSame >= 0 ? better(mine, ext(prevSame)) : null;

            // Extreme OF ITS OWN RUN.
            let runExtreme = true;
            for (let j = runStart; j <= runEnd; j++) if (j !== i && better(ext(j), mine)) runExtreme = false;

            // FVGs from the local slice, matched by datetime.
            const near = fvgNear(i);
            const wantDir = favDown ? "bearish" : "bullish";
            const dirFvgs = near.filter((f: any) => f.type === wantDir);
            const selfFvg = dirFvgs.find((f: any) => f.absIndex === i);
            const within = (n: number) => dirFvgs.find((f: any) => f.absIndex > i && f.absIndex <= i + n);
            const firstAfter = dirFvgs.filter((f: any) => f.absIndex >= i)
              .sort((a: any, b: any) => a.absIndex - b.absIndex)[0];

            const needType = favDown ? "low" : "high";
            const sw = struct.swingPoints.filter((sp: any) => sp.type === needType && sp.index < i)
              .sort((a: any, b: any) => b.index - a.index)[0];
            let wickCleared = false, closeCleared = false;
            if (sw) {
              const end = Math.min(i + 15, series.length - 1);
              for (let j = i + 1; j <= end; j++) {
                const b2 = series[j];
                if (favDown ? b2.low < sw.price : b2.high > sw.price) wickCleared = true;
                if (favDown ? b2.close < sw.price : b2.close > sw.price) closeCleared = true;
              }
            }
            const brk = allBreaks.filter((b: any) => b.type === wantDir && b.index > i && b.index <= i + 15);

            // ── SHADOW CANDIDATE DEFINITION — TURN — NOT PRODUCTION ─────
            //
            //   a TURN candidate makes a new past-10 extreme
            //
            // Measured 2026-09-18 on the seven confirmed blocks:
            //
            //   positives   5/5   (all five TURN blocks)
            //   comparison  20/86 (23%)
            //   continuation 0/2
            //
            // Past-only, so it is causal: it uses bars strictly before the
            // candidate and survives the removal of the lookahead version
            // (distFromLocalExtremeAtr, which reads bars on BOTH sides).
            //
            // This is the strongest current TURN discriminator and it is
            // RECORDED, not promoted. Nothing consumes it, there is no
            // threshold on it, and no selector reads it. n=5.
            //
            // Read d5, d10 and prevSameSideExtremeDistAtr as ONE structural
            // measurement, not three confirmations: on 4 of the 5 TURN blocks
            // they are numerically identical, because a candidate ending a
            // same-side run makes the previous same-side candle both the
            // immediately prior bar and the extreme of both past windows.
            // Only GBP/CAD 05-08 separates them — the one TURN block that is
            // not last of its run.
            //
            // ── Archetype features ──────────────────────────────────────
            // The seven positives split into two shapes that should not be
            // pooled: TURN (the candle IS the reversal point) and CONTINUATION
            // (the candle is part of a pullback that the prevailing move then
            // resumes through). Both feature sets are computed for EVERY
            // candidate so the comparison pool can be judged under each, and
            // so it is visible when a turn feature fires on a continuation
            // candle or the reverse.
            //
            // CAUSALITY. Everything here is computed from bars at or before
            // the candidate, except fields explicitly named as outcomes
            // (next*, reversal*, closedBack*, expansion*), which describe what
            // happened AFTER and are outcomes, never inputs.
            //
            // isLocalExtreme5/10 and distFromLocalExtremeAtr above use bars on
            // BOTH sides of the candidate. They are LOOKAHEAD and must not be
            // used as production evidence; the past-only counterparts are
            // newPast5Extreme / newPast10Extreme / distanceFromPastNExtremeAtr.
            //
            // breakEmitted / breakKind are reported but must NOT decide
            // anything yet: #580 proved analyzeMarketStructure can miss a real
            // close through an external swing, so their absence is not
            // evidence of absence.

            // Highest high (supply) / lowest low (demand) over the N bars
            // BEFORE the candidate — strictly past.
            const pastExt = (n: number): number | null => {
              let v: number | null = null;
              for (let j = Math.max(0, i - n); j <= i - 1; j++) {
                const e = ext(j);
                if (v === null || better(e, v)) v = e;
              }
              return v;
            };
            // Signed: POSITIVE means the candidate extended beyond the prior
            // extreme, negative means it fell short of it.
            const signedBeyond = (past: number | null) =>
              past === null || atr <= 0 ? null : r((favDown ? mine - past : past - mine) / atr);
            const past5 = pastExt(5), past10 = pastExt(10);
            const d5 = signedBeyond(past5), d10 = signedBeyond(past10);

            const mid = (c.high + c.low) / 2;
            let midBar: number | null = null;
            for (let j = i + 1; j <= Math.min(i + 5, series.length - 1); j++) {
              if (favDown ? series[j].close < mid : series[j].close > mid) { midBar = j - i; break; }
            }
            // First bar of opposite colour — for a TURN candidate this is the
            // reversal bar itself.
            let foIdx = -1;
            for (let j = i + 1; j <= Math.min(i + 5, series.length - 1); j++) {
              if ((series[j].close >= series[j].open) !== up) { foIdx = j; break; }
            }
            const fo = foIdx >= 0 ? series[foIdx] : null;
            const foRange = fo ? fo.high - fo.low : 0;
            // Close-to-close move in the favourable direction; positive means
            // price reversed away from the candidate.
            const revStrength = (n: number) => {
              const j = Math.min(i + n, series.length - 1);
              if (j <= i || atr <= 0) return null;
              return r((favDown ? c.close - series[j].close : series[j].close - c.close) / atr);
            };

            const turn = {
              distanceFromPast5ExtremeAtr: d5,
              distanceFromPast10ExtremeAtr: d10,
              newPast5Extreme: d5 == null ? null : d5 > 0,
              newPast10Extreme: d10 == null ? null : d10 > 0,
              amountExtendedPastPriorExtremeAtr: d10 == null ? null : r(Math.max(0, d10)),
              runExtreme: runExtreme,
              runPosition: i - runStart + 1,
              runTotal: runEnd - runStart + 1,
              runPositionPct: r((i - runStart + 1) / (runEnd - runStart + 1)),
              prevSameSideExtremeDistAtr: prevSame >= 0 && atr > 0
                ? r((favDown ? mine - ext(prevSame) : ext(prevSame) - mine) / atr) : null,
              prevOppositeBar: prev && ((prev.close >= prev.open) !== up) ? {
                dir: prev.close >= prev.open ? "up" : "down",
                rangeAtr: atr > 0 ? r((prev.high - prev.low) / atr) : null,
                bodyRangeRatio: (prev.high - prev.low) > 0
                  ? r(Math.abs(prev.close - prev.open) / (prev.high - prev.low)) : null,
                engulfedByCandidate: bodyHi >= pBodyHi && bodyLo <= pBodyLo,
              } : null,
              reversalStrength1: revStrength(1),
              reversalStrength2: revStrength(2),
              reversalStrength3: revStrength(3),
              closedBackThroughMidWithin5: midBar != null,
              closedBackThroughMidBars: midBar,
              firstOppositeBarOffset: foIdx >= 0 ? foIdx - i : null,
              firstOppositeBarRangeAtr: fo && atr > 0 ? r(foRange / atr) : null,
              firstOppositeBarBodyRangeRatio: fo && foRange > 0
                ? r(Math.abs(fo.close - fo.open) / foRange) : null,
              firstOppositeBarBodyAtr: fo && atr > 0 ? r(Math.abs(fo.close - fo.open) / atr) : null,
            };

            // ── CONTINUATION: the pullback the candidate sits in ─────────
            // A continuation candidate is a counter-trend candle, so the
            // pullback IS its own colour-run. The prevailing move is the
            // opposite-colour run immediately preceding it.
            let pbPriorStart = runStart - 1;
            if (pbPriorStart >= 0) {
              const priorUp = series[pbPriorStart].close >= series[pbPriorStart].open;
              while (pbPriorStart - 1 >= 0 &&
                     ((series[pbPriorStart - 1].close >= series[pbPriorStart - 1].open) === priorUp)) {
                pbPriorStart--;
              }
            }
            // Price the pullback retraced FROM: the extreme of the prevailing
            // move, in the prevailing direction.
            let refPx: number | null = null, moveOrigin: number | null = null;
            if (runStart - 1 >= 0) {
              for (let j = pbPriorStart; j <= runStart - 1; j++) {
                const v = favDown ? series[j].low : series[j].high;     // prevailing-direction extreme
                if (refPx === null || (favDown ? v < refPx : v > refPx)) refPx = v;
                const w = favDown ? series[j].high : series[j].low;     // where that move began
                if (moveOrigin === null || (favDown ? w > moveOrigin : w < moveOrigin)) moveOrigin = w;
              }
            }
            let pbExtreme: number | null = null;
            for (let j = runStart; j <= runEnd; j++) {
              const v = ext(j);
              if (pbExtreme === null || better(v, pbExtreme)) pbExtreme = v;
            }
            const precedingMoveAtr = refPx != null && moveOrigin != null && atr > 0
              ? r(Math.abs(moveOrigin - refPx) / atr) : null;
            const pbDepthAtr = refPx != null && pbExtreme != null && atr > 0
              ? r(Math.abs(pbExtreme - refPx) / atr) : null;
            const depthAtCandAtr = refPx != null && atr > 0 ? r(Math.abs(mine - refPx) / atr) : null;
            const nd = runEnd + 1 < series.length ? series[runEnd + 1] : null;
            // Internal extreme of the pullback in the PREVAILING direction —
            // the micro swing a resumption has to clear first.
            let microPx: number | null = null;
            for (let j = runStart; j <= Math.min(runEnd, i); j++) {
              const v = favDown ? series[j].low : series[j].high;
              if (microPx === null || (favDown ? v < microPx : v > microPx)) microPx = v;
            }
            let microCleared = false;
            if (microPx != null) {
              for (let j = i + 1; j <= Math.min(i + 5, series.length - 1); j++) {
                if (favDown ? series[j].close < microPx : series[j].close > microPx) { microCleared = true; break; }
              }
            }
            const cont = {
              pullbackRunLength: runEnd - runStart + 1,
              positionInPullback: i - runStart + 1,
              positionInPullbackPct: r((i - runStart + 1) / (runEnd - runStart + 1)),
              isLastOfRun,
              isPullbackExtreme: runExtreme,
              cumulativePullbackDepthAtr: pbDepthAtr,
              depthAtCandidateAtr: depthAtCandAtr,
              precedingMoveAtr,
              pullbackDepthRatio: pbDepthAtr != null && precedingMoveAtr
                ? r(pbDepthAtr / precedingMoveAtr) : null,
              nextDirectionalOffset: nd ? runEnd + 1 - i : null,
              nextDirClosesBeyondCandidate: nd
                ? (favDown ? nd.close < c.low : nd.close > c.high) : null,
              nextDirClosesBeyondPullbackOrigin: nd && refPx != null
                ? (favDown ? nd.close < refPx : nd.close > refPx) : null,
              expansion1: exProx.disp["h1"], expansion2: exProx.disp["h2"], expansion3: exProx.disp["h3"],
              fvgIn1: !!within(1), fvgIn2: !!within(2), fvgIn3: !!within(3),
              microSwingClearedByClose: microCleared,
            };

            // ── EXPLORATORY: "preceded by a rejection candle" ────────────
            // Hypothesis generated from TWO samples, which is not enough to
            // distinguish a real rule from chart-specific coincidence. It is
            // recorded here so it can be tested the moment more confirmed
            // CONTINUATION blocks exist; it is NOT evidence of anything yet
            // and nothing scores or thresholds it.
            //
            // Origin: AUD/USD 02 Apr reached the deeper low of the pullback and
            // was rejected from it (0.62 lower wick on a 0.22 body), and the
            // candle DRAWN was 03 Apr — the next one, smaller and clean-bodied.
            // So the marked candle may be the one that FOLLOWS the rejection
            // rather than the one that makes the extreme.
            //
            // The pullback runs in the candidate's own direction, so the wick
            // that rejects it is on the ext() side: upper for a supply
            // candidate, lower for a demand candidate.
            const pRange = prev ? prev.high - prev.low : 0;
            const pBody = prev ? Math.abs(prev.close - prev.open) : 0;
            const pMid = prev ? (prev.high + prev.low) / 2 : 0;
            const pRejWick = prev ? (favDown ? prev.high - pBodyHi : pBodyLo - prev.low) : 0;
            const rej = prev ? {
              prevRangeAtr: atr > 0 ? r(pRange / atr) : null,
              prevBodyRangeRatio: pRange > 0 ? r(pBody / pRange) : null,
              prevUpperWickRatio: pRange > 0 ? r((prev.high - pBodyHi) / pRange) : null,
              prevLowerWickRatio: pRange > 0 ? r((pBodyLo - prev.low) / pRange) : null,
              // Wick on the pullback side — the one that would reject it.
              prevRejectionWickRatio: pRange > 0 ? r(pRejWick / pRange) : null,
              // Wick longer than the body AND the close pulled back past the
              // midpoint, away from the extreme it reached.
              prevRejectedExtreme: pRange > 0 && pRejWick > pBody &&
                (favDown ? prev.close < pMid : prev.close > pMid),
              // Only meaningful when the previous bar is inside the same
              // pullback run; null rather than false when it is not, so an
              // out-of-run bar cannot read as a measured negative.
              prevWasPullbackExtreme: (i - 1 >= runStart && i - 1 <= runEnd)
                ? !better(extOver(runStart, runEnd), ext(i - 1))
                : null,
              candidateInsidePrevRange: c.high <= prev.high && c.low >= prev.low,
              candidateSameDirectionAsPrev: (prev.close >= prev.open) === up,
              candidateBodyVsPrevBody: pBody > 0 ? r(Math.abs(c.close - c.open) / pBody) : null,
              // "Beyond" means further along the PULLBACK, not favourably.
              candidateClosesBeyondPrevMid: favDown ? c.close > pMid : c.close < pMid,
              nextDirClosesBeyondCandidate: cont.nextDirClosesBeyondCandidate,
            } : null;

            const dayKey = `${sym}|${side}|${c.datetime.slice(0, 10)}`;
            const isPositive = positiveKey.has(dayKey);

            cands.push({
              // ── labels ──
              label: i === markIdx ? "reference" : (isPositive ? "known_positive" : "comparison"),
              referenceMarked: i === markIdx,
              knownPositive: isPositive,
              dedupeKey: dayKey,          // symbol|side|date — for aggregate dedup
              archetype: i === markIdx ? (mk.archetype ?? null) : null,
              turn,
              cont,
              rej,
              side, t: c.datetime,
              // ── candle ──
              o: c.open, h: c.high, l: c.low, c: c.close,
              atr: r(atr, 6),
              rangeAtr: atr > 0 ? r(range / atr) : null,
              bodyAtr: atr > 0 ? r(Math.abs(c.close - c.open) / atr) : null,
              bodyRangeRatio: range > 0 ? r(Math.abs(c.close - c.open) / range) : null,
              upperWickRatio: range > 0 ? r((c.high - bodyHi) / range) : null,
              lowerWickRatio: range > 0 ? r((bodyLo - c.low) / range) : null,
              // ── run ──
              isLastOfRun, runLength: i - runStart + 1, runTotal: runEnd - runStart + 1,
              isRunExtreme: runExtreme,
              extendedPrevSameSide: extendedPrevSame,
              // ── displacement ──
              disp: byHorizon,
              maxDispAtr: atr > 0 ? r(maxDisp / atr) : null,
              barsToMaxDisp: bestBar != null ? bestBar - i : null,
              adverseAtr: atr > 0 ? r(adverse / atr) : null,
              // Three anchors side by side. Legacy maxDispAtr/adverseAtr above
              // are UNCHANGED and still absolute-valued; these are signed.
              proximalDisp: exProx.disp,
              proximalMaxDispAtr: exProx.maxDispAtr,
              proximalBarsToMax: exProx.barsToMax,
              proximalAdverseAtr: exProx.adverseAtr,
              extentDisp: exExt.disp,
              extentMaxDispAtr: exExt.maxDispAtr,
              extentBarsToMax: exExt.barsToMax,
              extentAdverseAtr: exExt.adverseAtr,
              closeDisp: exCls.disp,
              closeMaxDispAtr: exCls.maxDispAtr,
              closeBarsToMax: exCls.barsToMax,
              closeAdverseAtr: exCls.adverseAtr,
              // ── turning point ──
              isLocalExtreme5: localBoth(5), isLocalExtreme10: localBoth(10),
              isLocalExtremePast10: localPast(10),
              distFromLocalExtremeAtr: r(dist10),
              // Renamed from sweptPriorExtreme: it only means the candidate
              // EXCEEDED the prior extreme. sweptAndClosedBack is the actual
              // sweep/rejection concept, and none of the seven positives
              // satisfy it (0/7) — so a sweep is not what defines these.
              extendedPastPriorExtreme: tookPrior, sweptAndClosedBack: closedBack,
              outsideBar, insideBar, engulfing,
              // ── next bars ──
              nextOpposite: nxt ? ((nxt.close >= nxt.open) !== up) : null,
              reversalNextBar: nxt ? (((nxt.close >= nxt.open) !== up) &&
                (favDown ? nxt.close < c.low : nxt.close > c.high)) : null,
              // ── FVG (local slice) ──
              fvgSelf: !!selfFvg,
              fvgIn1: !!within(1), fvgIn2: !!within(2), fvgIn3: !!within(3),
              fvgFirstOffset: firstAfter ? firstAfter.absIndex - i : null,
              fvgAtr: firstAfter && atr > 0 ? r((firstAfter.high - firstAfter.low) / atr) : null,
              // ── structure ──
              swingClearedByWick: sw ? wickCleared : null,
              swingClearedByClose: sw ? closeCleared : null,
              breakEmitted: brk.length > 0, breakKind: brk[0]?.kind ?? null,
            });
          }

          const ranked = [...cands].filter(x => x.maxDispAtr != null)
            .sort((a, b) => b.maxDispAtr - a.maxDispAtr);
          // Window-specific by nature: rank only means anything inside its own
          // window, so it must not be deduplicated away with the rest.
          cands.forEach(x => { x.maxDispRank = x.maxDispAtr == null ? null : ranked.indexOf(x) + 1; });

          out.push({
            symbol: sym, interval: tf, side,
            markedBar: series[markIdx]?.datetime,
            windowBars: WINDOW, candidateCount: cands.length,
            markedFound: cands.some((x: any) => x.referenceMarked),
            candidates: cands,
          });
        }

        // ── forensic: raw bars around named dates ────────────────────────
        for (const fgroup of (body?.forensic ?? [])) {
          if (String(fgroup.symbol) !== sym) continue;
          for (const ds of (fgroup.dates ?? [])) {
            const i = idxAt(ds);
            if (i < 0) continue;
            const bars: any[] = [];
            for (let j = Math.max(0, i - 5); j <= Math.min(series.length - 1, i + 8); j++) {
              const b2 = series[j], rg = b2.high - b2.low;
              const bh = Math.max(b2.open, b2.close), bl = Math.min(b2.open, b2.close);
              bars.push({
                offset: j - i, t: b2.datetime,
                o: b2.open, h: b2.high, l: b2.low, c: b2.close,
                dir: b2.close >= b2.open ? "up" : "down",
                rangeAtr: r((rg) / (atrAt(j) || 1)),
                upperWickRatio: rg > 0 ? r((b2.high - bh) / rg) : null,
                lowerWickRatio: rg > 0 ? r((bl - b2.low) / rg) : null,
                bodyRangeRatio: rg > 0 ? r(Math.abs(b2.close - b2.open) / rg) : null,
              });
            }
            forensic.push({
              symbol: sym, date: String(ds).slice(0, 10), anchorIndex: i,
              atr: r(atrAt(i), 6),
              fvgs: fvgNear(i).map((f: any) => ({
                t: f.datetime, offset: f.absIndex - i, type: f.type,
                high: f.high, low: f.low,
                sizeAtr: r((f.high - f.low) / (atrAt(i) || 1)),
              })),
              swings: struct.swingPoints
                .filter((sp: any) => sp.index >= i - 20 && sp.index <= i + 10)
                .map((sp: any) => ({ offset: sp.index - i, type: sp.type, price: sp.price })),
              breaks: allBreaks
                .filter((b: any) => b.index >= i - 10 && b.index <= i + 15)
                .map((b: any) => ({ offset: b.index - i, kind: b.kind, type: b.type, level: b.level })),
              bars,
            });
          }
        }
      }
      return respond({
        note: "read-only. Labels: reference | known_positive | comparison. " +
              "'comparison' is NOT a proven negative — the reference method was " +
              "never asked about those candles. Dedupe aggregates on dedupeKey; " +
              "maxDispRank is window-specific and must not be deduped. Displacement is reported under THREE anchors (proximal/extent/close); legacy maxDispAtr is unchanged and absolute-valued, the three new families are signed and their adverse is clamped at >= 0.",
        horizons: HORIZONS, out, forensic,
      });
    }

    // ── structure_comparison ─────────────────────────────────────────────
    // READ-ONLY measurement of the current swing-to-swing break detector
    // against a chronological reference. Nothing here changes production
    // behaviour; analyzeMarketStructure is untouched and still the only thing
    // any caller uses.
    //
    // THE DEFECT (#580). analyzeMarketStructure builds break events pairwise
    // between consecutive swings, so the "break candle" is always the NEXT
    // DETECTED SWING rather than the bar that actually closed through. A close
    // through a level that is not followed by a confirmed pivot produces no
    // event at all.
    //
    // THE REFERENCE. Walk bars in order; a swing may be broken by any bar once
    // it is causally knowable.
    //
    // CONFIRMATION, and why it is two-phase. detectSwingPoints confirms a pivot
    // using bars on BOTH sides, so a swing at index k is not knowable until
    // k + lookback. A pivot found by BOTH detectors therefore becomes:
    //
    //     INTERNAL at k + internalLookback
    //     EXTERNAL at k + externalLookback, if still unbroken
    //
    // It must NOT be held back as "external-only" until the external lookback
    // confirms it — doing so would use the future fact that it is going to be
    // external in order to suppress an internal swing that was already legible.
    // That is a subtler lookahead than the one being fixed, so significance is
    // a function of WHEN the question is asked.
    //
    // Simultaneous breaks are deliberately NOT collapsed here. Every active
    // level a bar crosses is recorded, so the frequency of multi-level bars can
    // be measured before any policy is chosen.
    //
    // Sweeps get the same confirmation rule: a swing cannot be swept before it
    // exists. The current separate sweep scan starts at `highs[i].index + 1`,
    // the bar straight after the pivot, so it reports sweeps of levels that
    // were not yet knowable; those are counted as `prematureSweeps`.
    if (action === "structure_comparison") {
      const targets = Array.isArray(body?.targets) ? body.targets : [];
      const out: any[] = [];

      for (const tgt of targets) {
        const sym = String(tgt.symbol);
        const tf = String(tgt.interval ?? "1d");
        const res = await fetchCandlesWithFallback({ symbol: sym, interval: tf, limit: 800, skipBroker: true });
        const isFx = (SPECS as any)[sym]?.type === "forex";
        const series = dropFxClosedBars(res.candles ?? [], isFx);
        if (series.length < 40) { out.push({ symbol: sym, error: `only ${series.length} bars` }); continue; }

        // Mirror analyzeMarketStructure's own parameters exactly.
        const internalLookback = 3;
        const externalLookback = Math.max(internalLookback + 4, 7);
        const hasATR = series.length >= 15;
        const internalSwings = detectSwingPoints(series, internalLookback, hasATR ? 0.2 : 0);
        const externalSwings = detectSwingPoints(series, externalLookback, hasATR ? 0.5 : 0);

        const extKeys = new Set(externalSwings.map((s: any) => `${s.type}_${s.index}`));
        const intKeys = new Set(internalSwings.map((s: any) => `${s.type}_${s.index}`));
        type Sw = {
          key: string; type: "high" | "low"; index: number; price: number;
          internalAt: number | null; externalAt: number | null;
          broken: boolean; brokenAt: number | null; brokenAs: string | null;
        };
        const swMap = new Map<string, Sw>();
        for (const s of [...internalSwings, ...externalSwings] as any[]) {
          const key = `${s.type}_${s.index}`;
          if (swMap.has(key)) continue;
          swMap.set(key, {
            key, type: s.type, index: s.index, price: s.price,
            internalAt: intKeys.has(key) ? s.index + internalLookback : null,
            externalAt: extKeys.has(key) ? s.index + externalLookback : null,
            broken: false, brokenAt: null, brokenAs: null,
          });
        }
        const swings = [...swMap.values()].sort((a, b) => a.index - b.index);
        // Earliest bar at which this swing is knowable at all.
        const activeAt = (s: Sw) => {
          const a = s.internalAt, b = s.externalAt;
          return a === null ? (b ?? Infinity) : (b === null ? a : Math.min(a, b));
        };
        // Significance AS OF bar j — internal first, external once confirmed.
        const sigAt = (s: Sw, j: number) =>
          s.externalAt !== null && j >= s.externalAt ? "external" : "internal";

        // ── chronological pass ────────────────────────────────────────────
        let trend: "bullish" | "bearish" | "ranging" = "ranging";
        const cBos: any[] = [], cChoch: any[] = [], cSweeps: any[] = [];
        const multiBar: { index: number; datetime: string; levels: number }[] = [];
        for (let j = 0; j < series.length; j++) {
          const bar = series[j];
          const crossed = swings.filter(s =>
            !s.broken && s.index < j && activeAt(s) <= j &&
            (s.type === "high" ? bar.close > s.price : bar.close < s.price));
          if (crossed.length > 1) {
            multiBar.push({ index: j, datetime: bar.datetime, levels: crossed.length });
          }
          // Deterministic order: external before internal, then most extreme.
          crossed.sort((a, b) => {
            const sa = sigAt(a, j) === "external" ? 0 : 1, sb = sigAt(b, j) === "external" ? 0 : 1;
            if (sa !== sb) return sa - sb;
            return a.type === "high" ? b.price - a.price : a.price - b.price;
          });
          for (const s of crossed) {
            const dir = s.type === "high" ? "bullish" : "bearish";
            const sig = sigAt(s, j);
            const entry = {
              index: j, datetime: bar.datetime, type: dir, level: s.price,
              significance: sig, swingIndex: s.index, swingTime: series[s.index]?.datetime,
              barsLate: null as number | null,
            };
            const isChoch = (dir === "bullish" && trend === "bearish") ||
                            (dir === "bearish" && trend === "bullish");
            (isChoch ? cChoch : cBos).push(entry);
            trend = dir;
            s.broken = true; s.brokenAt = j; s.brokenAs = isChoch ? "CHoCH" : "BOS";
          }
          // Sweeps, same confirmation rule: wick through an ACTIVE unbroken
          // level, close holding inside.
          for (const s of swings) {
            if (s.broken || s.index >= j || activeAt(s) > j) continue;
            const wickThrough = s.type === "high" ? bar.high > s.price : bar.low < s.price;
            const closeHeld = s.type === "high" ? bar.close <= s.price : bar.close >= s.price;
            if (wickThrough && closeHeld) {
              cSweeps.push({
                index: j, datetime: bar.datetime,
                type: s.type === "high" ? "bearish" : "bullish", sweptLevel: s.price,
              });
            }
          }
        }

        // ── current implementation, untouched ─────────────────────────────
        const cur = analyzeMarketStructure(series);
        const curBreaks = [...cur.bos.map((b: any) => ({ ...b, kind: "BOS" })),
                           ...cur.choch.map((b: any) => ({ ...b, kind: "CHoCH" }))];

        // Premature sweeps in the CURRENT output: a sweep reported before its
        // swing could causally exist.
        const lvlTol = 1e-8;
        let premature = 0;
        const prematureEx: any[] = [];
        for (const sp of (cur.sweeps ?? []) as any[]) {
          const owner = swings.find(s => Math.abs(s.price - sp.sweptLevel) < lvlTol);
          if (owner && sp.index < activeAt(owner)) {
            premature++;
            if (prematureEx.length < 5) {
              prematureEx.push({
                sweepIndex: sp.index, sweepTime: sp.datetime, level: sp.sweptLevel,
                swingIndex: owner.index, knowableAt: activeAt(owner),
                barsEarly: activeAt(owner) - sp.index,
              });
            }
          }
        }

        // Levels the current implementation never reports as broken.
        const curLevels = curBreaks.map((b: any) => b.level);
        const missed = [...cBos, ...cChoch]
          .filter(e => !curLevels.some((L: number) => Math.abs(L - e.level) < lvlTol))
          .sort((a, b) => a.index - b.index);

        // For levels BOTH report: how many bars late is the current one, and
        // did the BOS/CHoCH label change?
        const deltas: any[] = [], reclass: any[] = [];
        for (const e of [...cBos, ...cChoch].sort((a, b) => a.index - b.index)) {
          const m = curBreaks.find((b: any) => Math.abs(b.level - e.level) < lvlTol);
          if (!m) continue;
          const chronoKind = cChoch.includes(e) ? "CHoCH" : "BOS";
          deltas.push({
            level: e.level, chronoIndex: e.index, currentIndex: m.index,
            barsLate: m.index - e.index,
            chronoTime: e.datetime, currentTime: m.datetime,
          });
          if (chronoKind !== m.kind || e.significance !== m.significance) {
            reclass.push({
              level: e.level, chrono: `${chronoKind}/${e.significance}`,
              current: `${m.kind}/${m.significance}`,
            });
          }
        }

        const rate = (n: number, d: number) => d > 0 ? Math.round((n / d) * 1000) / 1000 : 0;
        const nHigh = swings.filter(s => s.type === "high").length;
        const nLow = swings.filter(s => s.type === "low").length;
        const cBull = [...cBos, ...cChoch].filter(e => e.type === "bullish").length;
        const cBear = [...cBos, ...cChoch].filter(e => e.type === "bearish").length;

        out.push({
          symbol: sym, interval: tf, bars: series.length,
          firstBar: series[0]?.datetime, lastBar: series[series.length - 1]?.datetime,
          current: {
            bos: cur.bos.length, choch: cur.choch.length,
            internal: curBreaks.filter((b: any) => b.significance === "internal").length,
            external: curBreaks.filter((b: any) => b.significance === "external").length,
            sweeps: (cur.sweeps ?? []).length,
            prematureSweeps: premature, prematureExamples: prematureEx,
            structureToFractal: cur.structureToFractal,
          },
          chronological: {
            bos: cBos.length, choch: cChoch.length,
            internal: [...cBos, ...cChoch].filter(e => e.significance === "internal").length,
            external: [...cBos, ...cChoch].filter(e => e.significance === "external").length,
            sweeps: cSweeps.length,
            structureToFractal: {
              bullishRate: rate(cBull, Math.max(1, nHigh)),
              bearishRate: rate(cBear, Math.max(1, nLow)),
              totalFractals: nHigh + nLow, totalBreaks: cBull + cBear,
              overallRate: rate(cBull + cBear, Math.max(1, nHigh + nLow)),
            },
          },
          missedByCurrent: { count: missed.length, examples: missed.slice(0, 12) },
          sameBarMultiLevel: {
            bars: multiBar.length,
            maxLevelsOnOneBar: multiBar.reduce((m, x) => Math.max(m, x.levels), 0),
            examples: multiBar.slice(0, 8),
          },
          breakTimingDelta: {
            matched: deltas.length,
            medianBarsLate: deltas.length
              ? deltas.map(d => d.barsLate).sort((a, b) => a - b)[Math.floor(deltas.length / 2)] : null,
            maxBarsLate: deltas.reduce((m, d) => Math.max(m, d.barsLate), 0),
            examples: deltas.slice(0, 10),
          },
          reclassified: { count: reclass.length, examples: reclass.slice(0, 10) },
          // ── Duplicate-level integrity ───────────────────────────────
          // breakTimingDelta matches current-vs-chronological events by LEVEL
          // within 1e-8. If two same-type swings share a price to that
          // tolerance, a match can attach to the wrong one and the timing
          // delta for that level is meaningless.
          //
          // Diagnostic only: the matching logic is NOT changed here. The point
          // is to make the ambiguity visible in the payload so the deltas are
          // not trusted blind.
          integrity: (() => {
            const dupGroups: any[] = [];
            for (const t of ["high", "low"] as const) {
              const byType = swings.filter(s2 => s2.type === t)
                .sort((a, b) => a.price - b.price);
              let run: typeof byType = [];
              const flush = () => {
                if (run.length > 1) {
                  dupGroups.push({
                    type: t, level: run[0].price, count: run.length,
                    swingIndexes: run.map(x => x.index),
                    swingDates: run.map(x => series[x.index]?.datetime ?? null),
                  });
                }
                run = [];
              };
              for (const sw of byType) {
                if (run.length && Math.abs(sw.price - run[0].price) >= lvlTol) flush();
                run.push(sw);
              }
              flush();
            }
            return {
              duplicateSwingLevelCount: dupGroups.reduce((n, g) => n + g.count, 0),
              duplicateSwingLevelGroups: dupGroups.length,
              duplicateSwingLevelExamples: dupGroups.slice(0, 8),
            };
          })(),

          // ── Required real-world case from #580 ──────────────────────
          // The earlier version only asked whether the current implementation
          // EVER emits a break at this level. That hides the defect, because
          // the defect is lateness, not total absence — pairwise event
          // construction reports the break once a new swing confirms on the
          // far side, which can be many bars after the close that caused it.
          //
          // So the current implementation is NOT asserted to miss the level.
          // It may well detect it later, and that lateness is the measurement.
          requiredCase: tgt.requiredCase ? (() => {
            const lvl = Number(tgt.requiredCase.level);
            const tol = Number(tgt.requiredCase.tol ?? 1e-5);
            const want = String(tgt.requiredCase.closeDate);
            const atLevel = (L: number) => Math.abs(L - lvl) < tol;

            const chronoAll = [...cBos, ...cChoch]
              .filter(e => atLevel(e.level)).sort((a, b) => a.index - b.index);
            const chronoOnDate = chronoAll.find(e => e.datetime.slice(0, 10) === want) ?? null;
            const chronoFirst = chronoAll[0] ?? null;

            const curAll = curBreaks.filter((b: any) => atLevel(b.level))
              .sort((a: any, b: any) => a.index - b.index);
            const curOnDate = curAll.find((b: any) => b.datetime.slice(0, 10) === want) ?? null;
            const curFirst = curAll[0] ?? null;

            // Late relative to the chronological detection on the expected
            // date where there is one, otherwise the first chronological hit.
            const baseline = chronoOnDate ?? chronoFirst;
            return {
              level: lvl, expectedCloseDate: want,
              chronologicalDetectsOnExpectedDate: !!chronoOnDate,
              chronologicalIndex: baseline ? baseline.index : null,
              chronologicalDate: baseline ? baseline.datetime : null,
              chronologicalKind: chronoOnDate
                ? (cChoch.includes(chronoOnDate) ? "CHoCH" : "BOS") : null,
              chronologicalSignificance: chronoOnDate ? chronoOnDate.significance : null,
              currentDetectsOnExpectedDate: !!curOnDate,
              currentAnyDetection: !!curFirst,
              currentDetectionDate: curFirst ? curFirst.datetime : null,
              currentIndex: curFirst ? curFirst.index : null,
              currentKind: curFirst ? curFirst.kind : null,
              currentBarsLate: curFirst && baseline ? curFirst.index - baseline.index : null,
            };
          })() : null,
        });
      }
      return respond({
        note: "READ-ONLY. analyzeMarketStructure is unchanged and still the only " +
              "implementation any caller uses. Simultaneous breaks are NOT collapsed. " +
              "Significance is two-phase: internal at index+internalLookback, promoted " +
              "to external at index+externalLookback if still unbroken.",
        out,
      });
    }

    // ── structure_canonical ──────────────────────────────────────────────
    // READ-ONLY. Three streams side by side. analyzeMarketStructure is
    // untouched and remains the only implementation any caller uses.
    //
    //   CURRENT      today's pairwise swing-to-swing detector
    //   LEDGER       every confirmed swing level crossed by a close,
    //                chronologically — the factual lifecycle layer
    //   CANONICAL    BOS/CHoCH events, emitted only by the latest causally
    //                confirmed structural pointer
    //
    // WHY THE SPLIT. #586 conflated two different questions: "was this level
    // crossed" and "was this a market-structure event". Every crossed level was
    // labelled BOS/CHoCH, which inflated the event count roughly threefold.
    // The ledger keeps the facts; only canonical pointers make events.
    //
    // structureToFractal IS NOT A SELECTION TARGET. It has an unbounded
    // historical horizon, so over ~700 bars almost every confirmed swing is
    // eventually crossed and the rate drifts toward 1 as history lengthens.
    // A high value therefore says nothing about permissiveness. It is still
    // emitted for comparison, and deliberately not optimised against. The
    // horizon-bounded lifecycle stats below are the honest version.
    //
    // CANONICAL POINTERS. Four: latest internal high/low, latest external
    // high/low. A swing becomes the pointer for its (type, significance) when
    // it is causally confirmed. Older levels stay in the ledger as liquidity
    // history but can no longer create structure events.
    //
    // TWO-PHASE, unchanged: internal at k+internalLookback, promoted to
    // external at k+externalLookback if still unbroken. Never suppressed
    // pending external confirmation — that would use the future fact that it
    // is going to be external.
    if (action === "structure_canonical") {
      const targets = Array.isArray(body?.targets) ? body.targets : [];
      const out: any[] = [];

      for (const tgt of targets) {
        const sym = String(tgt.symbol);
        const tf = String(tgt.interval ?? "1d");
        const res = await fetchCandlesWithFallback({ symbol: sym, interval: tf, limit: 800, skipBroker: true });
        const isFx = (SPECS as any)[sym]?.type === "forex";
        const series = dropFxClosedBars(res.candles ?? [], isFx);
        if (series.length < 40) { out.push({ symbol: sym, error: `only ${series.length} bars` }); continue; }

        const internalLookback = 3;
        const externalLookback = Math.max(internalLookback + 4, 7);
        const hasATR = series.length >= 15;
        const internalSwings = detectSwingPoints(series, internalLookback, hasATR ? 0.2 : 0);
        const externalSwings = detectSwingPoints(series, externalLookback, hasATR ? 0.5 : 0);
        const intKeys = new Set(internalSwings.map((s: any) => `${s.type}_${s.index}`));
        const extKeys = new Set(externalSwings.map((s: any) => `${s.type}_${s.index}`));

        type Sw = {
          key: string; type: "high" | "low"; index: number; price: number;
          internalAt: number | null; externalAt: number | null;
          broken: boolean; brokenAt: number | null; becameExternal: boolean;
        };
        const swMap = new Map<string, Sw>();
        for (const s of [...internalSwings, ...externalSwings] as any[]) {
          const key = `${s.type}_${s.index}`;
          if (swMap.has(key)) continue;
          swMap.set(key, {
            key, type: s.type, index: s.index, price: s.price,
            internalAt: intKeys.has(key) ? s.index + internalLookback : null,
            externalAt: extKeys.has(key) ? s.index + externalLookback : null,
            broken: false, brokenAt: null, becameExternal: false,
          });
        }
        const swings = [...swMap.values()].sort((a, b) => a.index - b.index);
        const activeAt = (s: Sw) => {
          const a = s.internalAt, b = s.externalAt;
          return a === null ? (b ?? Infinity) : (b === null ? a : Math.min(a, b));
        };
        const sigAt = (s: Sw, j: number) =>
          s.externalAt !== null && j >= s.externalAt ? "external" : "internal";

        const confInt = new Map<number, Sw[]>(), confExt = new Map<number, Sw[]>();
        for (const s of swings) {
          if (s.internalAt !== null) {
            if (!confInt.has(s.internalAt)) confInt.set(s.internalAt, []);
            confInt.get(s.internalAt)!.push(s);
          }
          if (s.externalAt !== null) {
            if (!confExt.has(s.externalAt)) confExt.set(s.externalAt, []);
            confExt.get(s.externalAt)!.push(s);
          }
        }

        const canonPtr: Record<string, Record<string, Sw | null>> = {
          internal: { high: null, low: null }, external: { high: null, low: null },
        };
        const ledger: any[] = [];
        const canonBos: any[] = [], canonChoch: any[] = [];
        const collapsed: any[] = [];
        let brokenBeforeExternalConfirmation = 0;
        let trend: "bullish" | "bearish" | "ranging" = "ranging";

        for (let j = 0; j < series.length; j++) {
          const bar = series[j];
          // Confirmations land BEFORE the break test on the same bar: a pivot
          // confirmed at j is knowable at j's close, and the test uses that close.
          for (const s of (confInt.get(j) ?? [])) canonPtr.internal[s.type] = s;
          for (const s of (confExt.get(j) ?? [])) {
            if (s.broken) { brokenBeforeExternalConfirmation++; continue; }
            s.becameExternal = true;
            canonPtr.external[s.type] = s;
          }

          const crossed = swings.filter(s =>
            !s.broken && s.index < j && activeAt(s) <= j &&
            (s.type === "high" ? bar.close > s.price : bar.close < s.price));
          if (crossed.length === 0) continue;

          // Layer 1 — every crossed level, no BOS/CHoCH label.
          for (const s of crossed) {
            ledger.push({
              index: j, datetime: bar.datetime,
              direction: s.type === "high" ? "bullish" : "bearish",
              level: s.price, significance: sigAt(s, j),
              swingIndex: s.index, swingTime: series[s.index]?.datetime,
              barsFromConfirmation: j - activeAt(s),
              wasCanonical: s === canonPtr.internal[s.type] || s === canonPtr.external[s.type],
            });
          }

          // Layer 2 — canonical pointers only, at most one event per direction.
          for (const dir of ["bullish", "bearish"] as const) {
            const t = dir === "bullish" ? "high" : "low";
            const hitExt = crossed.find(s => s === canonPtr.external[t]);
            const hitInt = crossed.find(s => s === canonPtr.internal[t]);
            const primary = hitExt ?? hitInt;          // EXTERNAL preferred
            if (!primary) continue;
            const others = crossed.filter(s => s !== primary &&
              (s.type === "high" ? "bullish" : "bearish") === dir);
            const isChoch = (dir === "bullish" && trend === "bearish") ||
                            (dir === "bearish" && trend === "bullish");
            const evt = {
              index: j, datetime: bar.datetime, type: dir,
              kind: isChoch ? "CHoCH" : "BOS",
              level: primary.price, significance: sigAt(primary, j),
              swingIndex: primary.index, swingTime: series[primary.index]?.datetime,
              barsFromConfirmation: j - activeAt(primary),
              // Nothing is discarded — the other levels this bar crossed are
              // kept as metadata rather than dropped or emitted separately.
              alsoBrokenLevels: others.map(s => ({
                level: s.price, significance: sigAt(s, j), swingIndex: s.index,
              })),
            };
            (isChoch ? canonChoch : canonBos).push(evt);
            if (others.length > 0) {
              collapsed.push({ index: j, datetime: bar.datetime, direction: dir, alsoBroken: others.length });
            }
            trend = dir;
          }

          for (const s of crossed) { s.broken = true; s.brokenAt = j; }
        }

        // ── horizon-bounded lifecycle, internal and external separately ───
        // A dual-confirmed swing appears in BOTH cohorts, each measured from
        // its own confirmation point. This is the replacement for
        // structureToFractal: a bounded horizon cannot drift toward 1 just
        // because the series is long.
        const cohort = (which: "internal" | "external") => {
          const set = swings.filter(s => which === "internal"
            ? s.internalAt !== null
            : s.externalAt !== null && s.becameExternal);
          const from = (s: Sw) => (which === "internal" ? s.internalAt! : s.externalAt!);
          const lives = set.map(s => s.brokenAt === null ? null : s.brokenAt - from(s));
          const done = lives.filter((x): x is number => x !== null).sort((a, b) => a - b);
          const within = (n: number) => done.filter(x => x <= n).length;
          return {
            total: set.length,
            brokenWithin5Bars: within(5), brokenWithin10Bars: within(10), brokenWithin20Bars: within(20),
            rateWithin5: set.length ? Math.round(within(5) / set.length * 1000) / 1000 : 0,
            rateWithin10: set.length ? Math.round(within(10) / set.length * 1000) / 1000 : 0,
            rateWithin20: set.length ? Math.round(within(20) / set.length * 1000) / 1000 : 0,
            medianBarsFromConfirmationToBreak: done.length ? done[Math.floor(done.length / 2)] : null,
            stillActiveAtEnd: set.length - done.length,
          };
        };

        const cur = analyzeMarketStructure(series);
        const curBreaks = [...cur.bos.map((b: any) => ({ ...b, kind: "BOS" })),
                           ...cur.choch.map((b: any) => ({ ...b, kind: "CHoCH" }))];

        // Duplicate same-type levels make level-matching ambiguous; those
        // levels are EXCLUDED from the timing summary rather than silently
        // distorting it.
        const lvlTol = 1e-8;
        const dupLevels: number[] = [];
        for (const t of ["high", "low"] as const) {
          const byT = swings.filter(s => s.type === t).sort((a, b) => a.price - b.price);
          for (let i2 = 1; i2 < byT.length; i2++) {
            if (Math.abs(byT[i2].price - byT[i2 - 1].price) < lvlTol) {
              dupLevels.push(byT[i2].price);
            }
          }
        }
        const isAmbiguous = (L: number) => dupLevels.some(x => Math.abs(x - L) < lvlTol);

        const canonAll = [...canonBos, ...canonChoch].sort((a, b) => a.index - b.index);
        // Level alone is NOT a sufficient match key. A swing high and a swing
        // low can sit at the same price within tolerance, in which case a
        // bullish break would match a bearish one and silently corrupt
        // missedByCurrent, the timing deltas and the reclassification counts —
        // a "reclassification" that is really two unrelated events. Direction
        // is part of the identity, so match on (type, level).
        const sameBreak = (b: any, e: any) =>
          b.type === e.type && Math.abs(b.level - e.level) < lvlTol;
        const missed = canonAll.filter(e => !curBreaks.some((b: any) => sameBreak(b, e)));
        const deltas: any[] = [], reclass: any[] = [];
        let ambiguousSkipped = 0;
        for (const e of canonAll) {
          const m = curBreaks.find((b: any) => sameBreak(b, e));
          if (!m) continue;
          if (isAmbiguous(e.level)) { ambiguousSkipped++; continue; }
          deltas.push({ level: e.level, canonicalIndex: e.index, currentIndex: m.index,
                        barsLate: m.index - e.index, canonicalTime: e.datetime, currentTime: m.datetime });
          if (e.kind !== m.kind || e.significance !== m.significance) {
            reclass.push({ level: e.level, canonical: `${e.kind}/${e.significance}`,
                           current: `${m.kind}/${m.significance}` });
          }
        }
        const late = deltas.map(x => x.barsLate).sort((a, b) => a - b);

        out.push({
          symbol: sym, interval: tf, bars: series.length,
          current: {
            bos: cur.bos.length, choch: cur.choch.length,
            internal: curBreaks.filter((b: any) => b.significance === "internal").length,
            external: curBreaks.filter((b: any) => b.significance === "external").length,
            structureToFractal: cur.structureToFractal,
          },
          ledger: {
            swingLevelBreaks: ledger.length,
            internal: ledger.filter(x => x.significance === "internal").length,
            external: ledger.filter(x => x.significance === "external").length,
            canonicalShare: ledger.length
              ? Math.round(ledger.filter(x => x.wasCanonical).length / ledger.length * 1000) / 1000 : 0,
          },
          canonical: {
            bos: canonBos.length, choch: canonChoch.length,
            internal: canonAll.filter(e => e.significance === "internal").length,
            external: canonAll.filter(e => e.significance === "external").length,
            sameBarCollapsedEvents: collapsed.length,
            maxAlsoBrokenOnOneEvent: collapsed.reduce((m, x) => Math.max(m, x.alsoBroken), 0),
            missedByCurrent: missed.length,
            missedExamples: missed.slice(0, 8).map(e => ({
              datetime: e.datetime, type: e.type, kind: e.kind,
              level: e.level, significance: e.significance,
            })),
            timing: {
              matched: deltas.length, ambiguousLevelsExcluded: ambiguousSkipped,
              medianBarsLate: late.length ? late[Math.floor(late.length / 2)] : null,
              maxBarsLate: late.length ? late[late.length - 1] : null,
            },
            reclassified: { count: reclass.length, examples: reclass.slice(0, 8) },
          },
          lifecycle: {
            internal: cohort("internal"), external: cohort("external"),
            brokenBeforeExternalConfirmation,
          },
          requiredCase: tgt.requiredCase ? (() => {
            const lvl = Number(tgt.requiredCase.level);
            const tol = Number(tgt.requiredCase.tol ?? 1e-5);
            const want = String(tgt.requiredCase.closeDate);
            const at = (L: number) => Math.abs(L - lvl) < tol;
            const cEvt = canonAll.find(e => at(e.level) && e.datetime.slice(0, 10) === want) ?? null;
            const lEntry = ledger.find(x => at(x.level) && x.datetime.slice(0, 10) === want) ?? null;
            // Same reasoning as sameBreak(): compare like with like. The
            // expected direction comes from the request where given, else from
            // whichever stream found it. If none of the three yields one the
            // lookup degrades to level-only and says so, rather than quietly
            // matching an opposite-direction break at the same price.
            const wantDir: string | null =
              (tgt.requiredCase.direction ? String(tgt.requiredCase.direction) : null)
              ?? (cEvt ? cEvt.type : null) ?? (lEntry ? lEntry.direction : null);
            const curHit = curBreaks
              .filter((b: any) => at(b.level) && (wantDir === null || b.type === wantDir))
              .sort((a: any, b: any) => a.index - b.index)[0] ?? null;
            return {
              level: lvl, expectedCloseDate: want,
              expectedDirection: wantDir,
              directionCheckApplied: wantDir !== null,
              ledgerRecordsOnExpectedDate: !!lEntry,
              ledgerSignificance: lEntry ? lEntry.significance : null,
              canonicalEmitsOnExpectedDate: !!cEvt,
              canonicalKind: cEvt ? cEvt.kind : null,
              canonicalSignificance: cEvt ? cEvt.significance : null,
              canonicalAlsoBroken: cEvt ? cEvt.alsoBrokenLevels.length : null,
              currentAnyDetection: !!curHit,
              currentDetectionDate: curHit ? curHit.datetime : null,
              currentBarsLate: curHit && cEvt ? curHit.index - cEvt.index : null,
            };
          })() : null,
        });
      }
      return respond({
        note: "READ-ONLY. Three streams: CURRENT, LEDGER (every crossed confirmed " +
              "swing, no BOS/CHoCH label), CANONICAL (events from latest confirmed " +
              "pointers only). structureToFractal is emitted for comparison and is " +
              "NOT a selection target — its horizon is unbounded so it drifts toward " +
              "1 with series length. Use the horizon-bounded lifecycle stats instead.",
        out,
      });
    }

    // ── structure_policies ───────────────────────────────────────────────
    // READ-ONLY three-way comparison. Nothing in production consumes the
    // canonical engine; analyzeMarketStructure is untouched and remains the
    // only implementation any caller uses.
    //
    //   current                      today's pairwise swing-to-swing detector
    //   latest_confirmed             one pointer per (significance, type)
    //   latest_unbroken_structural   prior levels retained until broken or
    //                                engulfed by a newer same-type swing
    //
    // The question this is built to answer is narrow: does latest_confirmed
    // retire important structure too aggressively? The supersession block is
    // where the answer lives — every level retired unbroken is recorded, along
    // with whether it was subsequently broken anyway.
    if (action === "structure_policies") {
      const targets = Array.isArray(body?.targets) ? body.targets : [];
      const out: any[] = [];
      const lvlTol = 1e-8;

      for (const tgt of targets) {
        const sym = String(tgt.symbol);
        const tf = String(tgt.interval ?? "1d");
        const res = await fetchCandlesWithFallback({ symbol: sym, interval: tf, limit: 800, skipBroker: true });
        const isFx = (SPECS as any)[sym]?.type === "forex";
        const series = dropFxClosedBars(res.candles ?? [], isFx);
        if (series.length < 40) { out.push({ symbol: sym, error: `only ${series.length} bars` }); continue; }

        const cur = analyzeMarketStructure(series);
        const curBreaks = [...cur.bos.map((b: any) => ({ ...b, kind: "BOS" })),
                           ...cur.choch.map((b: any) => ({ ...b, kind: "CHoCH" }))];

        // Direction is part of a break's identity: a swing high and a swing low
        // can share a price, and matching on level alone would pair a bullish
        // break with a bearish one — hiding a real miss inside missedByCurrent
        // while inflating the reclassification count.
        const sameBreak = (a: any, b: any) =>
          a.type === b.type && Math.abs(a.level - b.level) < lvlTol;

        const shaped = (policy: "latest_confirmed" | "latest_unbroken_structural") => {
          const st = analyzeMarketStructureCanonical(series, { policy });
          const all = [...st.bos, ...st.choch].sort((a, b) => a.index - b.index);

          // Ambiguous levels are excluded from the timing summary rather than
          // silently distorting it.
          const dup: number[] = [];
          for (const t2 of ["high", "low"] as const) {
            const byT = st.swingPoints.filter(s => s.type === t2)
              .sort((a, b) => a.price - b.price);
            for (let i2 = 1; i2 < byT.length; i2++) {
              if (Math.abs(byT[i2].price - byT[i2 - 1].price) < lvlTol) dup.push(byT[i2].price);
            }
          }
          const ambiguous = (L: number) => dup.some(x => Math.abs(x - L) < lvlTol);

          const missed = all.filter(e => !curBreaks.some((b: any) => sameBreak(b, e)));
          const late: number[] = []; let ambigSkipped = 0, reclass = 0;
          for (const e of all) {
            const m = curBreaks.find((b: any) => sameBreak(b, e));
            if (!m) continue;
            if (ambiguous(e.level as number)) { ambigSkipped++; continue; }
            late.push(m.index - e.index);
            const kind = st.choch.includes(e) ? "CHoCH" : "BOS";
            if (kind !== m.kind || e.significance !== m.significance) reclass++;
          }
          late.sort((a, b) => a - b);

          return {
            policy,
            bos: st.bos.length, choch: st.choch.length, total: all.length,
            internal: all.filter(e => e.significance === "internal").length,
            external: all.filter(e => e.significance === "external").length,
            swingLevelBreaks: st.swingLevelBreaks.length,
            structuralShare: st.swingLevelBreaks.length
              ? Math.round(st.swingLevelBreaks.filter((x: any) => x.wasStructural).length /
                           st.swingLevelBreaks.length * 1000) / 1000 : 0,
            sameBarCollapsedEvents: st.structureCounts.sameBarCollapsedEvents,
            maxAlsoBrokenOnOneEvent: st.structureCounts.maxAlsoBrokenOnOneEvent,
            sweeps: st.sweeps.length,
            missedByCurrent: missed.length,
            missedExamples: missed.slice(0, 6).map(e => ({
              datetime: e.datetime, type: e.type, level: e.level, significance: e.significance,
            })),
            timing: {
              matched: late.length, ambiguousLevelsExcluded: ambigSkipped,
              medianBarsLate: late.length ? late[Math.floor(late.length / 2)] : null,
              maxBarsLate: late.length ? late[late.length - 1] : null,
            },
            reclassified: reclass,
            supersessionSummary: st.supersessionSummary,
            supersessionExamples: st.supersessions.slice(0, 6),
            lifecycle: st.lifecycle,
            structureToFractal: st.structureToFractal,
            requiredCase: tgt.requiredCase ? (() => {
              const lvl = Number(tgt.requiredCase.level);
              const tol = Number(tgt.requiredCase.tol ?? 1e-5);
              const want = String(tgt.requiredCase.closeDate);
              const dir = tgt.requiredCase.direction ? String(tgt.requiredCase.direction) : null;
              const hit = all.find(e =>
                Math.abs((e.level as number) - lvl) < tol &&
                (e.datetime ?? "").slice(0, 10) === want &&
                (dir === null || e.type === dir)) ?? null;
              return {
                detectsOnExpectedDate: !!hit,
                kind: hit ? (st.choch.includes(hit) ? "CHoCH" : "BOS") : null,
                significance: hit ? hit.significance : null,
                index: hit ? hit.index : null,
                alsoBroken: hit ? ((hit as any).alsoBrokenLevels ?? []).length : null,
              };
            })() : null,
          };
        };

        out.push({
          symbol: sym, interval: tf, bars: series.length,
          current: {
            bos: cur.bos.length, choch: cur.choch.length,
            total: curBreaks.length,
            internal: curBreaks.filter((b: any) => b.significance === "internal").length,
            external: curBreaks.filter((b: any) => b.significance === "external").length,
            sweeps: (cur.sweeps ?? []).length,
            structureToFractal: cur.structureToFractal,
            requiredCase: tgt.requiredCase ? (() => {
              const lvl = Number(tgt.requiredCase.level);
              const tol = Number(tgt.requiredCase.tol ?? 1e-5);
              const dir = tgt.requiredCase.direction ? String(tgt.requiredCase.direction) : null;
              const hit = curBreaks.filter((b: any) =>
                Math.abs(b.level - lvl) < tol && (dir === null || b.type === dir))
                .sort((a: any, b: any) => a.index - b.index)[0] ?? null;
              return { anyDetection: !!hit, detectionDate: hit ? hit.datetime : null };
            })() : null,
          },
          policies: [shaped("latest_confirmed"), shaped("latest_unbroken_structural")],
        });
      }
      return respond({
        note: "READ-ONLY shadow. analyzeMarketStructure is unchanged and still the " +
              "only implementation any production caller uses. structureToFractal is " +
              "reported for comparison only and is NOT a selection target — its " +
              "horizon is unbounded so it drifts toward 1 with series length. Use the " +
              "bounded lifecycle block. Still-active counts are right-censored; read " +
              "activeByAge, not the raw total.",
        out,
      });
    }

    // ── structure_event_ages ─────────────────────────────────────────────
    // READ-ONLY. How OLD is the structural level at the moment an event fires,
    // and specifically for events that exist under latest_unbroken_structural
    // but not under latest_confirmed.
    //
    // No age cutoff is applied or proposed here. The point is to find out
    // whether LUS-only events come from fresh structure or from levels that
    // have been sitting unbroken for hundreds of bars, and whether those old
    // levels were untouched (meaningful) or repeatedly wicked (worked
    // liquidity). A threshold chosen before seeing that distribution would be
    // the same mistake as reading a 2.2 ATR rule off four samples.
    if (action === "structure_event_ages") {
      const targets = Array.isArray(body?.targets) ? body.targets : [];
      const out: any[] = [];

      const pct = (xs: number[], q: number) =>
        xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * q))] : null;
      const buckets = (xs: number[]) => ({
        "0-5": xs.filter(x => x <= 5).length,
        "6-10": xs.filter(x => x >= 6 && x <= 10).length,
        "11-20": xs.filter(x => x >= 11 && x <= 20).length,
        "21-50": xs.filter(x => x >= 21 && x <= 50).length,
        "51-100": xs.filter(x => x >= 51 && x <= 100).length,
        "101-250": xs.filter(x => x >= 101 && x <= 250).length,
        ">250": xs.filter(x => x > 250).length,
      });
      const spread = (evts: any[]) => {
        const xs = evts.map(e => e.barsSinceConfirmation).sort((a, b) => a - b);
        return {
          count: xs.length, ageBuckets: buckets(xs),
          median: pct(xs, 0.5), p75: pct(xs, 0.75), p90: pct(xs, 0.9),
          max: xs.length ? xs[xs.length - 1] : null,
        };
      };

      for (const tgt of targets) {
        const sym = String(tgt.symbol);
        const tf = String(tgt.interval ?? "1d");
        const res = await fetchCandlesWithFallback({ symbol: sym, interval: tf, limit: 800, skipBroker: true });
        const isFx = (SPECS as any)[sym]?.type === "forex";
        const series = dropFxClosedBars(res.candles ?? [], isFx);
        if (series.length < 40) { out.push({ symbol: sym, error: `only ${series.length} bars` }); continue; }

        const lc = analyzeMarketStructureCanonical(series, { policy: "latest_confirmed" });
        const lus = analyzeMarketStructureCanonical(series, { policy: "latest_unbroken_structural" });
        const evs = (st: any) => [...st.bos, ...st.choch].sort((a: any, b: any) => a.index - b.index);
        // Identity is the SWING that broke plus the bar it broke on. Level
        // alone is not enough — two policies can emit on the same bar for
        // different swings, and a swing high and low can share a price.
        const key = (e: any) => `${e.swingIndex}_${e.index}_${e.direction}`;
        const lcE = evs(lc), lusE = evs(lus);
        const lcKeys = new Set(lcE.map(key)), lusKeys = new Set(lusE.map(key));

        const shared = lusE.filter((e: any) => lcKeys.has(key(e)));
        const lcOnly = lcE.filter((e: any) => !lusKeys.has(key(e)));
        const lusOnly = lusE.filter((e: any) => !lcKeys.has(key(e)));

        const slim = (e: any) => ({
          policy: e.policy, kind: e.kind, direction: e.direction,
          significance: e.significance, level: e.level,
          swingIndex: e.swingIndex, swingConfirmedAt: e.swingConfirmedAt,
          eventAt: e.eventAt, barsSinceConfirmation: e.barsSinceConfirmation,
          swingAgeBars: e.swingAgeBars, interaction: e.interaction,
        });
        const inter = (evts: any[]) => ({
          neverTouchedSinceConfirmation: evts.filter(e => e.interaction?.neverTouchedSinceConfirmation).length,
          previouslyWickedThrough: evts.filter(e => e.interaction?.previouslyWickedThrough).length,
          touchedButNotWicked: evts.filter(e => e.interaction?.touchedButNotWicked).length,
          medianWickCount: (() => {
            const v = evts.map(e => e.interaction?.wickCount ?? 0).sort((a, b) => a - b);
            return v.length ? v[Math.floor(v.length / 2)] : null;
          })(),
        });

        out.push({
          symbol: sym, bars: series.length,
          counts: { sharedByBoth: shared.length, latestConfirmedOnly: lcOnly.length, latestUnbrokenOnly: lusOnly.length },
          ages: {
            sharedByBoth: spread(shared),
            latestConfirmedOnly: spread(lcOnly),
            latestUnbrokenOnly: spread(lusOnly),
          },
          latestUnbrokenOnlyBySignificance: {
            internal: spread(lusOnly.filter((e: any) => e.significance === "internal")),
            external: spread(lusOnly.filter((e: any) => e.significance === "external")),
          },
          latestUnbrokenOnlyByKind: {
            BOS: spread(lusOnly.filter((e: any) => e.kind === "BOS")),
            CHoCH: spread(lusOnly.filter((e: any) => e.kind === "CHoCH")),
          },
          latestUnbrokenOnlyInteraction: {
            all: inter(lusOnly),
            internal: inter(lusOnly.filter((e: any) => e.significance === "internal")),
            external: inter(lusOnly.filter((e: any) => e.significance === "external")),
            oldestQuartile: inter([...lusOnly]
              .sort((a: any, b: any) => b.barsSinceConfirmation - a.barsSinceConfirmation)
              .slice(0, Math.ceil(lusOnly.length / 4))),
          },
          sharedInteraction: inter(shared),
          supersessionSemantics: {
            latest_confirmed: lc.supersessionSummary,
            latest_unbroken_structural: lus.supersessionSummary,
          },
          examples: {
            oldestLatestUnbrokenOnly: [...lusOnly]
              .sort((a: any, b: any) => b.barsSinceConfirmation - a.barsSinceConfirmation)
              .slice(0, 5).map(slim),
            youngestLatestUnbrokenOnly: [...lusOnly]
              .sort((a: any, b: any) => a.barsSinceConfirmation - b.barsSinceConfirmation)
              .slice(0, 3).map(slim),
          },
          requiredCase: tgt.requiredCase ? (() => {
            const lvl = Number(tgt.requiredCase.level);
            const tol = Number(tgt.requiredCase.tol ?? 1e-5);
            const want = String(tgt.requiredCase.closeDate);
            const dir = tgt.requiredCase.direction ? String(tgt.requiredCase.direction) : null;
            const find = (list: any[]) => list.find((e: any) =>
              Math.abs(e.level - lvl) < tol && (e.eventAt ?? "").slice(0, 10) === want &&
              (dir === null || e.direction === dir)) ?? null;
            const a = find(lcE), b = find(lusE);
            return {
              latest_confirmed: a ? { kind: a.kind, significance: a.significance,
                barsSinceConfirmation: a.barsSinceConfirmation, swingAgeBars: a.swingAgeBars } : null,
              latest_unbroken_structural: b ? { kind: b.kind, significance: b.significance,
                barsSinceConfirmation: b.barsSinceConfirmation, swingAgeBars: b.swingAgeBars } : null,
              classification: a && b ? "sharedByBoth" : (a ? "latestConfirmedOnly" : (b ? "latestUnbrokenOnly" : "MISSING")),
            };
          })() : null,
        });
      }
      return respond({
        note: "READ-ONLY. No age cutoff applied or proposed. Event identity is " +
              "(swingIndex, eventBar, direction) — level alone is insufficient. " +
              "Supersession semantics: the LUS engulfment rule compares swing " +
              "PRICES (wick extremes) while breaks require a CLOSE, and " +
              "replacementClosedBeyondOldLevel vs replacementOnlyWickedBeyondOldLevel " +
              "measures that mismatch rather than fixing it.",
        out,
      });
    }

    // ── structure_recency ────────────────────────────────────────────────
    // READ-ONLY. Four shadow variants of latest_unbroken_structural, differing
    // only in how old a level may be and still emit a BOS/CHoCH.
    //
    // Age is eventBar - swingConfirmationBar, NOT age from the pivot candle: a
    // swing is not knowable until it confirms, so its life as usable structure
    // starts there.
    //
    // NO CUTOFF IS CHOSEN. The caps exist to be compared. Picking one before
    // seeing which events each removes would repeat the mistake this whole
    // investigation keeps guarding against.
    //
    // Exceeding a cap does not delete a level, mark it broken, or remove it
    // from the factual ledger. It stays in swingLevelBreaks, stays sweepable,
    // and is still carried as alsoBrokenLevels metadata on whatever event does
    // fire. It merely stops being able to emit. Ledger entries carry
    // structureEventEligible so the layers stay distinguishable — and the
    // ledger must be IDENTICAL across all four variants, which is asserted
    // below rather than assumed.
    if (action === "structure_recency") {
      const targets = Array.isArray(body?.targets) ? body.targets : [];
      const out: any[] = [];
      const CAPS: Array<[string, number | null]> = [
        ["LUS_unbounded", null], ["LUS_maxAge20", 20],
        ["LUS_maxAge50", 50], ["LUS_maxAge100", 100],
      ];

      for (const tgt of targets) {
        const sym = String(tgt.symbol);
        const tf = String(tgt.interval ?? "1d");
        const res = await fetchCandlesWithFallback({ symbol: sym, interval: tf, limit: 800, skipBroker: true });
        const isFx = (SPECS as any)[sym]?.type === "forex";
        const series = dropFxClosedBars(res.candles ?? [], isFx);
        if (series.length < 40) { out.push({ symbol: sym, error: `only ${series.length} bars` }); continue; }

        const evs = (st: any) => [...st.bos, ...st.choch].sort((a: any, b: any) => a.index - b.index);
        const key = (e: any) => `${e.swingIndex}_${e.index}_${e.direction}`;

        const lc = analyzeMarketStructureCanonical(series, { policy: "latest_confirmed" });
        const lcKeys = new Set(evs(lc).map(key));

        const runs = CAPS.map(([name, cap]) => {
          const st = analyzeMarketStructureCanonical(series, {
            policy: "latest_unbroken_structural", maxEventAgeBars: cap,
          });
          return { name, cap, st, events: evs(st) };
        });
        const base = runs[0];                       // LUS_unbounded
        const baseKeys = new Set(base.events.map(key));

        const ageBuckets = (xs: number[]) => ({
          "21-50": xs.filter(x => x >= 21 && x <= 50).length,
          "51-100": xs.filter(x => x >= 51 && x <= 100).length,
          "101-250": xs.filter(x => x >= 101 && x <= 250).length,
          ">250": xs.filter(x => x > 250).length,
          "<=20": xs.filter(x => x <= 20).length,
        });

        const policies = runs.map(r => {
          const ks = new Set(r.events.map(key));
          const removed = base.events.filter((e: any) => !ks.has(key(e)));
          const unique = r.events.filter((e: any) => !baseKeys.has(key(e)));
          const ages = removed.map((e: any) => e.barsSinceConfirmation);
          return {
            name: r.name, maxEventAgeBars: r.cap,
            bos: r.st.bos.length, choch: r.st.choch.length, total: r.events.length,
            internal: r.events.filter((e: any) => e.significance === "internal").length,
            external: r.events.filter((e: any) => e.significance === "external").length,
            suppressed: {
              total: removed.length,
              bos: removed.filter((e: any) => e.kind === "BOS").length,
              choch: removed.filter((e: any) => e.kind === "CHoCH").length,
              internal: removed.filter((e: any) => e.significance === "internal").length,
              external: removed.filter((e: any) => e.significance === "external").length,
              ageBuckets: ageBuckets(ages),
              bosByAge: ageBuckets(removed.filter((e: any) => e.kind === "BOS")
                .map((e: any) => e.barsSinceConfirmation)),
              chochByAge: ageBuckets(removed.filter((e: any) => e.kind === "CHoCH")
                .map((e: any) => e.barsSinceConfirmation)),
              oldestRemoved: ages.length ? Math.max(...ages) : null,
              youngestRemoved: ages.length ? Math.min(...ages) : null,
            },
            sharedWithUnboundedLUS: r.events.filter((e: any) => baseKeys.has(key(e))).length,
            sharedWithLatestConfirmed: r.events.filter((e: any) => lcKeys.has(key(e))).length,
            uniqueToThisPolicy: unique.length,
            uniqueExamples: unique.slice(0, 4).map((e: any) => ({
              eventAt: e.eventAt, kind: e.kind, significance: e.significance,
              level: e.level, barsSinceConfirmation: e.barsSinceConfirmation,
            })),
            requiredCase: tgt.requiredCase ? (() => {
              const lvl = Number(tgt.requiredCase.level);
              const tol = Number(tgt.requiredCase.tol ?? 1e-5);
              const want = String(tgt.requiredCase.closeDate);
              const dir = tgt.requiredCase.direction ? String(tgt.requiredCase.direction) : null;
              const hit = r.events.find((e: any) =>
                Math.abs(e.level - lvl) < tol && (e.eventAt ?? "").slice(0, 10) === want &&
                (dir === null || e.direction === dir)) ?? null;
              return hit
                ? { preserved: true, kind: hit.kind, significance: hit.significance,
                    barsSinceConfirmation: hit.barsSinceConfirmation }
                : { preserved: false, kind: null, significance: null, barsSinceConfirmation: null };
            })() : null,
          };
        });

        // The factual layer must not move when only event eligibility changes.
        const ledgerSig = (st: any) => st.swingLevelBreaks
          .map((x: any) => `${x.index}_${x.level}_${x.direction}`).join("|");
        const ledgerStable = runs.every(r => ledgerSig(r.st) === ledgerSig(base.st));

        out.push({
          symbol: sym, bars: series.length,
          latestConfirmedTotal: evs(lc).length,
          ledgerEntries: base.st.swingLevelBreaks.length,
          ledgerIdenticalAcrossCaps: ledgerStable,
          ineligibleLedgerEntries: Object.fromEntries(runs.map(r =>
            [r.name, r.st.swingLevelBreaks.filter((x: any) => !x.structureEventEligible).length])),
          policies,
        });
      }
      return respond({
        note: "READ-ONLY. No cutoff chosen. Age is eventBar - swingConfirmationBar. " +
              "Exceeding a cap does not delete, break, or unrecord a level — it only " +
              "removes event eligibility; the level stays in swingLevelBreaks, stays " +
              "sweepable, and is still carried as alsoBrokenLevels. " +
              "ledgerIdenticalAcrossCaps must be true for every symbol.",
        out,
      });
    }

    // ── ezzy_selector ────────────────────────────────────────────────────
    // SELECTOR RESEARCH ONLY. Read-only. Does not touch production trading
    // logic, does not replace detectOrderBlocks, and does not promote the
    // canonical structure engine — it only READS it, the same way the shadow
    // diff does.
    //
    // Hierarchy under test, in order:
    //
    //   1. start from a CANONICAL structure break
    //   2. identify the impulse that caused it
    //   3. walk back for the LAST QUALIFYING candle before that impulse
    //   4. reject candles that merely sit inside consolidation
    //   5. record liquidity-taking features WITHOUT gating on them
    //   6. apply the frozen proximal-half-of-wick-range geometry
    //
    // STEP 4 IS THE LOAD-BEARING ONE. "Last opposite-coloured candle before the
    // move" on its own selects a consolidation candle whenever the move starts
    // out of a range, which is most of the time. A candidate must therefore
    // clear at least one structural qualification:
    //
    //   turn         it makes a new past-10 extreme on its own side. Measured
    //                5/5 on the known TURN blocks against a 23% base rate, and
    //                0/2 on the CONTINUATION ones.
    //   continuation it is the last candle of a counter-trend run that the
    //                impulse then resumes through.
    //
    // A candle that is neither is interior consolidation and is recorded as a
    // competitor with rejected=true rather than silently skipped. Every
    // candidate examined is reported, so the rule can be judged on what it
    // passed over as much as on what it chose.
    //
    // Liquidity features are RECORDED, NOT GATED. 0 of 7 known blocks satisfy
    // sweptAndClosedBack, so hard-gating on a sweep would reject the reference
    // set outright.
    if (action === "ezzy_selector") {
      const targets = Array.isArray(body?.targets) ? body.targets : [];
      const BACK = Number(body?.maxLookback ?? 12);   // bars to walk back from the impulse origin
      const out: any[] = [];

      for (const tgt of targets) {
        const sym = String(tgt.symbol);
        const tf = String(tgt.interval ?? "1d");
        // Fetch depth is a parameter so historical targets are reachable. The
        // DEFAULT IS UNCHANGED at 800, so every earlier run reproduces exactly.
        // outputsize passes straight through to the provider with no internal
        // cap, so 2600 daily bars reaches 2019-08 on a 7-day crypto series.
        const barsBack = Number(tgt.limit ?? body?.limit ?? 800);
        const res = await fetchCandlesWithFallback({ symbol: sym, interval: tf, limit: barsBack, skipBroker: true });
        const isFx = (SPECS as any)[sym]?.type === "forex";
        const series = dropFxClosedBars(res.candles ?? [], isFx);
        if (series.length < 60) { out.push({ symbol: sym, error: `only ${series.length} bars` }); continue; }

        const canon = analyzeMarketStructureCanonical(series, {
          policy: "latest_unbroken_structural", maxEventAgeBars: 50,
        });
        const r = (x: number | null, d = 2) =>
          x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;
        const atrAt = (i: number) => {
          const sl = series.slice(Math.max(0, i - 14), i);
          return sl.length ? sl.reduce((a: number, c: Candle) => a + (c.high - c.low), 0) / sl.length : 0;
        };

        const selections: any[] = [];
        const events = [...canon.bos, ...canon.choch].sort((a: any, b: any) => a.index - b.index);

        for (const ev of events) {
          const bearish = ev.type === "bearish";
          const j = ev.index;
          const swingIdx = (ev as any).swingIndex ?? Math.max(0, j - 10);

          // ── 2. the impulse responsible for the break ──────────────────
          // The move that drove price through the level: from the extreme it
          // started at, to the breaking bar. For a bearish break that origin is
          // the highest high between the broken swing and the break.
          let originIdx = swingIdx;
          for (let k = swingIdx; k <= j; k++) {
            if (!series[k]) continue;
            if (bearish ? series[k].high >= series[originIdx].high
                        : series[k].low <= series[originIdx].low) originIdx = k;
          }
          const atr = atrAt(originIdx) || 1;
          const impulseAtr = bearish
            ? (series[originIdx].high - series[j].low) / atr
            : (series[j].high - series[originIdx].low) / atr;

          // ── 3+4. walk back for the last QUALIFYING candle ─────────────
          // The order block is the opposite colour to the impulse: an UP candle
          // before a down move (supply), a DOWN candle before an up move.
          const wantUp = bearish;
          const side = bearish ? "supply" : "demand";
          const cands: any[] = [];
          let chosen: any = null;

          for (let i = originIdx; i >= Math.max(1, originIdx - BACK); i--) {
            const c = series[i];
            if (!c) continue;
            if ((c.close >= c.open) !== wantUp) continue;      // wrong colour

            const a = atrAt(i) || 1;
            const range = c.high - c.low;
            const ext = (k: number) => wantUp ? series[k].high : series[k].low;
            const better = (x: number, y: number) => wantUp ? x > y : x < y;
            const mine = ext(i);

            // turn qualification — strictly past-only, no lookahead
            let past10: number | null = null;
            for (let k = Math.max(0, i - 10); k <= i - 1; k++) {
              const e = ext(k);
              if (past10 === null || better(e, past10)) past10 = e;
            }
            const newPast10Extreme = past10 !== null && better(mine, past10);

            // continuation qualification — last candle of its own colour run
            let runStart = i;
            while (runStart - 1 >= 0 &&
                   ((series[runStart - 1].close >= series[runStart - 1].open) === wantUp)) runStart--;
            const nxt = series[i + 1];
            const isLastOfRun = nxt ? ((nxt.close >= nxt.open) !== wantUp) : false;
            const runLen = i - runStart + 1;

            // ── 4. consolidation rejection ─────────────────────────────
            // Neither shape = interior consolidation candle. Recorded, not
            // silently dropped, so the rule is judged on its near-misses too.
            const qualifies = newPast10Extreme || isLastOfRun;
            const qualification = newPast10Extreme
              ? (isLastOfRun ? "turn+lastOfRun" : "turn(newPast10Extreme)")
              : (isLastOfRun ? "lastOfPullbackRun" : null);

            // ── 5. liquidity features: RECORDED, NOT GATED ─────────────
            const priorExt = (() => {
              let v: number | null = null;
              for (let k = Math.max(0, i - 10); k <= i - 1; k++) {
                const e = ext(k);
                if (v === null || better(e, v)) v = e;
              }
              return v;
            })();
            const tookPrior = priorExt !== null && better(mine, priorExt);
            const closedBack = tookPrior && (wantUp ? c.close < priorExt! : c.close > priorExt!);
            const bodyHi = Math.max(c.open, c.close), bodyLo = Math.min(c.open, c.close);
            const liqWick = wantUp ? (c.high - bodyHi) : (bodyLo - c.low);
            // Equal highs/lows within 0.1 ATR in the prior 10 bars — resting liquidity.
            let equalCount = 0;
            for (let k = Math.max(0, i - 10); k <= i - 1; k++) {
              if (Math.abs(ext(k) - mine) < a * 0.1) equalCount++;
            }

            // ── 6. FROZEN GEOMETRY — proximal half of the full wick range ──
            //   supply  proximal = LOW   distal = midpoint   extent = HIGH
            //   demand  proximal = HIGH  distal = midpoint   extent = LOW
            // Derived from hand-drawn boxes and validated on 7 boxes / 3 pairs
            // / 2 brokers. Not to be modified here.
            const proximal = side === "supply" ? c.low : c.high;
            const extent = side === "supply" ? c.high : c.low;
            const distal = (c.high + c.low) / 2;

            const entry = {
              date: c.datetime.slice(0, 10), datetime: c.datetime, index: i,
              side, barsBeforeImpulseOrigin: originIdx - i,
              o: c.open, h: c.high, l: c.low, c: c.close,
              rangeAtr: r(range / a), bodyAtr: r(Math.abs(c.close - c.open) / a),
              bodyRangeRatio: range > 0 ? r(Math.abs(c.close - c.open) / range) : null,
              qualifies, qualification,
              rejectedAsConsolidation: !qualifies,
              newPast10Extreme, isLastOfRun, runLength: runLen,
              liquidity: {
                tookPriorExtreme: tookPrior,
                sweptAndClosedBack: closedBack,
                liquidityWickRatio: range > 0 ? r(liqWick / range) : null,
                equalLevelsPrior10: equalCount,
                amountBeyondPriorExtremeAtr: priorExt !== null
                  ? r(Math.max(0, wantUp ? (mine - priorExt) / a : (priorExt - mine) / a)) : null,
              },
              box: { proximal: r(proximal, 5), distal: r(distal, 5), extent: r(extent, 5) },
              selected: false,
            };
            cands.push(entry);
            if (qualifies && !chosen) { chosen = entry; entry.selected = true; }
          }

          // ── SECOND SEARCH WINDOW — CONTINUATION ONLY ────────────────
          // The first run scored 5/7. Both misses were CONTINUATION blocks and
          // both were NEVER EXAMINED, not rejected:
          //
          //   AUD/USD 03-19 supply  break 03-24  impulse origin 03-18
          //   AUD/USD 04-03 demand  break 04-07  impulse origin 04-02
          //
          // Each sits exactly ONE BAR AFTER the impulse origin. The origin is
          // the price extreme, and the walk above runs backward FROM it, so no
          // lookback length could ever reach them. That matches the 02-vs-03
          // April forensic: 02 April made the deeper low and was rejected;
          // 03 April was the candle actually drawn. The extreme is not the
          // block — for a continuation the block is the last pullback candle
          // on the way back INTO the move.
          //
          // So: a second window over (origin, break), exclusive both ends,
          // traversed BACKWARD from the break toward the origin.
          //
          // Only the CONTINUATION qualification is honoured here. The turn test
          // is deliberately not applied in this window, so the TURN rule and its
          // 5/7 hits are byte-for-byte unchanged — the two windows are reported
          // separately rather than merged, because choosing a precedence
          // between them is a decision the data has not yet earned.
          //
          // isLastOfRun is NOT tightened here. It is known to be broad — it
          // produced a wrong 03-17 pick on the 03-24 break — but tightening it
          // before the right candles are reachable would be tuning against
          // candidates the search cannot yet see.
          const contCands: any[] = [];
          let contChosen: any = null;
          for (let i = j - 1; i > originIdx; i--) {
            const c = series[i];
            if (!c) continue;
            if ((c.close >= c.open) !== wantUp) continue;      // wrong colour
            const a = atrAt(i) || 1;
            const range = c.high - c.low;
            const ext = (k: number) => wantUp ? series[k].high : series[k].low;
            const better = (x: number, y: number) => wantUp ? x > y : x < y;
            const mine = ext(i);

            let runStart = i;
            while (runStart - 1 >= 0 &&
                   ((series[runStart - 1].close >= series[runStart - 1].open) === wantUp)) runStart--;
            const nxt = series[i + 1];
            const isLastOfRun = nxt ? ((nxt.close >= nxt.open) !== wantUp) : false;

            // Recorded for information only — NOT used to qualify in this window.
            let past10: number | null = null;
            for (let k = Math.max(0, i - 10); k <= i - 1; k++) {
              const e = ext(k);
              if (past10 === null || better(e, past10)) past10 = e;
            }
            const newPast10Extreme = past10 !== null && better(mine, past10);

            const qualifies = isLastOfRun;
            const bodyHi = Math.max(c.open, c.close), bodyLo = Math.min(c.open, c.close);
            const liqWick = wantUp ? (c.high - bodyHi) : (bodyLo - c.low);
            const tookPrior = past10 !== null && better(mine, past10);
            const proximal = side === "supply" ? c.low : c.high;
            const extent = side === "supply" ? c.high : c.low;

            const entry = {
              date: c.datetime.slice(0, 10), datetime: c.datetime, index: i,
              side, window: "continuation",
              barsAfterImpulseOrigin: i - originIdx, barsBeforeBreak: j - i,
              o: c.open, h: c.high, l: c.low, c: c.close,
              rangeAtr: r(range / a), bodyAtr: r(Math.abs(c.close - c.open) / a),
              bodyRangeRatio: range > 0 ? r(Math.abs(c.close - c.open) / range) : null,
              qualifies, qualification: qualifies ? "lastOfPullbackRun" : null,
              rejectedAsConsolidation: !qualifies,
              isLastOfRun, runLength: i - runStart + 1,
              newPast10ExtremeInfoOnly: newPast10Extreme,
              liquidity: {
                tookPriorExtreme: tookPrior,
                liquidityWickRatio: range > 0 ? r(liqWick / range) : null,
              },
              box: { proximal: r(proximal, 5), distal: r((c.high + c.low) / 2, 5), extent: r(extent, 5) },
              selected: false,
            };
            contCands.push(entry);
            if (qualifies && !contChosen) { contChosen = entry; entry.selected = true; }
          }

          selections.push({
            continuationWindow: {
              range: originIdx + 1 <= j - 1
                ? `${series[originIdx + 1]?.datetime?.slice(0, 10)} .. ${series[j - 1]?.datetime?.slice(0, 10)}`
                : "empty",
              candidatesExamined: contCands.length,
              selected: contChosen
                ? { date: contChosen.date, index: contChosen.index,
                    qualification: contChosen.qualification, box: contChosen.box }
                : null,
              candidates: contCands,
            },
            break: {
              index: j, datetime: ev.datetime, type: ev.type,
              level: ev.level, significance: ev.significance,
              swingIndex: (ev as any).swingIndex ?? null,
              swingDatetime: series[(ev as any).swingIndex]?.datetime ?? null,
            },
            impulse: {
              originIndex: originIdx, originDatetime: series[originIdx]?.datetime ?? null,
              barsToBreak: j - originIdx, impulseAtr: r(impulseAtr),
            },
            side,
            selectedCandle: chosen
              ? { date: chosen.date, index: chosen.index, qualification: chosen.qualification, box: chosen.box }
              : null,
            selectedNone: !chosen,
            candidatesExamined: cands.length,
            candidates: cands,
          });
        }

        // ── 7/8. score against the known EZZY boxes ────────────────────
        const known = (tgt.knownBoxes ?? []) as Array<{ date: string; side: string }>;
        const picked = new Set(selections.filter(s => s.selectedCandle)
          .map(s => `${s.side}|${s.selectedCandle.date}`));
        const pickedCont = new Set(selections
          .filter(s => s.continuationWindow?.selected)
          .map(s => `${s.side}|${s.continuationWindow.selected.date}`));
        const scored = known.map(k => {
          const key = `${k.side}|${k.date}`;
          const hitTurn = picked.has(key);
          const hitCont = pickedCont.has(key);
          const hit = hitTurn || hitCont;
          // Where the rule went instead, and whether the known candle was even
          // examined — "never reached" and "examined then rejected" are very
          // different failures.
          const sameSide = selections.filter(s => s.side === k.side);
          const examined = sameSide.flatMap(s => s.candidates)
            .filter((c: any) => c.date === k.date);
          const examinedCont = sameSide
            .flatMap(s => s.continuationWindow?.candidates ?? [])
            .filter((c: any) => c.date === k.date);
          const nearest = sameSide.filter(s => s.selectedCandle)
            .map(s => ({ date: s.selectedCandle.date, breakAt: s.break.datetime,
                         deltaDays: Math.round((Date.parse(s.selectedCandle.date) - Date.parse(k.date)) / 86400000) }))
            .sort((a, b) => Math.abs(a.deltaDays) - Math.abs(b.deltaDays))[0] ?? null;
          return {
            knownBox: k, hit, hitTurn, hitCont,
            knownCandleExamined: examined.length > 0 || examinedCont.length > 0,
            examinedInTurnWindow: examined.length > 0,
            examinedInContinuationWindow: examinedCont.length > 0,
            continuationVerdict: examinedCont.length
              ? examinedCont.map((e: any) => ({
                  qualifies: e.qualifies, qualification: e.qualification,
                  isLastOfRun: e.isLastOfRun, selected: e.selected,
                  barsAfterImpulseOrigin: e.barsAfterImpulseOrigin,
                  barsBeforeBreak: e.barsBeforeBreak,
                }))
              : null,
            knownCandleVerdict: examined.length
              ? examined.map((e: any) => ({
                  qualifies: e.qualifies, qualification: e.qualification,
                  rejectedAsConsolidation: e.rejectedAsConsolidation,
                  newPast10Extreme: e.newPast10Extreme, isLastOfRun: e.isLastOfRun,
                  selected: e.selected,
                }))
              : null,
            nearestSelection: nearest,
          };
        });

        // ── BODY-QUALITY SWEEP (read-only, additive) ──────────────────
        // Re-filters the ALREADY-COMPUTED continuation candidates at a range of
        // bodyRangeRatio minimums. It does not re-walk, does not touch the TURN
        // window, does not alter the search range, and does not change what
        // continuationWindow.selected reports — that remains the threshold-0
        // result. Nothing here chooses or promotes a threshold.
        //
        // WHY. The 03-24 break selects 2026-03-23, an up candle with
        // bodyRangeRatio 0.02 — essentially all wick — purely because the
        // backward-from-break walk takes the first qualifying candidate and
        // 03-23 is nearer the break than the known box at 03-19 (ratio 0.44).
        // Both qualify on isLastOfRun, so proximity alone decided it.
        //
        // Precedence is UNCHANGED at every threshold: still backward from the
        // break, still the first surviving isLastOfRun candidate. The only
        // variable is which candidates survive.
        const THRESHOLDS = [0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40];
        const knownKeys = new Set(known.map(k => `${k.side}|${k.date}`));
        const bodyThresholdSweep = THRESHOLDS.map(th => {
          const sel: Array<{ side: string; date: string; ratio: number | null }> = [];
          const perBreak: Record<string, string | null> = {};
          for (const s2 of selections) {
            const cands = s2.continuationWindow?.candidates ?? [];
            // candidates are already ordered backward from the break, so the
            // first survivor is the same precedence rule as before
            const first = cands.find((c: any) =>
              c.qualifies && (c.bodyRangeRatio ?? 0) >= th);
            perBreak[`${s2.break.datetime.slice(0, 10)}|${s2.side}`] = first ? first.date : null;
            if (first) sel.push({ side: s2.side, date: first.date, ratio: first.bodyRangeRatio });
          }
          const selKeys = new Set(sel.map(x => `${x.side}|${x.date}`));
          const contOnly = [...selKeys].filter(k2 => !picked.has(k2));
          return {
            threshold: th,
            continuationSelections: sel.length,
            distinctContinuationDates: selKeys.size,
            continuationOnlyDates: contOnly.length,
            knownBoxes: known.map(k => {
              const key = `${k.side}|${k.date}`;
              return {
                date: k.date, side: k.side,
                hitTurn: picked.has(key),
                hitCont: selKeys.has(key),
                hit: picked.has(key) || selKeys.has(key),
              };
            }),
            totalKnownHits: known.filter(k =>
              picked.has(`${k.side}|${k.date}`) || selKeys.has(`${k.side}|${k.date}`)).length,
            // The two breaks under investigation, named explicitly.
            selectedFor_0324: perBreak["2026-03-24|supply"] ?? null,
            selectedFor_0407: perBreak["2026-04-07|demand"] ?? null,
          };
        });

        // Which known candles the body floor would eliminate, and at what
        // point. "Rejected SOLELY by body" means it qualified on isLastOfRun
        // and was only removed because its ratio fell under the threshold.
        const knownBodyProfile = known.map(k => {
          const inCont = selections.flatMap(s2 => s2.continuationWindow?.candidates ?? [])
            .filter((c: any) => c.date === k.date && c.side === k.side);
          const inTurn = selections.flatMap(s2 => s2.candidates ?? [])
            .filter((c: any) => c.date === k.date && c.side === k.side);
          const any = inCont[0] ?? inTurn[0] ?? null;
          const ratio = any ? any.bodyRangeRatio : null;
          const qualifiesOnRun = inCont.some((c: any) => c.qualifies);
          return {
            date: k.date, side: k.side,
            bodyRangeRatio: ratio,
            presentInContinuationWindow: inCont.length > 0,
            presentInTurnWindow: inTurn.length > 0,
            qualifiesOnIsLastOfRun: qualifiesOnRun,
            // Lowest swept threshold that would exclude it, if any.
            excludedAtThreshold: ratio == null
              ? null
              : (THRESHOLDS.find(t => ratio < t) ?? null),
            rejectedSolelyByBody: ratio != null && qualifiesOnRun &&
              (THRESHOLDS.find(t => ratio < t) ?? null) !== null,
          };
        });

        // ── HOLDOUT REPORT at a FROZEN continuation body threshold ────
        // Reporting only. It reads the candidates the selector already
        // produced and re-resolves which one would win at a fixed threshold.
        // The selector's own behaviour, the windows, the qualifications, the
        // geometry and the TURN path are all untouched, and
        // continuationWindow.selected still reports the threshold-0 result.
        const bodyMin = Number(body?.continuationBodyMin ?? 0);
        const holdout = known.map(k => {
          const key = `${k.side}|${k.date}`;
          // Breaks whose windows contain the known candle at all.
          const relevant = selections.filter(s2 => s2.side === k.side && (
            (s2.candidates ?? []).some((c: any) => c.date === k.date) ||
            (s2.continuationWindow?.candidates ?? []).some((c: any) => c.date === k.date)));

          const turnHit = selections.some(s2 =>
            s2.side === k.side && s2.selectedCandle?.date === k.date);
          // Continuation winner at the frozen threshold, same backward-from-break
          // precedence, only survivors considered.
          const contWinnerFor = (s2: any) => (s2.continuationWindow?.candidates ?? [])
            .find((c: any) => c.qualifies && (c.bodyRangeRatio ?? 0) >= bodyMin) ?? null;
          const contHit = selections.some(s2 =>
            s2.side === k.side && contWinnerFor(s2)?.date === k.date);

          const inCont = relevant.flatMap(s2 =>
            (s2.continuationWindow?.candidates ?? []).filter((c: any) => c.date === k.date));
          const inTurn = relevant.flatMap(s2 =>
            (s2.candidates ?? []).filter((c: any) => c.date === k.date));
          const self = inCont[0] ?? inTurn[0] ?? null;

          // The break this candle belongs to: prefer one where it actually won,
          // else the nearest relevant break.
          const owning = relevant.find(s2 =>
            s2.selectedCandle?.date === k.date || contWinnerFor(s2)?.date === k.date)
            ?? relevant[0] ?? null;
          const winner = owning
            ? (owning.selectedCandle?.date === k.date
                ? owning.selectedCandle
                : (contWinnerFor(owning) ?? owning.selectedCandle ?? null))
            : null;

          // Three distinct failure modes, never collapsed into one "miss".
          let missReason: string | null = null;
          if (!(turnHit || contHit)) {
            if (!self) missReason = "never_examined";
            else if (!self.qualifies) missReason = "rejected_by_qualification";
            else if ((self.bodyRangeRatio ?? 0) < bodyMin) missReason = "rejected_by_body_threshold";
            else missReason = "qualified_but_outranked";
          }

          return {
            date: k.date, side: k.side,
            hit: turnHit || contHit, hitTurn: turnHit, hitCont: contHit,
            knownCandleExamined: !!self,
            examinedInTurnWindow: inTurn.length > 0,
            examinedInContinuationWindow: inCont.length > 0,
            bodyRangeRatio: self ? self.bodyRangeRatio : null,
            qualification: self ? self.qualification : null,
            qualifiesOnRun: self ? !!self.qualifies : null,
            breakDate: owning ? owning.break.datetime.slice(0, 10) : null,
            breakType: owning ? owning.break.type : null,
            impulseOriginDate: owning ? (owning.impulse.originDatetime ?? "").slice(0, 10) : null,
            selectedCandleAtThreshold: winner ? winner.date : null,
            selectedQualification: winner ? (winner.qualification ?? null) : null,
            // Geometry the frozen rule predicts for the KNOWN candle itself,
            // reported whether or not the selector chose it.
            predictedBox: self ? self.box : null,
            selectedBox: winner ? (winner.box ?? null) : null,
            missReason,
            relevantBreaks: relevant.length,
          };
        });

        out.push({
          symbol: sym, interval: tf, bars: series.length,
          canonicalEvents: events.length,
          continuationBodyMinUsed: Number(body?.continuationBodyMin ?? 0),
          barsRequested: Number(tgt.limit ?? body?.limit ?? 800),
          firstBar: series[0]?.datetime ?? null,
          lastBar: series[series.length - 1]?.datetime ?? null,
          holdout,
          bodyThresholdSweep,
          knownBodyProfile,
          selectionsMade: selections.filter(s => s.selectedCandle).length,
          selectionsEmpty: selections.filter(s => s.selectedNone).length,
          continuationSelectionsMade: selections.filter(s => s.continuationWindow?.selected).length,
          // Distinct dates the continuation window adds that the turn window
          // never picked — the false-positive surface of the new window.
          continuationOnlyDates: [...new Set(selections
            .filter(s => s.continuationWindow?.selected)
            .map(s => `${s.side}|${s.continuationWindow.selected.date}`)
            .filter(d2 => !picked.has(d2)))].sort(),
          knownBoxScore: scored,
          selections: selections.slice(-Number(body?.maxSelections ?? 30)),
        });
      }
      return respond({
        note: "SELECTOR RESEARCH ONLY. Read-only. Production trading logic, the " +
              "live OB detector and structure authority are all untouched; the " +
              "canonical engine is read, not promoted. Liquidity features are " +
              "recorded and NOT gated — 0/7 known boxes satisfy sweptAndClosedBack. " +
              "Geometry is the frozen proximal-half-of-wick-range rule.",
        out,
      });
    }

    // ── ezzy_candidate_causal_audit ──────────────────────────────────────
    // DESCRIPTIVE ONLY. Starts from each KNOWN Ezzy candle and looks forward.
    // It selects nothing, ranks nothing, chooses no threshold, and changes no
    // production behaviour. The selector, TURN rule, continuation rule, body
    // threshold, canonical structure and geometry are all untouched — this
    // reads them.
    //
    // WHY START FROM THE CANDLE. Every previous diagnostic started from a
    // canonical break and searched backward, so it could only ever describe
    // candles its own search happened to reach. The BTC holdout scored 0/3 for
    // three DIFFERENT reasons — rejected_by_qualification, never_examined and
    // qualified_but_outranked — which means the search itself is part of what
    // is under suspicion. Inverting the direction removes the search from the
    // measurement: whatever these candles have in common must be visible from
    // the candle forward, without any rule deciding which candle to look at.
    //
    // The BTC holdout result stands at 0/3 and is not relabelled by anything
    // here.
    if (action === "ezzy_candidate_causal_audit") {
      const targets = Array.isArray(body?.targets) ? body.targets : [];
      const HORIZON = Number(body?.horizon ?? 40);
      const out: any[] = [];

      for (const tgt of targets) {
        const sym = String(tgt.symbol);
        const tf = String(tgt.interval ?? "1d");
        const barsBack = Number(tgt.limit ?? body?.limit ?? 800);
        const res = await fetchCandlesWithFallback({ symbol: sym, interval: tf, limit: barsBack, skipBroker: true });
        const isFx = (SPECS as any)[sym]?.type === "forex";
        const series = dropFxClosedBars(res.candles ?? [], isFx);
        if (series.length < 60) { out.push({ symbol: sym, error: `only ${series.length} bars` }); continue; }

        const canon = analyzeMarketStructureCanonical(series, {
          policy: "latest_unbroken_structural", maxEventAgeBars: 50,
        });
        const evs = [...canon.bos.map((b: any) => ({ ...b, kind: "BOS" })),
                     ...canon.choch.map((c: any) => ({ ...c, kind: "CHoCH" }))]
                     .sort((a, b) => a.index - b.index);
        const r = (x: number | null, d = 2) =>
          x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;
        const atrAt = (i: number) => {
          const sl = series.slice(Math.max(0, i - 14), i);
          return sl.length ? sl.reduce((a: number, c: Candle) => a + (c.high - c.low), 0) / sl.length : 0;
        };
        const idxOf = (date: string) => series.findIndex(c => c.datetime.slice(0, 10) === date);

        const rows = (tgt.knownBoxes ?? []).map((k: any) => {
          const i = idxOf(String(k.date));
          if (i < 0) return { date: k.date, side: k.side, error: "candle not in series" };
          const c = series[i];
          const demand = k.side === "demand";
          const favUp = demand;                       // demand precedes an up move
          const a = atrAt(i) || 1;
          const range = c.high - c.low;
          const bodyHi = Math.max(c.open, c.close), bodyLo = Math.min(c.open, c.close);

          // Frozen geometry, read-only.
          const proximal = demand ? c.high : c.low;
          const extent = demand ? c.low : c.high;
          const distal = (c.high + c.low) / 2;
          const boxLo = Math.min(proximal, extent), boxHi = Math.max(proximal, extent);

          // ── first directional expansion ────────────────────────────────
          // The first maximal run of consecutive favourable-direction candles
          // after this one. Structural, so no threshold is being chosen.
          let expStart = -1, expEnd = -1;
          for (let j = i + 1; j < Math.min(series.length, i + 1 + HORIZON); j++) {
            const up = series[j].close >= series[j].open;
            if (up === favUp) { if (expStart < 0) expStart = j; expEnd = j; }
            else if (expStart >= 0) break;
          }
          let expDispAtr: number | null = null;
          if (expStart >= 0) {
            let ext = favUp ? -Infinity : Infinity;
            for (let j = expStart; j <= expEnd; j++) {
              const v = favUp ? series[j].high : series[j].low;
              if (favUp ? v > ext : v < ext) ext = v;
            }
            expDispAtr = r(Math.abs(ext - proximal) / a);
          }

          // ── canonical swing levels first closed through after the candle ─
          const ledgerAfter = (canon.swingLevelBreaks as any[])
            .filter(x => x.index > i && x.index <= i + HORIZON)
            .map(x => ({
              date: String(x.datetime).slice(0, 10), barsAfter: x.index - i,
              direction: x.direction, level: x.level, significance: x.significance,
              swingDate: String(x.swingTime ?? "").slice(0, 10),
            }));

          const after = evs.filter(e => e.index > i && e.index <= i + HORIZON);
          const pick = (f: (e: any) => boolean) => {
            const e = after.find(f);
            return e ? {
              date: String(e.datetime).slice(0, 10), barsAfter: e.index - i,
              type: e.type, kind: e.kind, level: e.level, significance: e.significance,
            } : null;
          };
          const firstInternal = pick(e => e.significance === "internal");
          const firstExternal = pick(e => e.significance === "external");
          const firstBOS = pick(e => e.kind === "BOS");
          const firstCHoCH = pick(e => e.kind === "CHoCH");

          // ── revisit and invalidation ───────────────────────────────────
          // revisit     = any later bar trades back INTO the box
          // invalidated = a close beyond extent (the frozen lifecycle rule)
          let revisitIdx = -1, invalIdx = -1;
          for (let j = i + 1; j < Math.min(series.length, i + 1 + HORIZON); j++) {
            const b = series[j];
            if (revisitIdx < 0 && b.low <= boxHi && b.high >= boxLo) revisitIdx = j;
            if (invalIdx < 0 && (demand ? b.close < extent : b.close > extent)) invalIdx = j;
          }
          // MFE up to whichever of revisit/invalidation comes first.
          const stopAt = Math.min(
            revisitIdx < 0 ? Infinity : revisitIdx,
            invalIdx < 0 ? Infinity : invalIdx,
            i + HORIZON,
          );
          let mfe = 0;
          for (let j = i + 1; j <= Math.min(series.length - 1, stopAt); j++) {
            const v = favUp ? series[j].high : series[j].low;
            const d2 = favUp ? v - proximal : proximal - v;
            if (d2 > mfe) mfe = d2;
          }
          const revisitedBefore = (e: any) =>
            e == null ? null : (revisitIdx >= 0 && revisitIdx < i + e.barsAfter);

          // ── candle-local features, recomputed here ─────────────────────
          const ext = (j: number) => favUp ? series[j].low : series[j].high;   // the box's own side
          const better = (x: number, y: number) => favUp ? x < y : x > y;      // deeper low / higher high
          let past10: number | null = null;
          for (let j2 = Math.max(0, i - 10); j2 <= i - 1; j2++) {
            const e = ext(j2);
            if (past10 === null || better(e, past10)) past10 = e;
          }
          const mine = ext(i);
          const newPast10Extreme = past10 !== null && better(mine, past10);
          const wantUp = !demand;                        // supply candles are up candles
          let runStart = i;
          while (runStart - 1 >= 0 &&
                 ((series[runStart - 1].close >= series[runStart - 1].open) === wantUp)) runStart--;
          const nxt = series[i + 1];
          const isLastOfRun = nxt ? ((nxt.close >= nxt.open) !== wantUp) : false;
          const liqWick = wantUp ? (c.high - bodyHi) : (bodyLo - c.low);
          let equalPrior10 = 0;
          for (let j2 = Math.max(0, i - 10); j2 <= i - 1; j2++) {
            if (Math.abs(ext(j2) - mine) < a * 0.1) equalPrior10++;
          }
          const tookPrior = past10 !== null && better(mine, past10);
          const closedBack = tookPrior && (demand ? c.close > past10! : c.close < past10!);

          return {
            date: k.date, side: k.side, index: i,
            candle: {
              o: c.open, h: c.high, l: c.low, c: c.close,
              colour: c.close >= c.open ? "up" : "down",
              rangeAtr: r(range / a), bodyAtr: r(Math.abs(c.close - c.open) / a),
              bodyRangeRatio: range > 0 ? r(Math.abs(c.close - c.open) / range) : null,
              atr: r(a, 5),
            },
            box: { proximal: r(proximal, 5), distal: r(distal, 5), extent: r(extent, 5) },
            firstExpansion: expStart < 0 ? null : {
              startDate: series[expStart].datetime.slice(0, 10),
              endDate: series[expEnd].datetime.slice(0, 10),
              barsAfterCandle: expStart - i, lengthBars: expEnd - expStart + 1,
              displacementAtr: expDispAtr,
            },
            canonicalLevelsClosedThroughAfter: {
              count: ledgerAfter.length, entries: ledgerAfter.slice(0, 10),
            },
            firstInternalBreak: firstInternal,
            firstExternalBreak: firstExternal,
            firstBOS, firstCHoCH,
            excursion: {
              maxFavourableAtrBeforeRevisitOrInvalidation: r(mfe / a),
              revisitBarsAfter: revisitIdx < 0 ? null : revisitIdx - i,
              revisitDate: revisitIdx < 0 ? null : series[revisitIdx].datetime.slice(0, 10),
              invalidationBarsAfter: invalIdx < 0 ? null : invalIdx - i,
              invalidationDate: invalIdx < 0 ? null : series[invalIdx].datetime.slice(0, 10),
              whichCameFirst: revisitIdx < 0 && invalIdx < 0 ? "neither"
                : invalIdx < 0 ? "revisit"
                : revisitIdx < 0 ? "invalidation"
                : (revisitIdx <= invalIdx ? "revisit" : "invalidation"),
            },
            boxRevisitedBeforeBreak: {
              firstInternal: revisitedBefore(firstInternal),
              firstExternal: revisitedBefore(firstExternal),
              firstBOS: revisitedBefore(firstBOS),
              firstCHoCH: revisitedBefore(firstCHoCH),
            },
            candleContext: {
              newPast10Extreme, isLastOfRun, runLength: i - runStart + 1,
            },
            liquidity: {
              tookPriorExtreme: tookPrior, sweptAndClosedBack: closedBack,
              liquidityWickRatio: range > 0 ? r(liqWick / range) : null,
              equalLevelsPrior10: equalPrior10,
              amountBeyondPriorExtremeAtr: past10 !== null
                ? r(Math.max(0, Math.abs(mine - past10) / a)) : null,
            },
          };
        });

        out.push({
          symbol: sym, interval: tf, bars: series.length,
          firstBar: series[0]?.datetime ?? null, lastBar: series[series.length - 1]?.datetime ?? null,
          horizon: HORIZON, canonicalEvents: evs.length,
          knownCandles: rows,
        });
      }
      return respond({
        note: "DESCRIPTIVE ONLY. Starts from each KNOWN candle and looks forward. " +
              "Selects nothing, ranks nothing, chooses no threshold. The selector, " +
              "TURN rule, continuation rule, body threshold, canonical structure, " +
              "geometry and production are untouched. The BTC holdout stands at 0/3 " +
              "and is not relabelled by anything here.",
        out,
      });
    }

    // ── ezzy_phase_liquidity_audit ───────────────────────────────────────
    // DESCRIPTIVE ONLY. Tests the phase hypothesis taken from the videos:
    //
    //   contraction/range -> liquidity clearance -> special candle -> expansion
    //   -> later structure break
    //
    // Chooses nothing, ranks nothing, gates nothing, defines no IPO rule. The
    // selector, TURN rule, continuation rule, body threshold, canonical engine,
    // geometry and every production consumer are untouched. The BTC holdout
    // stands at 0/3 and is not relabelled.
    //
    // NON-CIRCULAR CLEARANCE. A contraction window's own high IS its maximum,
    // so asking "did price exceed the window high inside that window" is
    // vacuous. For each window size W:
    //
    //   priorRange  bars [i-2W, i-W-1]   the reference boundary
    //   contraction bars [i-W,   i-1]    reported in section 1
    //   clearance   bars [i-W,   i]      tested AGAINST priorRange
    //
    // so a grab is always measured against a level established before it. The
    // known candle is included in the clearance scan but is NOT required to be
    // the bar that performs it.
    //
    // ZONE LIFECYCLE USES THE PROXIMAL HALF ONLY:
    //   demand zone = [distal, proximal]   proximal = high, distal = midpoint
    //   supply zone = [proximal, distal]   proximal = low,  distal = midpoint
    // extent is the INVALIDATION level and is never a zone boundary. An earlier
    // audit measured revisit against proximal..extent, which is the whole
    // candle and reports a revisit almost immediately; that was wrong.
    if (action === "ezzy_phase_liquidity_audit") {
      const targets = Array.isArray(body?.targets) ? body.targets : [];
      const WINDOWS: number[] = Array.isArray(body?.windows) ? body.windows : [3, 5, 7, 10, 15];
      const HORIZON = Number(body?.horizon ?? 40);
      const out: any[] = [];

      for (const tgt of targets) {
        const sym = String(tgt.symbol);
        const tf = String(tgt.interval ?? "1d");
        const barsBack = Number(tgt.limit ?? body?.limit ?? 800);
        const res = await fetchCandlesWithFallback({ symbol: sym, interval: tf, limit: barsBack, skipBroker: true });
        const isFx = (SPECS as any)[sym]?.type === "forex";
        const series = dropFxClosedBars(res.candles ?? [], isFx);
        if (series.length < 80) { out.push({ symbol: sym, error: `only ${series.length} bars` }); continue; }

        const canon = analyzeMarketStructureCanonical(series, {
          policy: "latest_unbroken_structural", maxEventAgeBars: 50,
        });
        const evs = [...canon.bos.map((b: any) => ({ ...b, kind: "BOS" })),
                     ...canon.choch.map((c: any) => ({ ...c, kind: "CHoCH" }))]
                     .sort((a, b) => a.index - b.index);
        const r = (x: number | null, d = 2) =>
          x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;
        const atrAt = (i: number) => {
          const sl = series.slice(Math.max(0, i - 14), i);
          return sl.length ? sl.reduce((a: number, c: Candle) => a + (c.high - c.low), 0) / sl.length : 0;
        };
        const dstr = (i: number) => series[i]?.datetime?.slice(0, 10) ?? null;
        const hiLo = (a: number, b: number) => {
          let hi = -Infinity, lo = Infinity, hiI = a, loI = a;
          for (let j = Math.max(0, a); j <= Math.min(series.length - 1, b); j++) {
            if (series[j].high > hi) { hi = series[j].high; hiI = j; }
            if (series[j].low < lo) { lo = series[j].low; loI = j; }
          }
          return { hi, lo, hiI, loI };
        };

        const rows = (tgt.knownBoxes ?? []).map((k: any) => {
          const i = series.findIndex(c => c.datetime.slice(0, 10) === String(k.date));
          if (i < 0) return { date: k.date, side: k.side, error: "candle not in series" };
          const c = series[i];
          const demand = k.side === "demand";
          const favUp = demand;
          const a = atrAt(i) || 1;
          const rng = c.high - c.low;
          const bodyHi = Math.max(c.open, c.close), bodyLo = Math.min(c.open, c.close);

          // Frozen geometry. Zone is the PROXIMAL HALF; extent is invalidation only.
          const proximal = demand ? c.high : c.low;
          const extent = demand ? c.low : c.high;
          const distal = (c.high + c.low) / 2;
          const zoneLo = demand ? distal : proximal;
          const zoneHi = demand ? proximal : distal;

          // ── 1/2. contraction windows + non-circular clearance ─────────
          const windows = WINDOWS.map(W => {
            const cS = i - W, cE = i - 1;
            const pS = i - 2 * W, pE = i - W - 1;
            if (pS < 0) return { window: W, insufficientHistory: true };
            const con = hiLo(cS, cE), pri = hiLo(pS, pE);
            let overlaps = 0;
            for (let j = cS + 1; j <= cE; j++) {
              if (series[j].low <= series[j - 1].high && series[j].high >= series[j - 1].low) overlaps++;
            }
            // clearance of the PRIOR range, scanned over contraction + candle
            let aboveIdx = -1, belowIdx = -1, aboveClose = false, belowClose = false;
            for (let j = cS; j <= i; j++) {
              if (aboveIdx < 0 && series[j].high > pri.hi) { aboveIdx = j; aboveClose = series[j].close > pri.hi; }
              if (belowIdx < 0 && series[j].low < pri.lo) { belowIdx = j; belowClose = series[j].close < pri.lo; }
            }
            const firstSide = aboveIdx < 0 && belowIdx < 0 ? null
              : aboveIdx < 0 ? "low" : belowIdx < 0 ? "high"
              : (aboveIdx <= belowIdx ? "high" : "low");
            const lastGrabIdx = Math.max(aboveIdx, belowIdx);
            return {
              window: W,
              contraction: {
                from: dstr(cS), to: dstr(cE), high: r(con.hi, 5), low: r(con.lo, 5),
                rangeAtr: r((con.hi - con.lo) / a), highDate: dstr(con.hiI), lowDate: dstr(con.loI),
                adjacentOverlaps: overlaps, ofBars: W - 1,
              },
              priorRange: {
                from: dstr(pS), to: dstr(pE), high: r(pri.hi, 5), low: r(pri.lo, 5),
                rangeAtr: r((pri.hi - pri.lo) / a),
              },
              compressionRatio: (pri.hi - pri.lo) > 0 ? r((con.hi - con.lo) / (pri.hi - pri.lo)) : null,
              clearance: {
                tookAbovePriorHigh: aboveIdx >= 0, aboveDate: aboveIdx < 0 ? null : dstr(aboveIdx),
                aboveBarsBeforeCandle: aboveIdx < 0 ? null : i - aboveIdx,
                aboveWasCloseThrough: aboveIdx < 0 ? null : aboveClose,
                tookBelowPriorLow: belowIdx >= 0, belowDate: belowIdx < 0 ? null : dstr(belowIdx),
                belowBarsBeforeCandle: belowIdx < 0 ? null : i - belowIdx,
                belowWasCloseThrough: belowIdx < 0 ? null : belowClose,
                oneSideOnly: (aboveIdx >= 0) !== (belowIdx >= 0),
                bothSides: aboveIdx >= 0 && belowIdx >= 0,
                firstSideTaken: firstSide,
                lastGrabDate: lastGrabIdx < 0 ? null : dstr(lastGrabIdx),
                barsFromLastGrabToCandle: lastGrabIdx < 0 ? null : i - lastGrabIdx,
                candleIsTheGrab: lastGrabIdx === i,
              },
              candleInsidePriorRange: c.high <= pri.hi && c.low >= pri.lo,
              candleOutsidePriorRange: c.high > pri.hi || c.low < pri.lo,
            };
          });

          // ── 5. forward expansion, structural (no ATR threshold) ───────
          let expStart = -1, expEnd = -1;
          for (let j = i + 1; j < Math.min(series.length, i + 1 + HORIZON); j++) {
            const up = series[j].close >= series[j].open;
            if (up === favUp) { if (expStart < 0) expStart = j; expEnd = j; }
            else if (expStart >= 0) break;
          }
          let expDisp: number | null = null;
          if (expStart >= 0) {
            let e = favUp ? -Infinity : Infinity;
            for (let j = expStart; j <= expEnd; j++) {
              const v = favUp ? series[j].high : series[j].low;
              if (favUp ? v > e : v < e) e = v;
            }
            expDisp = r(Math.abs(e - proximal) / a);
          }
          const mfeAt = (n: number) => {
            let m = -Infinity;
            for (let j = i + 1; j <= Math.min(series.length - 1, i + n); j++) {
              const v = favUp ? series[j].high : series[j].low;
              const dd = favUp ? v - proximal : proximal - v;
              if (dd > m) m = dd;
            }
            return Number.isFinite(m) ? r(m / a) : null;
          };

          // ── 3. known candle relative to the sequence ──────────────────
          const w10 = windows.find((x: any) => x.window === 10 && !x.insufficientHistory) as any;
          const lastGrabBars = w10?.clearance?.barsFromLastGrabToCandle ?? null;
          const grabIdx = lastGrabBars == null ? -1 : i - lastGrabBars;
          const wantUp = !demand;      // supply candles are up candles
          let firstOppAfterGrab = -1;
          if (grabIdx >= 0) {
            for (let j = grabIdx; j <= i + 5 && j < series.length; j++) {
              if ((series[j].close >= series[j].open) === wantUp) { firstOppAfterGrab = j; break; }
            }
          }
          let lastOppBeforeExp = -1;
          if (expStart > 0) {
            for (let j = expStart - 1; j >= Math.max(0, expStart - 10); j--) {
              if ((series[j].close >= series[j].open) === wantUp) { lastOppBeforeExp = j; break; }
            }
          }

          // ── 4. IPO evidence: the candle and +/-3 neighbours ───────────
          const neighbours: any[] = [];
          for (let j = Math.max(0, i - 3); j <= Math.min(series.length - 1, i + 3); j++) {
            const n = series[j], nr = n.high - n.low, na = atrAt(j) || 1;
            const nbHi = Math.max(n.open, n.close), nbLo = Math.min(n.open, n.close);
            neighbours.push({
              offset: j - i, date: dstr(j), colour: n.close >= n.open ? "up" : "down",
              o: n.open, h: n.high, l: n.low, c: n.close,
              rangeAtr: r(nr / na), bodyRangeRatio: nr > 0 ? r(Math.abs(n.close - n.open) / nr) : null,
              upperWickRatio: nr > 0 ? r((n.high - nbHi) / nr) : null,
              lowerWickRatio: nr > 0 ? r((nbLo - n.low) / nr) : null,
              insidePriorRange10: w10 ? (n.high <= (w10.priorRange.high ?? Infinity) && n.low >= (w10.priorRange.low ?? -Infinity)) : null,
              isLastGrabBar: grabIdx === j,
              barsFromLastGrab: grabIdx < 0 ? null : j - grabIdx,
              barsToExpansionStart: expStart < 0 ? null : expStart - j,
              isKnownEzzyCandle: j === i,
            });
          }

          // ── 6. DIRECTION-ALIGNED structure only ───────────────────────
          const wantDir = favUp ? "bullish" : "bearish";
          const aligned = evs.filter(e => e.index > i && e.index <= i + HORIZON && e.type === wantDir);
          const pick = (f: (e: any) => boolean) => {
            const e = aligned.find(f);
            return e ? { date: dstr(e.index), barsAfter: e.index - i, kind: e.kind,
                         level: e.level, significance: e.significance } : null;
          };
          const alignedLedger = (canon.swingLevelBreaks as any[])
            .filter(x => x.index > i && x.index <= i + HORIZON && x.direction === wantDir)
            .map(x => ({ date: String(x.datetime).slice(0, 10), barsAfter: x.index - i,
                         level: x.level, significance: x.significance }));

          // ── 7. zone lifecycle on the PROXIMAL HALF ────────────────────
          let zoneRevisit = -1, invalidation = -1;
          for (let j = i + 1; j < Math.min(series.length, i + 1 + HORIZON); j++) {
            const b = series[j];
            if (zoneRevisit < 0 && b.low <= zoneHi && b.high >= zoneLo) zoneRevisit = j;
            if (invalidation < 0 && (demand ? b.close < extent : b.close > extent)) invalidation = j;
          }
          const stopAt = Math.min(zoneRevisit < 0 ? Infinity : zoneRevisit,
                                  invalidation < 0 ? Infinity : invalidation, i + HORIZON);
          let mfe = -Infinity;
          for (let j = i + 1; j <= Math.min(series.length - 1, stopAt); j++) {
            const v = favUp ? series[j].high : series[j].low;
            const dd = favUp ? v - proximal : proximal - v;
            if (dd > mfe) mfe = dd;
          }
          const firstIntA = pick(e => e.significance === "internal");
          const firstExtA = pick(e => e.significance === "external");

          return {
            date: k.date, side: k.side, index: i,
            candle: {
              o: c.open, h: c.high, l: c.low, c: c.close,
              colour: c.close >= c.open ? "up" : "down",
              rangeAtr: r(rng / a), bodyAtr: r(Math.abs(c.close - c.open) / a),
              bodyRangeRatio: rng > 0 ? r(Math.abs(c.close - c.open) / rng) : null,
              upperWickRatio: rng > 0 ? r((c.high - bodyHi) / rng) : null,
              lowerWickRatio: rng > 0 ? r((bodyLo - c.low) / rng) : null,
            },
            box: { proximal: r(proximal, 5), distal: r(distal, 5), extent: r(extent, 5),
                   zoneLow: r(zoneLo, 5), zoneHigh: r(zoneHi, 5) },
            contractionWindows: windows,
            positionInSequence: {
              barsFromLastGrab_w10: lastGrabBars,
              candleIsTheGrab_w10: w10?.clearance?.candleIsTheGrab ?? null,
              isFirstOppositeColourAfterGrab: firstOppAfterGrab === i,
              firstOppositeColourAfterGrabDate: firstOppAfterGrab < 0 ? null : dstr(firstOppAfterGrab),
              isLastOppositeColourBeforeExpansion: lastOppBeforeExp === i,
              lastOppositeColourBeforeExpansionDate: lastOppBeforeExp < 0 ? null : dstr(lastOppBeforeExp),
            },
            ipoNeighbourhood: neighbours,
            expansion: {
              firstRunStart: expStart < 0 ? null : dstr(expStart),
              firstRunEnd: expStart < 0 ? null : dstr(expEnd),
              barsAfterCandle: expStart < 0 ? null : expStart - i,
              lengthBars: expStart < 0 ? null : expEnd - expStart + 1,
              displacementAtr: expDisp,
              mfe5: mfeAt(5), mfe10: mfeAt(10), mfe20: mfeAt(20), mfe40: mfeAt(40),
            },
            alignedStructure: {
              direction: wantDir,
              firstInternal: firstIntA, firstExternal: firstExtA,
              firstBOS: pick(e => e.kind === "BOS"), firstCHoCH: pick(e => e.kind === "CHoCH"),
              levelsClosedThroughCount: alignedLedger.length,
              levelsClosedThrough: alignedLedger.slice(0, 10),
            },
            zoneLifecycle: {
              firstZoneRevisitDate: zoneRevisit < 0 ? null : dstr(zoneRevisit),
              firstZoneRevisitBars: zoneRevisit < 0 ? null : zoneRevisit - i,
              firstInvalidationDate: invalidation < 0 ? null : dstr(invalidation),
              firstInvalidationBars: invalidation < 0 ? null : invalidation - i,
              mfeBeforeZoneRevisitOrInvalidationAtr: Number.isFinite(mfe) ? r(mfe / a) : null,
              zoneRevisitBeforeAlignedInternal: firstIntA && zoneRevisit >= 0
                ? (zoneRevisit - i) < firstIntA.barsAfter : null,
              zoneRevisitBeforeAlignedExternal: firstExtA && zoneRevisit >= 0
                ? (zoneRevisit - i) < firstExtA.barsAfter : null,
            },
          };
        });

        out.push({
          symbol: sym, interval: tf, bars: series.length,
          firstBar: series[0]?.datetime ?? null, lastBar: series[series.length - 1]?.datetime ?? null,
          horizon: HORIZON, windows: WINDOWS, knownCandles: rows,
        });
      }
      return respond({
        note: "DESCRIPTIVE ONLY. No selection, no ranking, no thresholds, no IPO " +
              "definition. Clearance is measured against a PRIOR range so it is " +
              "never circular. Zone lifecycle uses the PROXIMAL HALF only — extent " +
              "is invalidation, not a boundary. Selector, TURN/continuation rules, " +
              "body threshold, canonical engine, geometry and production are " +
              "untouched. BTC holdout remains 0/3 and is not relabelled.",
        out,
      });
    }

    // ── ezzy_exception_segment_audit ─────────────────────────────────────
    // DESCRIPTIVE ONLY, and deliberately narrow. It answers one question:
    //
    //   what distinguishes the known Ezzy boxes that are NOT the final
    //   opposite-colour candle before favourable expansion?
    //
    // It invents no rule. It does not read canonical structure, BOS/CHoCH,
    // TURN or continuation labels, body-ratio thresholds, the past-10 extreme
    // rule, contraction/compression filters, ranking or selector logic. It
    // changes no geometry and no production consumer.
    //
    // Only three ingredients are used, all carried over unchanged:
    //   1. the non-circular prior-range grab from the phase audit
    //        priorRange  [i-2W, i-W-1]      contraction [i-W, i-1]
    //        clearance scanned [i-W, i] AGAINST priorRange
    //   2. the structural expansion definition — first maximal run of
    //      favourable-direction candles, no ATR threshold
    //   3. candle colour
    //
    // Opposite-colour means opposite to the expansion: a DOWN candle before an
    // up move (demand), an UP candle before a down move (supply).
    //
    // Frozen findings this must not disturb: geometry solved; one-sided
    // clearance 9/10; known candle is the grab bar 0/10; last opposite-colour
    // before expansion 8/10; BTC holdout 0/3.
    if (action === "ezzy_exception_segment_audit") {
      const targets = Array.isArray(body?.targets) ? body.targets : [];
      const W = Number(body?.window ?? 10);
      const HORIZON = Number(body?.horizon ?? 40);
      const out: any[] = [];

      for (const tgt of targets) {
        const sym = String(tgt.symbol);
        const tf = String(tgt.interval ?? "1d");
        const barsBack = Number(tgt.limit ?? body?.limit ?? 800);
        const res = await fetchCandlesWithFallback({ symbol: sym, interval: tf, limit: barsBack, skipBroker: true });
        const isFx = (SPECS as any)[sym]?.type === "forex";
        const series = dropFxClosedBars(res.candles ?? [], isFx);
        if (series.length < 80) { out.push({ symbol: sym, error: `only ${series.length} bars` }); continue; }

        const r = (x: number | null, d = 2) =>
          x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;
        const atrAt = (i: number) => {
          const sl = series.slice(Math.max(0, i - 14), i);
          return sl.length ? sl.reduce((a: number, c: Candle) => a + (c.high - c.low), 0) / sl.length : 0;
        };
        const dstr = (i: number) => series[i]?.datetime?.slice(0, 10) ?? null;
        const shape = (j: number) => {
          const n = series[j], nr = n.high - n.low, na = atrAt(j) || 1;
          const bh = Math.max(n.open, n.close), bl = Math.min(n.open, n.close);
          return {
            date: dstr(j), colour: n.close >= n.open ? "up" : "down",
            o: n.open, h: n.high, l: n.low, c: n.close,
            rangeAtr: r(nr / na),
            bodyRangeRatio: nr > 0 ? r(Math.abs(n.close - n.open) / nr) : null,
            upperWickRatio: nr > 0 ? r((n.high - bh) / nr) : null,
            lowerWickRatio: nr > 0 ? r((bl - n.low) / nr) : null,
          };
        };

        const rows = (tgt.knownBoxes ?? []).map((k: any) => {
          const i = series.findIndex(c => c.datetime.slice(0, 10) === String(k.date));
          if (i < 0) return { date: k.date, side: k.side, error: "candle not in series" };
          const demand = k.side === "demand";
          const favUp = demand;
          const oppIsUp = !demand;          // supply boxes are up candles

          // ── 1. most recent one-sided grab, non-circular ──────────────
          const pS = i - 2 * W, pE = i - W - 1;
          let pri: { hi: number; lo: number } | null = null;
          if (pS >= 0) {
            let hi = -Infinity, lo = Infinity;
            for (let j = pS; j <= pE; j++) { if (series[j].high > hi) hi = series[j].high; if (series[j].low < lo) lo = series[j].low; }
            pri = { hi, lo };
          }
          let aboveIdx = -1, belowIdx = -1;
          if (pri) {
            for (let j = i - W; j <= i; j++) {
              if (j < 0) continue;
              if (series[j].high > pri.hi) aboveIdx = j;      // LAST, not first
              if (series[j].low < pri.lo) belowIdx = j;
            }
          }
          const grabIdx = Math.max(aboveIdx, belowIdx);
          const grabSide = grabIdx < 0 ? null : (grabIdx === aboveIdx ? "high" : "low");
          const grabFound = grabIdx >= 0;
          // No grab inside the window (BTC 2020-03-27). Fall back to the window
          // start so a segment still exists, and SAY SO rather than silently
          // producing a segment that looks equivalent.
          const segStart = grabFound ? grabIdx : Math.max(0, i - W);

          // ── 2. first favourable expansion after the known candle ─────
          let expStart = -1, expEnd = -1;
          for (let j = i + 1; j < Math.min(series.length, i + 1 + HORIZON); j++) {
            const up = series[j].close >= series[j].open;
            if (up === favUp) { if (expStart < 0) expStart = j; expEnd = j; }
            else if (expStart >= 0) break;
          }
          const segEnd = expStart < 0 ? Math.min(series.length - 1, i + HORIZON) : expStart - 1;

          // ── 3. every opposite-colour candle in the segment ───────────
          const opp: any[] = [];
          for (let j = segStart; j <= segEnd; j++) {
            if ((series[j].close >= series[j].open) !== oppIsUp) continue;
            opp.push({
              ...shape(j), index: j,
              barsFromGrab: grabFound ? j - grabIdx : null,
              barsToExpansion: expStart < 0 ? null : expStart - j,
              insidePriorRange: pri ? (series[j].high <= pri.hi && series[j].low >= pri.lo) : null,
              isKnownEzzyCandle: j === i,
            });
          }
          const pos = opp.findIndex(x => x.isKnownEzzyCandle);
          const fromEnd = pos < 0 ? null : opp.length - pos;   // 1 = last

          return {
            date: k.date, side: k.side, index: i,
            grab: {
              found: grabFound, date: grabFound ? dstr(grabIdx) : null, side: grabSide,
              barsFromGrabToKnownCandle: grabFound ? i - grabIdx : null,
              priorRangeHigh: pri ? r(pri.hi, 5) : null, priorRangeLow: pri ? r(pri.lo, 5) : null,
              segmentStartFallback: !grabFound,
            },
            expansion: {
              startDate: expStart < 0 ? null : dstr(expStart),
              endDate: expStart < 0 ? null : dstr(expEnd),
              barsFromKnownCandle: expStart < 0 ? null : expStart - i,
            },
            segment: { from: dstr(segStart), to: dstr(segEnd), bars: segEnd - segStart + 1 },
            oppositeColourCandidates: opp,
            knownCandlePositionFromEnd: fromEnd,   // 1 = last, 2 = second-to-last, ...
            knownCandleIsLastOpposite: fromEnd === 1,
            oppositeColourCount: opp.length,
            // Full bar-by-bar segment, every candle regardless of colour, so
            // the exceptions can be read directly rather than inferred.
            fullSegment: (() => {
              const arr: any[] = [];
              for (let j = segStart; j <= (expStart < 0 ? segEnd : expEnd); j++) {
                arr.push({
                  ...shape(j), index: j, offsetFromKnown: j - i,
                  isGrabBar: grabFound && j === grabIdx,
                  isKnownEzzyCandle: j === i,
                  isExpansionBar: expStart >= 0 && j >= expStart && j <= expEnd,
                  isOppositeColour: (series[j].close >= series[j].open) === oppIsUp,
                });
              }
              return arr;
            })(),
          };
        });

        out.push({ symbol: sym, interval: tf, bars: series.length, window: W, knownCandles: rows });
      }
      return respond({
        note: "DESCRIPTIVE ONLY. Uses only the non-circular prior-range grab, the " +
              "structural expansion definition and candle colour. No canonical " +
              "structure, BOS/CHoCH, TURN/continuation labels, body thresholds, " +
              "past-10 rule, contraction filters, ranking, selector or geometry " +
              "changes. No new rule is proposed. Frozen: geometry solved; " +
              "one-sided clearance 9/10; candle is grab bar 0/10; last " +
              "opposite-colour before expansion 8/10; BTC holdout 0/3.",
        out,
      });
    }

    // ── ezzy_recent_grab_phase ───────────────────────────────────────────
    // DESCRIPTIVE ONLY. Re-derives the phase summary using the MOST RECENT
    // liquidity grab, and nothing else.
    //
    // WHY IT IS BEING RE-DERIVED. The earlier phase audit recorded the FIRST
    // occurrence of each side's clearance and reported "known candle is the
    // grab bar: 0/10". That was measuring whether the candle was the later of
    // two first-occurrences, which is a different question. Under the correct
    // most-recent definition the answer is 6/10, and for those six the segment
    // collapses to a single candidate, which also means the "last
    // opposite-colour before expansion 8/10" was mostly vacuous — it is 2/4 on
    // the non-trivial segments.
    //
    // Deliberately NOT used anywhere here: BOS/CHoCH, canonical structure
    // events, TURN or continuation labels, body-ratio thresholds, the past-10
    // extreme rule, contraction/compression filters, and any ranking. Selector
    // logic, geometry and production consumers are untouched.
    //
    // The grab remains non-circular:
    //   priorRange  [i-2W, i-W-1]     scan [i-W, i] AGAINST it, keep the LAST
    if (action === "ezzy_recent_grab_phase") {
      const targets = Array.isArray(body?.targets) ? body.targets : [];
      const W = Number(body?.window ?? 10);
      const out: any[] = [];

      for (const tgt of targets) {
        const sym = String(tgt.symbol);
        const tf = String(tgt.interval ?? "1d");
        const barsBack = Number(tgt.limit ?? body?.limit ?? 800);
        const res = await fetchCandlesWithFallback({ symbol: sym, interval: tf, limit: barsBack, skipBroker: true });
        const isFx = (SPECS as any)[sym]?.type === "forex";
        const series = dropFxClosedBars(res.candles ?? [], isFx);
        if (series.length < 80) { out.push({ symbol: sym, error: `only ${series.length} bars` }); continue; }

        const r = (x: number | null, d = 2) =>
          x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;
        const atrAt = (i: number) => {
          const sl = series.slice(Math.max(0, i - 14), i);
          return sl.length ? sl.reduce((a: number, c: Candle) => a + (c.high - c.low), 0) / sl.length : 0;
        };
        const dstr = (i: number) => series[i]?.datetime?.slice(0, 10) ?? null;
        const bar = (j: number) => {
          const n = series[j], nr = n.high - n.low, na = atrAt(j) || 1;
          const bh = Math.max(n.open, n.close), bl = Math.min(n.open, n.close);
          return {
            date: dstr(j), colour: n.close >= n.open ? "up" : "down",
            o: n.open, h: n.high, l: n.low, c: n.close,
            rangeAtr: r(nr / na),
            bodyRangeRatio: nr > 0 ? r(Math.abs(n.close - n.open) / nr) : null,
            upperWickRatio: nr > 0 ? r((n.high - bh) / nr) : null,
            lowerWickRatio: nr > 0 ? r((bl - n.low) / nr) : null,
          };
        };

        const rows = (tgt.knownBoxes ?? []).map((k: any) => {
          const i = series.findIndex(c => c.datetime.slice(0, 10) === String(k.date));
          if (i < 0) return { date: k.date, side: k.side, error: "candle not in series" };
          const demand = k.side === "demand";
          const a = atrAt(i) || 1;

          const pS = i - 2 * W, pE = i - W - 1;
          if (pS < 0) return { date: k.date, side: k.side, error: "insufficient history for prior range" };
          let phi = -Infinity, plo = Infinity;
          for (let j = pS; j <= pE; j++) {
            if (series[j].high > phi) phi = series[j].high;
            if (series[j].low < plo) plo = series[j].low;
          }

          // MOST RECENT clearance of each side, scanned forward but kept last.
          let aboveIdx = -1, belowIdx = -1;
          for (let j = i - W; j <= i; j++) {
            if (j < 0) continue;
            if (series[j].high > phi) aboveIdx = j;
            if (series[j].low < plo) belowIdx = j;
          }
          const anyClearance = aboveIdx >= 0 || belowIdx >= 0;
          const grabIdx = Math.max(aboveIdx, belowIdx);
          const grabSide = grabIdx < 0 ? null : (grabIdx === aboveIdx ? "high" : "low");
          const isGrabBar = grabIdx >= 0 && grabIdx === i;

          // Aligned means the grab took the liquidity the box then trades away
          // from: a demand box after a low is taken, a supply box after a high.
          const grabAligned = grabIdx < 0 ? null
            : (demand ? grabSide === "low" : grabSide === "high");

          const grabBar = grabIdx < 0 ? null : series[grabIdx];
          const level = grabSide === "high" ? phi : plo;
          const closeThrough = grabIdx < 0 ? null
            : (grabSide === "high" ? grabBar!.close > phi : grabBar!.close < plo);
          const exceededAtr = grabIdx < 0 ? null
            : r(Math.abs((grabSide === "high" ? grabBar!.high - phi : plo - grabBar!.low)) / a);

          // ── excursion vs penetration ─────────────────────────────────
          // extremeExcursion  how far the WICK went past the prior extreme
          // closePenetration  how far the CLOSE finished past it, floored at 0
          //
          // These answer different questions. A bar can spear 2 ATR beyond a
          // level and close back inside — excursion large, penetration zero —
          // which is a rejection, not acceptance. The ratio is the share of the
          // excursion that was held into the close: 0 means the move was
          // entirely given back, 1 means the bar closed at its extreme.
          //
          // Both use ATR at the KNOWN CANDLE, matching exceededPriorRangeAtr so
          // the figures stay comparable. For Group A the grab bar and the known
          // candle are the same bar, so the choice is moot there; for Group B
          // they differ by 1-5 bars.
          const extremeExcursionAtr = grabIdx < 0 ? null
            : r(Math.max(0, grabSide === "high" ? grabBar!.high - phi : plo - grabBar!.low) / a);
          const closePenetrationAtr = grabIdx < 0 ? null
            : r(Math.max(0, grabSide === "high" ? grabBar!.close - phi : plo - grabBar!.close) / a);
          const penetrationRatio = (extremeExcursionAtr == null || closePenetrationAtr == null
            || extremeExcursionAtr === 0) ? null
            : r(closePenetrationAtr / extremeExcursionAtr);

          // Only populated when the candle is NOT the grab bar.
          const between: any[] = [];
          if (grabIdx >= 0 && grabIdx < i) {
            for (let j = grabIdx + 1; j <= i; j++) {
              between.push({ ...bar(j), offsetFromGrab: j - grabIdx, offsetFromKnown: j - i,
                             isKnownEzzyCandle: j === i });
            }
          }

          return {
            date: k.date, side: k.side, index: i,
            anyOneSidedClearance: anyClearance,
            mostRecentGrab: {
              date: grabIdx < 0 ? null : dstr(grabIdx),
              side: grabSide,
              level: grabIdx < 0 ? null : r(level, 5),
              wickOnly: grabIdx < 0 ? null : !closeThrough,
              closeThrough,
              exceededPriorRangeAtr: exceededAtr,
              extremeExcursionAtr,
              closePenetrationAtr,
              closePenetrationOverExtremeExcursion: penetrationRatio,
            },
            knownCandleIsGrabBar: isGrabBar,
            grabAlignedWithBoxSide: grabAligned,
            grabWasPriorLow_forDemand: demand ? (grabSide === "low") : null,
            grabWasPriorHigh_forSupply: demand ? null : (grabSide === "high"),
            barsFromGrabToKnownCandle: grabIdx < 0 ? null : i - grabIdx,
            knownCandle: bar(i),
            // exceeded-by only meaningful when the candle itself did the grab
            knownCandleExceededPriorRangeAtr: isGrabBar ? exceededAtr : null,
            knownCandleExtremeExcursionAtr: isGrabBar ? extremeExcursionAtr : null,
            knownCandleClosePenetrationAtr: isGrabBar ? closePenetrationAtr : null,
            knownCandlePenetrationRatio: isGrabBar ? penetrationRatio : null,
            barsBetweenGrabAndKnownCandle: between,
            priorRange: { from: dstr(pS), to: dstr(pE), high: r(phi, 5), low: r(plo, 5) },
            group: grabIdx < 0 ? "NO_GRAB" : (isGrabBar ? "A" : "B"),
          };
        });

        out.push({ symbol: sym, interval: tf, bars: series.length, window: W, knownCandles: rows });
      }
      return respond({
        note: "DESCRIPTIVE ONLY, most-recent-grab definition. No BOS/CHoCH, no " +
              "canonical structure, no TURN/continuation, no body thresholds, no " +
              "past-10 rule, no contraction filters, no ranking. Selector, " +
              "geometry and production untouched. CORRECTED FINDINGS: " +
              "candle-is-grab-bar is 6/10 (previously reported 0/10 from a " +
              "first-occurrence grab); last-opposite-colour is 2/4 on non-vacuous " +
              "segments (previously reported 8/10, inflated by six single-candidate " +
              "segments). BTC holdout remains 0/3.",
        out,
      });
    }

    // ── ezzy_archetype_a_robustness_audit ────────────────────────────────
    // READ-ONLY. Two questions, no tuning:
    //
    //   1. is Archetype A robust to reasonable prior-range window changes?
    //   2. is it rare enough in the wild to discriminate?
    //
    // ARCHETYPE A IS FROZEN EXACTLY AS MEASURED at W=10 and is not adjusted
    // here. Its observed floors, taken from the six known boxes and used only
    // as reporting bounds:
    //
    //   aligned          demand candle closes below the prior LOW
    //                    supply candle closes above the prior HIGH
    //   the candle IS the most recent grab, and it CLOSES through
    //   closePenetrationAtr  >= 0.89   (observed minimum)
    //   penetrationRatio     >= 0.83   (observed minimum)
    //
    // No new threshold is chosen. The floors are the observed minima of the
    // labelled set, used to count how much company those six candles have.
    //
    // BACKGROUND CANDIDATES, NOT FALSE POSITIVES. An unlabelled candle that
    // matches the pattern is not a negative — nobody has said it is not a box.
    // The output is deliberately named candidates throughout, because the
    // reference set contains no labelled negatives and calling these errors
    // would invent a ground truth that does not exist.
    //
    // Not used: canonical structure, BOS/CHoCH, TURN/continuation, body
    // thresholds, past-10 rule, contraction filters, ranking, selector logic.
    if (action === "ezzy_archetype_a_robustness_audit") {
      const targets = Array.isArray(body?.targets) ? body.targets : [];
      const WINDOWS: number[] = Array.isArray(body?.windows) ? body.windows : [5, 7, 10, 12, 15, 20];
      const PEN_FLOOR = Number(body?.penFloor ?? 0.89);     // observed Group A minimum
      const RATIO_FLOOR = Number(body?.ratioFloor ?? 0.83); // observed Group A minimum
      const out: any[] = [];

      for (const tgt of targets) {
        const sym = String(tgt.symbol);
        const tf = String(tgt.interval ?? "1d");
        const barsBack = Number(tgt.limit ?? body?.limit ?? 800);
        const res = await fetchCandlesWithFallback({ symbol: sym, interval: tf, limit: barsBack, skipBroker: true });
        const isFx = (SPECS as any)[sym]?.type === "forex";
        const series = dropFxClosedBars(res.candles ?? [], isFx);
        if (series.length < 80) { out.push({ symbol: sym, error: `only ${series.length} bars` }); continue; }

        const r = (x: number | null, d = 2) =>
          x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;
        const atrAt = (i: number) => {
          const sl = series.slice(Math.max(0, i - 14), i);
          return sl.length ? sl.reduce((a: number, c: Candle) => a + (c.high - c.low), 0) / sl.length : 0;
        };
        const priorRange = (i: number, W: number) => {
          const pS = i - 2 * W, pE = i - W - 1;
          if (pS < 0) return null;
          let hi = -Infinity, lo = Infinity;
          for (let j = pS; j <= pE; j++) {
            if (series[j].high > hi) hi = series[j].high;
            if (series[j].low < lo) lo = series[j].low;
          }
          return { hi, lo };
        };

        // Measure one candle against one window, for a given box side.
        const measure = (i: number, W: number, demand: boolean) => {
          const pr = priorRange(i, W);
          if (!pr) return null;
          const a = atrAt(i) || 1;
          const c = series[i];
          // most recent grab within [i-W, i]
          let aboveIdx = -1, belowIdx = -1;
          for (let j = i - W; j <= i; j++) {
            if (j < 0) continue;
            if (series[j].high > pr.hi) aboveIdx = j;
            if (series[j].low < pr.lo) belowIdx = j;
          }
          const grabIdx = Math.max(aboveIdx, belowIdx);
          const grabSide = grabIdx < 0 ? null : (grabIdx === aboveIdx ? "high" : "low");
          const isGrabBar = grabIdx === i;
          const aligned = grabIdx < 0 ? false : (demand ? grabSide === "low" : grabSide === "high");
          const gb = grabIdx < 0 ? null : series[grabIdx];
          const exc = grabIdx < 0 ? null
            : Math.max(0, grabSide === "high" ? gb!.high - pr.hi : pr.lo - gb!.low) / a;
          const pen = grabIdx < 0 ? null
            : Math.max(0, grabSide === "high" ? gb!.close - pr.hi : pr.lo - gb!.close) / a;
          const ratio = exc && exc > 0 && pen != null ? pen / exc : null;
          return {
            window: W, alignedSide: aligned, grabSide,
            knownCandleIsMostRecentGrab: isGrabBar,
            closeThrough: grabIdx < 0 ? null : (pen ?? 0) > 0,
            extremeExcursionAtr: r(exc), closePenetrationAtr: r(pen), penetrationRatio: r(ratio),
            // "Group-A-like" reuses the FROZEN definition verbatim.
            groupALike: !!(aligned && isGrabBar && (pen ?? 0) > 0
              && (pen ?? 0) >= PEN_FLOOR && (ratio ?? 0) >= RATIO_FLOOR),
            candleColour: c.close >= c.open ? "up" : "down",
          };
        };

        // ── part 1: window sweep over the labelled boxes ───────────────
        const labelled = (tgt.knownBoxes ?? []).map((k: any) => {
          const i = series.findIndex(c => c.datetime.slice(0, 10) === String(k.date));
          if (i < 0) return { date: k.date, side: k.side, error: "candle not in series" };
          const demand = k.side === "demand";
          const perWindow = WINDOWS.map(W => measure(i, W, demand)).filter(Boolean);
          const likeCount = perWindow.filter((x: any) => x.groupALike).length;
          return {
            date: k.date, side: k.side, index: i,
            perWindow,
            groupALikeWindows: perWindow.filter((x: any) => x.groupALike).map((x: any) => x.window),
            groupALikeCount: likeCount, windowsTested: perWindow.length,
            stableAcrossAllWindows: likeCount === perWindow.length,
          };
        });

        // ── part 2: background prevalence at W=10 ──────────────────────
        // Every bar in the available history scored against the frozen pattern.
        // A bar qualifies as a demand-type candidate if it closes below the
        // prior low, supply-type if above the prior high — the alignment is
        // definitional here, since an unlabelled bar has no declared side.
        const W0 = 10;
        const cands: any[] = [];
        for (let i = 2 * W0; i < series.length; i++) {
          for (const demand of [true, false]) {
            const m = measure(i, W0, demand);
            if (!m || !m.groupALike) continue;
            // colour convention observed on all six: demand boxes are DOWN
            // candles, supply boxes are UP candles. Recorded, not required.
            const colourMatches = demand ? m.candleColour === "down" : m.candleColour === "up";
            cands.push({
              date: series[i].datetime.slice(0, 10), index: i,
              type: demand ? "demand" : "supply",
              closePenetrationAtr: m.closePenetrationAtr,
              penetrationRatio: m.penetrationRatio,
              extremeExcursionAtr: m.extremeExcursionAtr,
              colour: m.candleColour, colourMatchesConvention: colourMatches,
            });
          }
        }
        const pens = cands.map(c => c.closePenetrationAtr).sort((a, b) => a - b);
        const rats = cands.map(c => c.penetrationRatio).sort((a, b) => a - b);
        const q = (arr: number[], p: number) =>
          arr.length ? r(arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]) : null;
        const known = new Set((tgt.knownBoxes ?? []).map((k: any) => `${k.side}|${k.date}`));
        const scanned = series.length - 2 * W0;

        out.push({
          symbol: sym, interval: tf, bars: series.length,
          firstBar: series[0]?.datetime ?? null, lastBar: series[series.length - 1]?.datetime ?? null,
          windowsTested: WINDOWS,
          frozenFloors: { closePenetrationAtr: PEN_FLOOR, penetrationRatio: RATIO_FLOOR },
          labelledBoxes: labelled,
          backgroundCandidates: {
            note: "CANDIDATES, not false positives — unlabelled candles are not true negatives",
            barsScanned: scanned,
            count: cands.length,
            perHundredBars: r((cands.length / Math.max(1, scanned)) * 100),
            withColourConvention: cands.filter(c => c.colourMatchesConvention).length,
            demand: cands.filter(c => c.type === "demand").length,
            supply: cands.filter(c => c.type === "supply").length,
            closePenetrationAtrDistribution: {
              min: q(pens, 0), p25: q(pens, 0.25), median: q(pens, 0.5),
              p75: q(pens, 0.75), p90: q(pens, 0.9), max: pens.length ? r(pens[pens.length - 1]) : null,
            },
            penetrationRatioDistribution: {
              min: q(rats, 0), p25: q(rats, 0.25), median: q(rats, 0.5),
              p75: q(rats, 0.75), p90: q(rats, 0.9), max: rats.length ? r(rats[rats.length - 1]) : null,
            },
            knownBoxesAmongCandidates: cands.filter(c => known.has(`${c.type}|${c.date}`))
              .map(c => ({ date: c.date, type: c.type,
                           closePenetrationAtr: c.closePenetrationAtr,
                           penetrationRatio: c.penetrationRatio,
                           // where each known box sits inside the background
                           penetrationPercentile: pens.length
                             ? r(pens.filter(v => v <= c.closePenetrationAtr).length / pens.length * 100, 1) : null })),
            sample: cands.slice(0, 8),
          },
        });
      }
      return respond({
        note: "READ-ONLY. Archetype A is FROZEN as measured at W=10; no threshold " +
              "is tuned and no best window is chosen. The 0.89/0.83 floors are the " +
              "OBSERVED MINIMA of the six labelled Group A boxes, used only as " +
              "reporting bounds. Matches in unlabelled history are BACKGROUND " +
              "CANDIDATES, not false positives — the reference set contains no " +
              "labelled negatives. Selector, geometry, canonical structure and " +
              "production are untouched. BTC holdout remains 0/3.",
        out,
      });
    }

    // ── ezzy_labels ──────────────────────────────────────────────────────
    // Scaffold for the labelled-example dataset. Research only: nothing here
    // reads or writes trading state, and the selector, geometry, canonical
    // structure and production consumers are untouched.
    //
    // THE POINT OF THE THREE CLASSES. Three candidate rules have been
    // eliminated by the same mechanism — strong on ten labelled positives,
    // collapsing against a holdout or a background population. The missing
    // ingredient is explicit NEGATIVES: candles that were looked at and turned
    // down. UNKNOWN is NOT a negative and the schema refuses to let it drift
    // into one; an unboxed candle is unevaluated, not rejected.
    //
    // A NEGATIVE MUST BE EXPLICIT. The database enforces it too. An inferred
    // rejection is an assumption about what someone would have said, which is
    // the exact failure this dataset exists to prevent.
    //
    // VALIDATION IS SEALED. Rows marked split='validation' are never returned
    // by `list` unless the caller passes the unseal phrase. The friction is
    // deliberate: a holdout that can be glanced at during rule selection is not
    // a holdout. `stats` reports validation COUNTS only, never content, so
    // progress can be tracked without contaminating the reserve.
    if (action === "ezzy_labels") {
      const sub = String(body?.sub ?? "stats");

      // ── AUTH: identity comes from the JWT, never from the request body ──
      // An earlier draft took userId from the body and queried with the
      // service-role key, which bypasses RLS entirely — anyone holding the
      // publishable key could have read or written another account's research
      // data by naming their id. The publishable key is public by design, so
      // that was a real hole, not a theoretical one.
      //
      // The client is built with the ANON key plus the caller's own
      // Authorization header, so every query below is executed AS THAT USER and
      // row-level security enforces ownership. Even if a user_id were somehow
      // wrong in a payload, the RLS policy would reject the write.
      const authHeader = req.headers.get("Authorization") ?? "";
      if (!authHeader.startsWith("Bearer ")) {
        return respond({ error: "Authorization: Bearer <jwt> required" });
      }
      const token = authHeader.slice("Bearer ".length);
      const supa = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } },
      );
      const { data: claimsData, error: claimsErr } = await supa.auth.getClaims(token);
      const userId = String(claimsData?.claims?.sub ?? "");
      if (claimsErr || !userId) {
        // The anon key is itself a valid JWT but carries no `sub`, so this also
        // rejects an unauthenticated caller rather than silently using a blank id.
        return respond({ error: "a signed-in user session is required (no sub claim on this token)" });
      }

      const TARGETS = {
        positives: 20, explicitNegatives: 15,
        validationPositives: 5, validationNegatives: 5,
      };

      if (sub === "add") {
        const rows = Array.isArray(body?.examples) ? body.examples : [];
        if (!rows.length) return respond({ error: "examples[] required" });
        const bad: any[] = [];
        const prepared = rows.map((e: any, n: number) => {
          const label = String(e.label ?? "").toUpperCase();
          const basis = String(e.labelBasis ?? "explicit");
          if (!["POSITIVE", "NEGATIVE", "UNKNOWN"].includes(label)) bad.push({ n, why: "bad label" });
          if (label === "NEGATIVE" && basis !== "explicit") {
            bad.push({ n, why: "a NEGATIVE must be explicit — an inferred rejection is an assumption" });
          }
          if (label !== "UNKNOWN" && !e.side) bad.push({ n, why: "side required for POSITIVE/NEGATIVE" });
          return {
            user_id: userId,
            source_video: e.sourceVideo ?? null,
            source_timestamp: e.sourceTimestamp ?? null,
            reference_url: e.referenceUrl ?? null,
            symbol: e.symbol, timeframe: e.timeframe,
            candle_datetime: e.candleDatetime ?? null,
            side: e.side ?? null,
            label, label_basis: basis,
            reason: e.reason ?? null,
            split: e.split ?? "development",
            contaminated: !!e.contaminated,
            notes: e.notes ?? null,
          };
        });
        if (bad.length) return respond({ error: "validation failed", problems: bad });
        const { data, error } = await supa.from("ezzy_labelled_examples")
          .upsert(prepared, { onConflict: "user_id,symbol,timeframe,candle_datetime,side" })
          .select("id");
        if (error) return respond({ error: error.message });
        return respond({ inserted: data?.length ?? 0 });
      }

      if (sub === "list") {
        const unsealed = String(body?.unsealValidation ?? "") === "I_AM_VALIDATING_NOT_TUNING";
        let qy = supa.from("ezzy_labelled_examples").select("*").eq("user_id", userId);
        if (!unsealed) qy = qy.eq("split", "development");
        if (body?.label) qy = qy.eq("label", String(body.label).toUpperCase());
        const { data, error } = await qy.order("symbol").order("candle_datetime");
        if (error) return respond({ error: error.message });
        return respond({
          validationIncluded: unsealed,
          warning: unsealed
            ? "VALIDATION ROWS INCLUDED. Do not use these while choosing rules."
            : "development rows only; validation is sealed",
          count: data?.length ?? 0, examples: data ?? [],
        });
      }

      // stats — counts only, safe to call at any time
      const { data, error } = await supa.from("ezzy_labelled_examples")
        .select("label,label_basis,split,symbol,timeframe,contaminated").eq("user_id", userId);
      if (error) return respond({ error: error.message });
      const all = data ?? [];
      const n = (f: (r: any) => boolean) => all.filter(f).length;
      const dev = all.filter(r => r.split === "development");
      const val = all.filter(r => r.split === "validation");
      const explicitNeg = n(r => r.label === "NEGATIVE" && r.label_basis === "explicit");
      return respond({
        targets: TARGETS,
        total: all.length,
        byLabel: {
          POSITIVE: n(r => r.label === "POSITIVE"),
          NEGATIVE: n(r => r.label === "NEGATIVE"),
          UNKNOWN: n(r => r.label === "UNKNOWN"),
        },
        explicitNegatives: explicitNeg,
        development: {
          total: dev.length,
          POSITIVE: dev.filter(r => r.label === "POSITIVE").length,
          NEGATIVE: dev.filter(r => r.label === "NEGATIVE").length,
        },
        validation: {
          total: val.length,
          POSITIVE: val.filter(r => r.label === "POSITIVE").length,
          NEGATIVE: val.filter(r => r.label === "NEGATIVE").length,
        },
        contaminated: n(r => r.contaminated),
        symbols: [...new Set(all.map(r => r.symbol))].sort(),
        timeframes: [...new Set(all.map(r => r.timeframe))].sort(),
        readyForFeatureWork:
          n(r => r.label === "POSITIVE") >= TARGETS.positives &&
          explicitNeg >= TARGETS.explicitNegatives &&
          val.filter(r => r.label === "POSITIVE").length >= TARGETS.validationPositives &&
          val.filter(r => r.label === "NEGATIVE").length >= TARGETS.validationNegatives,
        gaps: {
          positivesNeeded: Math.max(0, TARGETS.positives - n(r => r.label === "POSITIVE")),
          explicitNegativesNeeded: Math.max(0, TARGETS.explicitNegatives - explicitNeg),
          validationPositivesNeeded: Math.max(0, TARGETS.validationPositives - val.filter(r => r.label === "POSITIVE").length),
          validationNegativesNeeded: Math.max(0, TARGETS.validationNegatives - val.filter(r => r.label === "NEGATIVE").length),
        },
      });
    }

    // ── ipo_zones_shadow ─────────────────────────────────────────────────
    // The single read-only entry point for the IPO detector. Shadow only:
    // nothing in production calls detectIPOZones, and a test asserts that no
    // module outside this file imports it.
    if (action === "ipo_zones_shadow") {
      const targets = Array.isArray(body?.targets) ? body.targets : [];
      const out: any[] = [];
      for (const tgt of targets) {
        const sym = String(tgt.symbol);
        const tf = String(tgt.interval ?? "1d");
        const barsBack = Number(tgt.limit ?? body?.limit ?? 800);
        const res = await fetchCandlesWithFallback({ symbol: sym, interval: tf, limit: barsBack, skipBroker: true });
        const isFx = (SPECS as any)[sym]?.type === "forex";
        const series = dropFxClosedBars(res.candles ?? [], isFx);
        if (series.length < 60) { out.push({ symbol: sym, error: `only ${series.length} bars` }); continue; }

        // Valid and rejected are reported separately. A candidate refused by
        // interpretation is never counted as a known-box detection, but it stays
        // visible so an interpretation failure is distinguishable from a
        // detection failure.
        const { valid: zones, rejected, accepted, unresolved } = detectIPOCandidates(series, { symbol: sym, timeframe: tf });
        const byDate = new Map(zones.map(z => [`${z.direction}|${z.candleDatetime.slice(0, 10)}`, z]));
        const rejectedByDate = new Map(rejected.map(z => [`${z.direction}|${z.candleDatetime.slice(0, 10)}`, z]));

        // Score against whichever boxes the caller names. No tuning happens
        // here — the detector is not parameterised from this result.
        const known = (tgt.knownBoxes ?? []).map((k: any) => {
          const hit = byDate.get(`${k.side}|${k.date}`) ?? null;
          const rej = rejectedByDate.get(`${k.side}|${k.date}`) ?? null;
          return {
            date: k.date, side: k.side,
            detected: !!hit && hit.researchStatus === "CANDIDATE_ACCEPTED",
            researchStatus: hit ? hit.researchStatus : null,
            consolidationStatus: hit ? hit.consolidationStatus : null,
            consolidationFlagRaised: hit ? hit.consolidationFlagRaised : null,
            rejectedCandidate: rej ? {
              rejectionReason: rej.rejectionReason,
              consolidation: rej.consolidation,
              structure: rej.structure,
              candleDatetime: rej.candleDatetime,
            } : null,
            zone: hit ? {
              candleDatetime: hit.candleDatetime,
              geometry: hit.geometry,
              structure: hit.structure,
              selection: hit.selection,
              liquidity: hit.liquidity,
              consolidation: hit.consolidation,
              departureFvg: hit.departureFvg,
              lifecycle: {
                status: hit.lifecycle.status,
                testCount: hit.lifecycle.testCount,
                brokenAtDatetime: hit.lifecycle.brokenAtDatetime,
                flipRetestCount: hit.lifecycle.flipRetestCount,
              },
            } : null,
          };
        });

        out.push({
          symbol: sym, interval: tf, bars: series.length,
          zonesAccepted: accepted.length,
          zonesUnresolved: unresolved.length,
          zonesRejected: rejected.length,
          // Deliberately NOT summed: accepted + unresolved is not a detection count.
          zonesDetected: accepted.length,
          rejectionBreakdown: { INSIDE_CONSOLIDATION: rejected.filter(z => z.rejectionReason === "INSIDE_CONSOLIDATION").length },
          zonesPerHundredBars: Math.round((zones.length / series.length) * 1000) / 10,
          knownBoxes: known,
          statusBreakdown: {
            ACTIVE: zones.filter(z => z.lifecycle.status === "ACTIVE").length,
            TESTED: zones.filter(z => z.lifecycle.status === "TESTED").length,
            BROKEN: zones.filter(z => z.lifecycle.status === "BROKEN").length,
            FLIPPED: zones.filter(z => z.lifecycle.status === "FLIPPED").length,
          },
          sample: zones.slice(-3),
        });
      }
      return respond({
        note: "SHADOW ONLY. detectIPOZones has no production consumer. Parameters " +
              "encode a taught rule and were NOT tuned against the known boxes.",
        out,
      });
    }

    // ── ipo_failure_trace ────────────────────────────────────────────────
    // READ-ONLY. Phase A failure tracing and Phase B consolidation research.
    // detectIPOZones behaviour is unchanged; these re-walk and narrate.
    if (action === "ipo_failure_trace") {
      const targets = Array.isArray(body?.targets) ? body.targets : [];
      const out: any[] = [];
      for (const tgt of targets) {
        const sym = String(tgt.symbol);
        const tf = String(tgt.interval ?? "1d");
        const barsBack = Number(tgt.limit ?? body?.limit ?? 800);
        const res = await fetchCandlesWithFallback({ symbol: sym, interval: tf, limit: barsBack, skipBroker: true });
        const isFx = (SPECS as any)[sym]?.type === "forex";
        const series = dropFxClosedBars(res.candles ?? [], isFx);
        if (series.length < 60) { out.push({ symbol: sym, error: `only ${series.length} bars` }); continue; }
        out.push({
          symbol: sym, interval: tf, bars: series.length,
          traces: (tgt.trace ?? []).map((t: any) =>
            traceIPOCandidateFailure(series, String(t.date), t.side)),
          consolidationProfiles: (tgt.profile ?? []).map((p: any) => {
            const i = series.findIndex(c => c.datetime.slice(0, 10) === String(p.date));
            return i < 0 ? { date: p.date, error: "not in series" }
              : { side: p.side, ...analyzeLocalConsolidation(series, i) };
          }),
        });
      }
      return respond({
        note: "READ-ONLY. Phase A traces why a known candle was or was not " +
              "constructed; Phase B measures the local ranging condition without " +
              "deciding validity. No default changed, no gate added, detectIPOZones " +
              "untouched.",
        out,
      });
    }

    // ── ipo_origin_hypotheses ────────────────────────────────────────────
    // READ-ONLY. Measures candidate departure-origin anchors. selectIPOCandle,
    // the intervening budget and the lookback are used UNMODIFIED; only the
    // launch position varies. detectIPOZones is untouched.
    if (action === "ipo_origin_hypotheses") {
      const targets = Array.isArray(body?.targets) ? body.targets : [];
      const out: any[] = [];
      for (const tgt of targets) {
        const sym = String(tgt.symbol);
        const tf = String(tgt.interval ?? "1d");
        const barsBack = Number(tgt.limit ?? body?.limit ?? 800);
        const res = await fetchCandlesWithFallback({ symbol: sym, interval: tf, limit: barsBack, skipBroker: true });
        const isFx = (SPECS as any)[sym]?.type === "forex";
        const series = dropFxClosedBars(res.candles ?? [], isFx);
        if (series.length < 60) { out.push({ symbol: sym, error: `only ${series.length} bars` }); continue; }
        out.push({
          symbol: sym, interval: tf, bars: series.length,
          hypotheses: (tgt.trace ?? []).map((t: any) =>
            traceDepartureOriginHypotheses(series, String(t.date), t.side, { detailCap: Number(body?.detailCap ?? 24) })),
          background: body?.includeBackground === false ? null : originHypothesisBackground(series),
        });
      }
      return respond({
        note: "READ-ONLY research. selectIPOCandle, maxInterveningCandles, " +
              "interveningMaxRangeAtr and maxLookbackForIPO are UNCHANGED — only " +
              "the launch position varies. No threshold swept, nothing tuned, " +
              "detectIPOZones untouched. Consolidation now reports UNRESOLVED and " +
              "vetoes nothing.",
        out,
      });
    }

    // ── ipo_event_local ──────────────────────────────────────────────────
    // READ-ONLY. Event-local recovery and parent/child refinement. Global
    // uniqueness is retired: candidates belonging to other confirmation
    // episodes are coexisting IPOs, not competitors.
    if (action === "ipo_event_local") {
      const targets = Array.isArray(body?.targets) ? body.targets : [];
      const out: any[] = [];
      for (const tgt of targets) {
        const sym = String(tgt.symbol);
        const tf = String(tgt.interval ?? "1d");
        const barsBack = Number(tgt.limit ?? body?.limit ?? 800);
        const res = await fetchCandlesWithFallback({ symbol: sym, interval: tf, limit: barsBack, skipBroker: true });
        const isFx = (SPECS as any)[sym]?.type === "forex";
        const series = dropFxClosedBars(res.candles ?? [], isFx);
        if (series.length < 60) { out.push({ symbol: sym, error: `only ${series.length} bars` }); continue; }
        out.push({
          symbol: sym, interval: tf, bars: series.length,
          knownBoxes: (tgt.knownBoxes ?? []).map((k: any) =>
            traceEventLocalRecovery(series, String(k.date), k.side)),
        });
      }
      // Strict and same-bar evidence are tallied APART. A same-bar departure
      // satisfies the rule but cannot prove departure preceded the break, so
      // folding the two together would overstate how much of the evidence is
      // causally ordered.
      const allBoxes = out.flatMap((o: any) => o.knownBoxes ?? []);
      const ordering = (v: string | null) =>
        allBoxes.filter((b: any) => (b.firstRelevantConfirmation?.departureBreakOrdering ?? null) === v).length;
      return respond({
        note: "READ-ONLY. Uniqueness is EVENT-LOCAL: a known IPO is compared only " +
              "against candidates for its own first relevant confirmation. Later " +
              "breaks are separate episodes and their candidates are coexisting " +
              "IPOs, not competitors. Consolidation remains UNRESOLVED, no " +
              "discriminator added, no threshold tuned, no production consumer.",
        orderingSummary: {
          knownBoxes: allBoxes.length,
          departureBeforeBreak: ordering("DEPARTURE_BEFORE_BREAK"),
          sameBarUnverifiable: ordering("SAME_BAR_UNVERIFIABLE"),
          noConfirmation: ordering(null),
          note: "same-bar cases are kept and counted separately — the bar satisfies " +
                "the rule but cannot establish that departure preceded the break",
        },
        out,
      });
    }

    // ── ipo_inventory / ipo_corpus / ipo_coverage ────────────────────────
    // READ-ONLY research. The inventory does not choose between coexisting
    // IPOs, the corpus holds positives only, and the evaluation reports
    // coverage rather than accuracy. Nothing here is wired to trading.
    if (action === "ipo_inventory" || action === "ipo_coverage") {
      const targets = Array.isArray(body?.targets) ? body.targets : [];
      const out: any[] = [];

      // Corpus rows are needed only for the coverage action, and they are the
      // caller's own rows — identity comes from the JWT, never the body.
      let corpus: any[] = [];
      if (action === "ipo_coverage") {
        const authHeader = req.headers.get("Authorization") ?? "";
        if (!authHeader.startsWith("Bearer ")) {
          return respond({ error: "Authorization: Bearer <jwt> required" });
        }
        const supa = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_ANON_KEY")!,
          { global: { headers: { Authorization: authHeader } } },
        );
        const { data: claimsData, error: claimsErr } =
          await supa.auth.getClaims(authHeader.slice("Bearer ".length));
        const userId = String(claimsData?.claims?.sub ?? "");
        if (claimsErr || !userId) {
          return respond({ error: "a signed-in user session is required (no sub claim on this token)" });
        }
        // Inline examples are accepted for dry runs, but they are labelled as
        // such so a result computed from ad-hoc input is never mistaken for one
        // measured against the stored corpus.
        if (Array.isArray(body?.examples) && body.examples.length) {
          corpus = body.examples.map((e: any, i: number) => ({ id: e.id ?? `inline-${i}`, ...e, _inline: true }));
        } else {
          const { data, error } = await supa.from("ipo_corpus_examples").select("*").eq("user_id", userId);
          if (error) return respond({ error: error.message });
          corpus = (data ?? []).map((r: any) => ({
            id: r.id, symbol: r.symbol, timeframe: r.timeframe, direction: r.direction,
            candleDatetime: r.candle_datetime,
            demonstratedZoneLow: r.demonstrated_zone_low, demonstratedZoneHigh: r.demonstrated_zone_high,
            exampleGroupId: r.example_group_id, parentExampleId: r.parent_example_id,
            evidenceSource: r.evidence_source,
          }));
        }
      }

      for (const tgt of targets) {
        const sym = String(tgt.symbol);
        // Levels are HIGHEST timeframe first; a single interval is just one level.
        const tfs: string[] = Array.isArray(tgt.timeframes) && tgt.timeframes.length
          ? tgt.timeframes.map(String) : [String(tgt.interval ?? "1d")];
        const barsBack = Number(tgt.limit ?? body?.limit ?? 800);
        const isFx = (SPECS as any)[sym]?.type === "forex";
        const levels: Array<{ timeframe: string; candles: any[] }> = [];
        const barsByTimeframe: Record<string, number> = {};
        let bad: string | null = null;
        for (const tf of tfs) {
          const res = await fetchCandlesWithFallback({ symbol: sym, interval: tf, limit: barsBack, skipBroker: true });
          const series = dropFxClosedBars(res.candles ?? [], isFx);
          if (series.length < 60) { bad = `${tf}: only ${series.length} bars`; break; }
          levels.push({ timeframe: tf, candles: series });
          barsByTimeframe[tf] = series.length;
        }
        if (bad) { out.push({ symbol: sym, error: bad }); continue; }

        const from = tgt.from ?? body?.from;
        const to = tgt.to ?? body?.to;
        const entries = buildIPOInventory(levels, {
          symbol: sym, from, to, parentContextId: tgt.parentContextId,
        });
        // Density must use the same window as the zones it counts. Dividing a
        // three-month slice of zones by a fifteen-year bar count understates
        // IPOs per 100 bars by two orders of magnitude and still looks
        // plausible — the first live run reported 0.6 where the real figure
        // for that window was 1.4.
        const viewBars = inventoryViewBars(levels, { from, to });
        const mine = corpus.filter((c: any) => c.symbol === sym);
        out.push({
          symbol: sym,
          timeframes: tfs,
          barsByTimeframe,
          barsInView: viewBars,
          dateRange: { from: from ?? null, to: to ?? null,
            note: "filters the RETURNED zones only; detection always runs on the full series" },
          ...(action === "ipo_coverage"
            ? {
              corpusSource: mine.some((c: any) => c._inline) ? "INLINE_DRY_RUN" : "STORED_CORPUS",
              demonstratedExamples: mine.length,
              ...evaluateDemonstratedCoverage(entries, mine, viewBars),
              inventory: tgt.includeZones ? entries : undefined,
            }
            : { summary: inventorySummary(entries, viewBars), inventory: entries }),
        });
      }

      return respond({
        note: "READ-ONLY, shadow research. This layer is an INVENTORY, not a " +
              "selector: every IPO is independent and coexisting IPOs are " +
              "expected, so no zone is called a false positive for the existence " +
              "of another. No discriminator was added and no selector rule was " +
              "tuned. Consolidation remains UNRESOLVED.",
        provenance: provenanceManifest(),
        out,
      });
    }

    // Corpus of demonstrated IPOs. POSITIVES ONLY — the table has no label
    // column, so an unmarked candle cannot become a negative.
    if (action === "ipo_corpus") {
      const sub = String(body?.sub ?? "stats");
      const authHeader = req.headers.get("Authorization") ?? "";
      if (!authHeader.startsWith("Bearer ")) {
        return respond({ error: "Authorization: Bearer <jwt> required" });
      }
      const supa = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } },
      );
      const { data: claimsData, error: claimsErr } =
        await supa.auth.getClaims(authHeader.slice("Bearer ".length));
      const userId = String(claimsData?.claims?.sub ?? "");
      if (claimsErr || !userId) {
        return respond({ error: "a signed-in user session is required (no sub claim on this token)" });
      }

      if (sub === "add") {
        const rows = Array.isArray(body?.examples) ? body.examples : [];
        if (!rows.length) return respond({ error: "examples[] required" });
        // Existing demonstration groups, so a re-send cannot change the identity
        // of a demonstration. Without this the mint runs again and the upsert
        // overwrites example_group_id with a fresh uuid: the rows and edges
        // survive, but every earlier reference to that group stops matching and
        // one demonstration is counted as two across runs.
        const keys = rows.map((e: any) => corpusNaturalKey(e));
        const { data: existing, error: exErr } = await supa
          .from("ipo_corpus_examples")
          .select("symbol,timeframe,candle_datetime,direction,example_group_id")
          .eq("user_id", userId)
          .in("symbol", [...new Set(rows.map((e: any) => e.symbol))]);
        if (exErr) return respond({ error: exErr.message });
        const existingGroupByKey = new Map<string, string>();
        for (const r of existing ?? []) {
          if (r.example_group_id) existingGroupByKey.set(corpusNaturalKey(r), r.example_group_id);
        }
        const reused = keys.filter((k: string) => existingGroupByKey.has(k)).length;

        const plan = planCorpusInsert(rows, userId, () => crypto.randomUUID(), existingGroupByKey);
        if (plan.problems.length) return respond({ error: "validation failed", problems: plan.problems });

        // One upsert per WAVE, roots first. A W->D->4H chain cannot go in a
        // single statement: the daily row's parent is the weekly row of the
        // same batch, which has no id until its own wave has landed.
        const idByLocal = new Map<string, string>();
        const written: any[] = [];
        for (const wave of plan.waves) {
          let payload: Array<Record<string, unknown>>;
          try {
            payload = resolveWaveParents(wave, idByLocal);
          } catch (e) {
            // A local parent that did not resolve is fatal. Writing the child
            // with a null parent would silently drop the refinement edge — the
            // exact failure the wave planner exists to prevent.
            if (e instanceof UnresolvedParentError) {
              return respond({
                error: e.message, partial: true, writtenSoFar: written,
                unresolvedLocalParent: e.localParentId, sourceRow: e.sourceIndex,
                note: "no child was written without its parent; re-send the batch to retry",
              });
            }
            throw e;
          }
          const { data, error } = await supa.from("ipo_corpus_examples")
            .upsert(payload, { onConflict: "user_id,symbol,timeframe,candle_datetime,direction" })
            .select("id,symbol,timeframe,candle_datetime,direction,example_group_id,parent_example_id");
          if (error) {
            return respond({
              error: error.message,
              partial: true,
              wavesCompleted: written.length ? plan.waves.indexOf(wave) : 0,
              writtenSoFar: written,
              note: "earlier waves are already committed; re-send the batch to finish it — " +
                    "the unique constraint makes the whole thing idempotent",
            });
          }
          // Map each returned row back to its local handle by natural key, so a
          // row that already existed resolves to its EXISTING id rather than
          // dropping the edge.
          for (const p of wave) {
            if (!p.localId) continue;
            const r = p.row as any;
            const hit = (data ?? []).find((d: any) =>
              d.symbol === r.symbol && d.timeframe === r.timeframe &&
              d.direction === r.direction &&
              (d.candle_datetime ?? null) === (r.candle_datetime ?? null));
            if (hit) idByLocal.set(p.localId, hit.id);
          }
          written.push(...(data ?? []));
        }
        const edges = written.filter((r: any) => r.parent_example_id).length;
        return respond({
          upserted: written.length,
          waves: plan.waves.length,
          refinementEdgesStored: edges,
          demonstrationGroupsReused: reused,
          demonstrations: new Set(written.map((r: any) => r.example_group_id ?? r.id)).size,
          rows: written,
          note: plan.waves.length > 1
            ? "a refinement chain was written across " + plan.waves.length + " waves; " +
              "refinementEdgesStored is the count that actually persisted"
            : "single wave, no local parent references",
        });
      }

      const { data, error } = await supa.from("ipo_corpus_examples").select("*")
        .eq("user_id", userId).order("symbol").order("timeframe").order("candle_datetime");
      if (error) return respond({ error: error.message });
      const all = data ?? [];
      const groups = new Map<string, any[]>();
      for (const r of all) {
        const g = r.example_group_id ?? `solo:${r.id}`;
        groups.set(g, [...(groups.get(g) ?? []), r]);
      }
      const chains = [...groups.values()].filter((g) => g.length > 1);

      if (sub === "list") {
        return respond({
          count: all.length,
          demonstrations: groups.size,
          examples: all,
          note: "Positives only. Absence from this list means unexamined, never rejected.",
        });
      }

      return respond({
        total: all.length,
        demonstrations: groups.size,
        note: "`demonstrations` is the metric that matters: a Weekly->Daily->4H " +
              "refinement is ONE demonstration, and `total` counts its rows " +
              "separately only for bookkeeping.",
        refinementChains: chains.length,
        deepestChain: chains.reduce((m, g) => Math.max(m, g.length), 0),
        bySymbol: [...new Set(all.map((r: any) => r.symbol))].sort(),
        byTimeframe: [...new Set(all.map((r: any) => r.timeframe))].sort(),
        byEvidenceSource: Object.fromEntries(EVIDENCE_SOURCES.map((s) =>
          [s, all.filter((r: any) => r.evidence_source === s).length])),
        withDemonstratedGeometry: all.filter((r: any) => r.demonstrated_zone_low !== null).length,
        withUnrecoverableCandle: all.filter((r: any) => !r.candle_datetime).length,
        negativesPossible: false,
        negativesNote: "There is no label column. Unmarked candles are not negatives " +
                       "and cannot be recorded as such.",
      });
    }

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
