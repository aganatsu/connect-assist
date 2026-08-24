/**
 * Converts saved Bot Config aliases into the nested shape shown by the editor.
 *
 * The runtime still accepts legacy keys for backwards compatibility, but the UI
 * should always display and save the canonical field names.
 */
export function normalizeBotConfigForEditor(rawConfig: any): any {
  const parsed = JSON.parse(JSON.stringify(rawConfig ?? {}));

  parsed.strategy = { ...(parsed.strategy || {}) };
  parsed.entry = { ...(parsed.entry || {}) };
  parsed.instruments = { ...(parsed.instruments || {}) };
  parsed.sessions = { ...(parsed.sessions || {}) };
  parsed.openingRange = { ...(parsed.openingRange || {}) };
  parsed.exit = { ...(parsed.management || {}), ...(parsed.exit || {}) };
  parsed.smcEnhancements = parsed.smcEnhancements
    ? { ...parsed.smcEnhancements }
    : parsed.smcEnhancements;

  if (parsed.instruments.allowedInstruments && !parsed.instruments.enabled) {
    const allowed = parsed.instruments.allowedInstruments;
    parsed.instruments.enabled = Object.keys(allowed).filter(
      (symbol) => allowed[symbol],
    );
    delete parsed.instruments.allowedInstruments;
  }

  const strategyAliases: Record<string, string[]> = {
    enableLiquidity: ["useLiquiditySweep", "enableLiquiditySweep"],
    enableStructure: ["useStructureBreak", "enableBOS"],
    enableDisplacement: ["useDisplacement"],
    enableBreaker: ["useBreakerBlocks"],
    enableUnicorn: ["useUnicornModel"],
    enableSMT: ["useSMT"],
    enableVolumeProfile: ["useVolumeProfile"],
    enableDailyBias: ["useDailyBias"],
    enableAMD: ["useAMD"],
    enableFOTSI: ["useFOTSI"],
    structuralConvictionEnabled: ["structuralConvictionGate"],
    htfBiasRequired: ["requireHTFBias"],
  };

  for (const [canonical, aliases] of Object.entries(strategyAliases)) {
    if (parsed.strategy[canonical] !== undefined) continue;
    const alias = aliases.find((key) => parsed.strategy[key] !== undefined);
    if (alias) parsed.strategy[canonical] = parsed.strategy[alias];
  }

  parsed.instruments.atrFilterEnabled ??=
    parsed.instruments.volatilityFilterEnabled;
  parsed.instruments.atrFilterMinPips ??= parsed.instruments.minATR;
  parsed.instruments.atrFilterMaxPips ??= parsed.instruments.maxATR;
  parsed.sessions.newsBufferMinutes ??=
    parsed.sessions.newsFilterPauseMinutes;

  parsed.openingRange.useJudasSwing ??= parsed.openingRange.judasSwing;
  parsed.openingRange.useKeyLevels ??= parsed.openingRange.keyLevels;

  const nestedPoiMode = parsed.entry.nestedPoiMarketMode ??
    parsed.nestedPoiMarketMode;
  parsed.entry.nestedPoiMarketMode = [
      "observe",
      "enforce_paper",
      "enforce_live",
    ].includes(nestedPoiMode)
    ? nestedPoiMode
    : "off";

  if (parsed.exit.stopLossMethod === undefined) {
    parsed.exit.stopLossMethod = parsed.exit.slMethod;
  }
  if (parsed.exit.takeProfitMethod === undefined) {
    parsed.exit.takeProfitMethod = parsed.exit.tpMethod;
  }
  if (parsed.exit.stopLossMethod === "atr") {
    parsed.exit.stopLossMethod = "atr_based";
  } else if (parsed.exit.stopLossMethod === "fixed") {
    parsed.exit.stopLossMethod = "fixed_pips";
  }
  if (parsed.exit.takeProfitMethod === "rr") {
    parsed.exit.takeProfitMethod = "rr_ratio";
  } else if (parsed.exit.takeProfitMethod === "atr") {
    parsed.exit.takeProfitMethod = "atr_multiple";
  } else if (parsed.exit.takeProfitMethod === "fixed") {
    parsed.exit.takeProfitMethod = "fixed_pips";
  }

  if (parsed.smcEnhancements) {
    parsed.smcEnhancements.enableFibExtension3Point ??=
      parsed.smcEnhancements.enableFib3PointTP;
  }

  const legacyGPThreshold =
    parsed.gamePlan?.hardBlockThreshold ??
    parsed.strategy?.gpHardBlockThreshold ??
    parsed.gpHardBlockThreshold ??
    75;
  parsed.gamePlan = {
    ...(parsed.gamePlan || {}),
    enabled: parsed.gamePlan?.enabled ?? false,
    enforcementMode:
      parsed.gamePlan?.enforcementMode ??
      parsed.strategy?.gpEnforcementMode ??
      parsed.gpEnforcementMode ??
      (legacyGPThreshold === 0 ? "off" : "hard"),
    hardBlockThreshold: legacyGPThreshold === 0 ? 75 : legacyGPThreshold,
  };

  return parsed;
}
