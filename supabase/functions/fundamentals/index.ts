import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";

// ─── Fundamentals — Economic Calendar ───────────────────────────────
const CURRENCY_PAIRS: Record<string, string[]> = {
  USD: ["EUR/USD", "GBP/USD", "USD/JPY", "USD/CAD", "AUD/USD", "NZD/USD", "XAU/USD"],
  EUR: ["EUR/USD", "EUR/GBP", "EUR/JPY"], GBP: ["GBP/USD", "EUR/GBP", "GBP/JPY"],
  JPY: ["USD/JPY", "GBP/JPY"], AUD: ["AUD/USD"], CAD: ["USD/CAD"], NZD: ["NZD/USD"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { action, pair, withinMinutes = 30 } = await req.json();

    const events = await fetchCalendar();

    if (action === "data") {
      const now = new Date();
      const todayStr = now.toISOString().split("T")[0];
      const weekEnd = new Date(now.getTime() + 7 * 86400000);

      const todayEvents = events.filter(e => e.scheduledTime.startsWith(todayStr));
      const thisWeekEvents = events.filter(e => new Date(e.scheduledTime) <= weekEnd);

      const highImpact = events.filter(e => e.impact === "high").length;
      const medImpact = events.filter(e => e.impact === "medium").length;
      const lowImpact = events.filter(e => e.impact === "low").length;

      const exposure: Record<string, { high: number; medium: number; low: number }> = {};
      for (const e of thisWeekEvents) {
        if (!exposure[e.currency]) exposure[e.currency] = { high: 0, medium: 0, low: 0 };
        exposure[e.currency][e.impact as "high" | "medium" | "low"]++;
      }

      return respond({
        upcomingEvents: events.filter(e => new Date(e.scheduledTime) > now).slice(0, 20),
        todayEvents, thisWeekEvents, highImpactCount: highImpact,
        mediumImpactCount: medImpact, lowImpactCount: lowImpact,
        currencyExposure: exposure, dataSource: "live", lastUpdated: now.toISOString(),
      });
    }

    if (action === "events_for_pair") {
      const [base, quote] = (pair || "").split("/");
      const relevant = events.filter(e => e.currency === base || e.currency === quote);
      return respond(relevant);
    }

    // ── News Impact Analysis — returns directional bias per currency/pair ──
    if (action === "news_impact") {
      // Import the news impact engine
      const { analyzeNewsImpact, getNewsPairBias, checkNewsAlignment } = await import("../_shared/newsImpact.ts");
      const now = new Date();
      // Get events from the last 6 hours and next 6 hours (captures released + upcoming)
      const windowMs = 6 * 60 * 60 * 1000;
      const relevantEvents = events.filter(e => {
        const t = new Date(e.scheduledTime).getTime();
        return Math.abs(t - now.getTime()) <= windowMs;
      });
      const impacts = analyzeNewsImpact(relevantEvents);
      // If pair is specified, return pair-specific bias
      if (pair) {
        const pairBias = getNewsPairBias(pair, impacts);
        const direction = (await req.clone().json()).direction; // optional
        const alignment = direction ? checkNewsAlignment(pair, direction, impacts) : null;
        return respond({ pair, pairBias, alignment, impacts: impacts.map(i => ({ name: i.event.name, currency: i.event.currency, impact: i.event.impact, directionalImpact: i.directionalImpact, confidence: i.confidence, reasoning: i.reasoning, category: i.category })) });
      }
      // No pair — return all impacts
      return respond({ impacts: impacts.map(i => ({ name: i.event.name, currency: i.event.currency, impact: i.event.impact, directionalImpact: i.directionalImpact, confidence: i.confidence, reasoning: i.reasoning, category: i.category })) });
    }

    if (action === "high_impact_check") {
      const now = Date.now();
      const window = withinMinutes * 60 * 1000;
      const [base, quote] = (pair || "").split("/");
      const upcoming = events.filter(e => {
        const t = new Date(e.scheduledTime).getTime();
        return e.impact === "high" && (e.currency === base || e.currency === quote) &&
          Math.abs(t - now) <= window;
      });
      return respond({ hasHighImpact: upcoming.length > 0, events: upcoming });
    }

    return respond({ error: "Unknown action" });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

let cache: { data: any[]; at: number } | null = null;

async function fetchCalendar() {
  if (cache && Date.now() - cache.at < 900000) return cache.data;
  try {
    const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
      headers: { "User-Agent": "SMC-Dashboard/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw: any[] = await res.json();
    const events = raw.map((r, i) => ({
      id: `live_${i}`, name: r.title, currency: r.country, country: r.country,
      impact: r.impact?.toLowerCase() === "high" ? "high" : r.impact?.toLowerCase() === "medium" ? "medium" : "low",
      scheduledTime: new Date(r.date).toISOString(),
      forecast: r.forecast || null, previous: r.previous || null, actual: r.actual || null,
      affectedPairs: CURRENCY_PAIRS[r.country] || [],
    }));
    cache = { data: events, at: Date.now() };
    return events;
  } catch {
    return cache?.data || [];
  }
}

function respond(data: any) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
