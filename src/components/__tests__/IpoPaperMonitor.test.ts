import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const monitor = readFileSync("src/components/IpoPaperMonitor.tsx", "utf8");
const botView = readFileSync("src/pages/BotView.tsx", "utf8");
const readApi = readFileSync("supabase/functions/ipo-paper-state/index.ts", "utf8");

/**
 * Comments state what the component deliberately does NOT do, so a bare grep
 * fails on its own documentation. Only real code is searched.
 */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
   .replace(/(?<!:)\/\/.*$/gm, "");

describe("IPO paper monitor — read-only by construction", () => {
  it("cannot trade, mutate, or reach a broker", () => {
    for (const banned of ["broker-execute", "placeOrder", "closePosition", "onClick={() => paperApi",
                          "paperApi.", ".insert(", ".update(", ".delete(", ".upsert("]) {
      expect(monitor).not.toContain(banned);
    }
    // Exactly one endpoint, and it is the read one.
    const invokes = [...monitor.matchAll(/functions\.invoke\("([^"]+)"/g)].map((m) => m[1]);
    expect(invokes).toEqual(["ipo-paper-state"]);
  });

  it("never queries an SMC table directly", () => {
    for (const t of ["paper_positions", "paper_trade_history", "pending_orders",
                     "paper_accounts", "bot_setups"]) {
      // IPO's own tables are reached through the edge function, never by name here.
      expect(monitor.replace(/ipo_[a-z_]+/g, "")).not.toContain(t);
    }
    expect(monitor).not.toContain('.from("');
  });
});

describe("it shows what the forward test needs to be monitored", () => {
  it("leads with the heartbeat, because quiet runs write nothing", () => {
    expect(monitor).toContain("Runner health");
    for (const f of ["lastRunAt", "lastSuccessAt", "consecutiveFailures", "lastStatus",
                     "durationMs", "instrumentsChecked", "barsProcessed", "eventsEmitted"]) {
      expect(monitor).toContain(f);
    }
    // Staleness has to be surfaced, or a stopped scheduler looks like a quiet one.
    expect(monitor).toContain("healthStale");
    expect(monitor).toContain("STALE");
  });

  it("surfaces the repeated-zone telemetry", () => {
    for (const f of ["zone_entry_ordinal", "zone_previous_exit_time",
                     "ipo_candle_time", "volatility_bucket"]) {
      expect(monitor).toContain(f);
    }
    expect(monitor).toContain("RE-ENTRY #");
  });

  it("shows realized R and P&L, with R as the primary", () => {
    expect(monitor).toContain("realized_r");
    expect(monitor).toContain("realized_pnl_usd");
    expect(monitor).toContain("exit_reason");
    // The dollar figure must be labelled as derived, not as a risk limit.
    expect(monitor).toContain("NOT a maximum loss");
  });

  it("shows costR and the execution block reason on refusals", () => {
    expect(monitor).toContain("costR");
    expect(monitor).toContain("blockReason");
    // Both verdicts, never collapsed.
    expect(monitor).toContain("strategy_decision");
    expect(monitor).toContain("account_decision");
  });

  it("shows gap state on an open position", () => {
    expect(monitor).toContain("data_gap_suspended");
    expect(monitor).toContain("gap_reason");
  });

  it("shows per-instrument state and says the cursors are independent", () => {
    expect(monitor).toContain("cursorBarTime");
    expect(monitor).toContain("not synchronised");
  });
});

describe("IPO and SMC stay separated", () => {
  it("lives under the IPO tab, not in the SMC tree", () => {
    expect(botView).toContain("IpoPaperMonitor");
    const ipoTab = botView.slice(botView.indexOf('<TabsContent value="ipo"'));
    expect(ipoTab).toContain("<IpoPaperMonitor />");
    expect(ipoTab).toContain("<IpoScanner />");
    // The SMC content must not mention it.
    const smcTab = botView.slice(botView.indexOf('<TabsContent value="smc"'),
                                 botView.indexOf('<TabsContent value="ipo"'));
    expect(smcTab).not.toContain("IpoPaperMonitor");
  });

  it("does not merge IPO results into the SMC Journal or analytics", () => {
    // The Journal reads `trades`; nothing in the monitor may feed it. Checked on
    // code only — the header explicitly documents the separation in prose.
    const src = code(monitor);
    expect(src).not.toContain('"trades"');
    expect(src).not.toContain("Journal");
    expect(botView.slice(botView.indexOf("function ScanDetailInline")).toLowerCase())
      .not.toContain("ipopaper");
  });

  it("keeps the SMC surface intact", () => {
    for (const anchor of ["<AppShell>", "ScanDetailInline", "SignalStatusPanel", "BotConfigModal"]) {
      expect(botView).toContain(anchor);
    }
  });
});

describe("the read endpoint stays read-only while serving health", () => {
  it("returns the heartbeat without loading engine state", () => {
    expect(readApi).toContain("ipo_runner_health:%");
    // ~330KB per instrument; a monitoring view must not pull bar history.
    expect(readApi).not.toContain("ipo_engine_state");
    expect(readApi).toContain("healthStale");
  });

  it("still performs no write of any kind", () => {
    for (const verb of [".insert(", ".upsert(", ".update(", ".delete("]) {
      expect(readApi).not.toContain(verb);
    }
  });
});
