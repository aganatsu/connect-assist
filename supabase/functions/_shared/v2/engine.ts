// V2 pure engine entry points. No I/O, no clock, no database: inputs in, event log out.
export { runEngine } from "./v2Lifecycle.ts";
export type { ClosedTrade, EngineInput, EngineResult, Schedule, V2Event } from "./v2Lifecycle.ts";
import { runEngine } from "./v2Lifecycle.ts";
import type { Dataset } from "./barStore.ts";

/** Phase 3 replay (§12.1): news not replayed (§8.4), every decision time TRADABLE (§12.1f); warm-up before `measuredStart` (§0.12). */
export function runReplay(dataset: Dataset, measuredStart?: number) {
  return runEngine({ dataset, news: "REPLAY", measuredStart });
}
