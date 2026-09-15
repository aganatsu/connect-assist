/**
 * What is actually acting on your trades, and what is only being watched.
 *
 * This codebase keeps producing the same bug: a feature that computes a result
 * nothing consumes. The Tier 1 gate was disabled in config while every panel
 * implied it was live. ictDisplacementMSS still grades every MSS and throws the
 * grade away. priceAwareStructureBlocks contains the fix for retracement blocks
 * and is switched off. A reader had no way to tell any of that.
 *
 * The important distinction is NOT enabled/disabled. It is:
 *
 *   Enabled: true + GateMode: "off"  ->  runs, result ignored
 *
 * which reads as "on" everywhere else in the UI.
 *
 * Status is derived from the live bot config, never from a list of claims. The
 * only hand-written part is the label and the plain-English description; if a
 * key here stops existing, signalRegistry.test.ts fails rather than this panel
 * silently reporting a stale truth.
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  config: Record<string, any> | null | undefined;
}

type Status = "rejects" | "scores" | "ignored" | "off" | "observed" | "unknown";

interface Signal {
  label: string;
  what: string;
  /** Config key that decides whether it runs at all. */
  enabledKey?: string;
  /** Config key that decides whether the result is acted on. */
  gateKey?: string;
  /** No config key — measured in code and deliberately not wired to anything. */
  observationalOnly?: boolean;
  /** What would make it worth acting on. */
  waitingFor?: string;
}

/**
 * Keys live under config_json.strategy for the most part, with some at the
 * root. Resolution mirrors configMapper: strategy first, then raw.
 */
function readKey(config: Record<string, any> | null | undefined, key: string): unknown {
  if (!config) return undefined;
  return config?.strategy?.[key] ?? config?.[key];
}

export const SIGNALS: Signal[] = [
  {
    label: "Impulse zone",
    what: "Requires price to be inside a zone built from an impulse leg.",
    enabledKey: "impulseZoneEnabled",
    gateKey: "impulseZoneGateMode",
  },
  {
    label: "Game Plan bias",
    what: "Refuses setups that trade against the session's directional plan.",
    gateKey: "gamePlanGateMode",
  },
  {
    label: "ICT displacement MSS",
    what: "Grades the market-structure shift as strong, moderate, weak or none.",
    enabledKey: "ictDisplacementMSSEnabled",
    gateKey: "ictDisplacementMSSGateMode",
    waitingFor: "Whether MSS without displacement actually loses more.",
  },
  {
    label: "ICT Judas swing",
    what: "Looks for a liquidity sweep before the structure shift.",
    enabledKey: "ictJudasSwingEnabled",
    gateKey: "ictJudasSwingGateMode",
  },
  {
    label: "ICT FVG invalidation",
    what: "Checks whether the fair value gaps have already been filled.",
    enabledKey: "ictFVGInvalidationEnabled",
    gateKey: "ictFVGInvalidationGateMode",
  },
  {
    label: "ICT higher timeframe",
    what: "Checks alignment with the timeframe above.",
    enabledKey: "ictHTFEnabled",
    gateKey: "ictHTFGateMode",
  },
  {
    label: "ICT kill zone",
    what: "Restricts entries to the session windows.",
    enabledKey: "ictKillZoneEnabled",
    gateKey: "ictKillZoneGateMode",
  },
  {
    label: "Retracement-aware blocks",
    what:
      "Waives the “structure trend opposes bias” block when the move is a healthy " +
      "pullback. With this off, a retracement into your zone is refused the same way a " +
      "reversal is.",
    enabledKey: "priceAwareStructureBlocks",
    waitingFor: "How many refused setups were pullbacks, not reversals.",
  },
  {
    label: "Thesis validation",
    what: "Re-checks the original reason for the trade while it is open.",
    enabledKey: "thesisValidationEnabled",
  },
  {
    label: "Structure invalidation",
    what: "Closes a position when the structure it relied on breaks.",
    enabledKey: "structureInvalidationEnabled",
  },
  {
    label: "Correlation filter",
    what: "Blocks a second trade in a correlated pair.",
    enabledKey: "correlationFilterEnabled",
  },
  {
    label: "News filter",
    what: "Avoids entries around scheduled high-impact releases.",
    enabledKey: "newsFilterEnabled",
  },
  {
    label: "Spread filter",
    what: "Refuses entries when the spread is unusually wide.",
    enabledKey: "spreadFilterEnabled",
  },
  // ── Measured in code, wired to nothing ──
  {
    label: "Impulse leg displacement",
    what:
      "How forcefully the leg moved rather than how far — body ratio, range multiple, " +
      "and how many bars qualified as displacement.",
    observationalOnly: true,
    waitingFor: "Whether low-displacement legs underperform.",
  },
  {
    label: "Origin / BOS candle closes",
    what:
      "Where the two candles defining the leg closed in their own range. A break that " +
      "closed back near its open is a failed break on the timeframe below.",
    observationalOnly: true,
    waitingFor: "Whether rejected break candles predict failure.",
  },
  {
    label: "Impulse leg sequence",
    what:
      "Whether this leg continues the prior one or is the first after an opposing " +
      "break, how many older legs were already invalidated, and whether displacement " +
      "is decaying across successive legs.",
    observationalOnly: true,
    waitingFor: "Whether first-after-reversal legs underperform continuations.",
  },
  {
    label: "Blocked retracements",
    what:
      "Counts setups the trend gate refused while the retracement check called them a " +
      "healthy pullback.",
    observationalOnly: true,
    waitingFor: "The count. If most refusals are pullbacks, the gate is too blunt.",
  },
];

export function signalStatus(s: Signal, config: Props["config"]): Status {
  if (s.observationalOnly) return "observed";

  const enabled = s.enabledKey === undefined ? true : readKey(config, s.enabledKey);
  const gate = s.gateKey === undefined ? undefined : readKey(config, s.gateKey);

  if (s.enabledKey !== undefined && enabled === undefined && s.gateKey === undefined) {
    return "unknown";
  }
  if (enabled === false) return "off";

  if (s.gateKey !== undefined) {
    if (gate === undefined) return "unknown";
    if (gate === "hard") return "rejects";
    if (gate === "soft") return "scores";
    return "ignored";          // runs, result discarded
  }
  return enabled === true ? "rejects" : "off";
}

const GROUPS: { status: Status; title: string; blurb: string; tone: string }[] = [
  {
    status: "rejects", title: "Can refuse a trade", tone: "text-red-400",
    blurb: "A setup failing any of these is rejected outright.",
  },
  {
    status: "scores", title: "Affects the score only", tone: "text-yellow-400",
    blurb: "Moves the confluence score. Cannot reject on its own.",
  },
  {
    status: "ignored", title: "Runs, then the result is thrown away", tone: "text-orange-400",
    blurb: "The analysis happens every scan and nothing reads it. This is the one that looks like it is working.",
  },
  {
    status: "observed", title: "Measured for later, wired to nothing", tone: "text-cyan-400",
    blurb: "Recorded so a decision can be made from data instead of theory.",
  },
  {
    status: "off", title: "Switched off", tone: "text-zinc-500",
    blurb: "Not computed at all.",
  },
  {
    status: "unknown", title: "Not set in this config", tone: "text-zinc-600",
    blurb: "No value found, so the code default applies. Worth setting explicitly.",
  },
];

export function SignalStatusPanel({ config }: Props) {
  const byStatus = (st: Status) => SIGNALS.filter(s => signalStatus(s, config) === st);

  // How many trades actually carry the measurement. The copy used to say
  // "after ~40 trades", borrowed from the Era C freeze — which has since ended
  // at 65 trades, none of which carry it, because measurement began later.
  // A tab built to expose unchecked claims should not make one.
  const { data: measuredTrades } = useQuery({
    queryKey: ["leg-displacement-sample"],
    queryFn: async () => {
      const { count } = await supabase
        .from("trade_reasonings")
        .select("id", { count: "exact", head: true })
        .not("leg_displacement", "is", null);
      return count ?? 0;
    },
    staleTime: 60_000,
  });

  return (
    <div className="p-2 space-y-4 text-[11px]">
      <p className="text-zinc-400 leading-relaxed">
        Grouped by what each signal actually does to a trade, read from the live bot
        config — not from a list of claims. A feature can be{" "}
        <span className="text-zinc-200">enabled</span> and still have its result ignored;
        those appear under{" "}
        <span className="text-orange-400">Runs, then the result is thrown away</span>.
      </p>

      {measuredTrades !== undefined && (
        <p className="text-zinc-500 leading-relaxed">
          Trades carrying the leg measurements so far:{" "}
          <span className={measuredTrades === 0 ? "text-zinc-400" : "text-cyan-400"}>
            {measuredTrades}
          </span>
          {measuredTrades === 0 && " — recording began after the last trade closed, so nothing is answerable yet."}
        </p>
      )}

      {GROUPS.map(g => {
        const items = byStatus(g.status);
        if (items.length === 0) return null;
        return (
          <div key={g.status}>
            <div className="flex items-baseline gap-2 border-b border-zinc-800 pb-1 mb-1.5">
              <span className={`font-semibold uppercase tracking-wider ${g.tone}`}>
                {g.title}
              </span>
              <span className="text-zinc-600">{items.length}</span>
            </div>
            <p className="text-zinc-500 mb-2 leading-relaxed">{g.blurb}</p>
            <div className="space-y-2">
              {items.map(s => (
                <div key={s.label} className="pl-2 border-l border-zinc-800">
                  <div className="text-zinc-200 font-medium">{s.label}</div>
                  <div className="text-zinc-400 leading-relaxed">{s.what}</div>
                  {s.waitingFor && (
                    <div className="text-zinc-500 mt-0.5">
                      <span className="text-zinc-600">Waiting on: </span>{s.waitingFor}
                    </div>
                  )}
                  <div className="text-zinc-700 font-mono text-[9px] mt-0.5">
                    {[s.enabledKey, s.gateKey].filter(Boolean).join(" · ") || "no config key"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
