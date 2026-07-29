export interface ActiveGamePlanDisplayRow {
  id: string;
  plan_version: string;
  symbol: string;
  session: string;
  bias: string;
  bias_confidence: number | string;
  v2_conviction?: Record<string, unknown> | null;
  state: "tradeable" | "wait" | "skip";
  state_reason?: string | null;
  generated_at: string;
  expires_at: string;
  invalidation_conditions?: string[] | null;
  source_candle_timestamps?: Record<string, string | null> | null;
  plan_json: Record<string, any>;
  focus_pairs?: string[] | null;
  news_events?: unknown[] | null;
  news_impacts?: unknown[] | null;
  summary?: string | null;
  generation_source: "automatic_scan" | "manual_refresh";
  contract_version?: string | null;
  is_active: boolean;
}

export interface GamePlanDisplayLog {
  id: string;
  scanned_at: string;
  details_json: {
    type: "game_plan";
    plan_version: string;
    source: "automatic_scan" | "manual_refresh";
    contract_version: string;
    session: string;
    generated_at: string;
    focus_pairs: string[];
    plans: any[];
    newsEvents: any[];
    newsImpacts: any[];
    summary: string;
  };
}

export function activeGamePlanRowsToLogs(
  rows: ActiveGamePlanDisplayRow[],
  maximumVersions = 10,
): GamePlanDisplayLog[] {
  const groups = new Map<string, ActiveGamePlanDisplayRow[]>();
  for (const row of rows) {
    const group = groups.get(row.plan_version) || [];
    group.push(row);
    groups.set(row.plan_version, group);
  }

  return [...groups.values()]
    .sort((a, b) =>
      new Date(b[0].generated_at).getTime() -
      new Date(a[0].generated_at).getTime()
    )
    .slice(0, maximumVersions)
    .map((versionRows) => {
      const first = versionRows[0];
      return {
        id: first.plan_version,
        scanned_at: first.generated_at,
        details_json: {
          type: "game_plan",
          plan_version: first.plan_version,
          source: first.generation_source,
          contract_version: first.contract_version || "phase3.v1",
          session: first.session,
          generated_at: first.generated_at,
          focus_pairs: first.focus_pairs || [],
          plans: versionRows
            .sort((a, b) => a.symbol.localeCompare(b.symbol))
            .map((row) => ({
              ...(row.plan_json || {}),
              gamePlanId: row.id,
              planVersion: row.plan_version,
              symbol: row.symbol,
              bias: row.bias,
              biasConfidence: Number(row.bias_confidence) || 0,
              conviction: row.v2_conviction ||
                row.plan_json?.conviction,
              state: row.state,
              stateReason: row.state_reason ||
                row.plan_json?.stateReason,
              generatedAt: row.generated_at,
              expiresAt: row.expires_at,
              invalidationConditions: row.invalidation_conditions ||
                row.plan_json?.invalidationConditions ||
                [],
              sourceCandleTimestamps: row.source_candle_timestamps ||
                row.plan_json?.sourceCandleTimestamps,
            })),
          newsEvents: first.news_events || [],
          newsImpacts: first.news_impacts || [],
          summary: first.summary || "",
        },
      };
    });
}
