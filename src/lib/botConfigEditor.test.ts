import { describe, expect, it } from "vitest";
import { normalizeBotConfigForEditor } from "./botConfigEditor";

describe("normalizeBotConfigForEditor", () => {
  it("loads legacy scanner aliases into visible canonical controls", () => {
    const result = normalizeBotConfigForEditor({
      strategy: {
        enableLiquiditySweep: false,
        useStructureBreak: false,
        useDisplacement: false,
        structuralConvictionGate: false,
      },
      instruments: {
        allowedInstruments: { "EUR/USD": true, "GBP/USD": false },
        volatilityFilterEnabled: true,
        minATR: 7,
        maxATR: 45,
      },
      sessions: { newsFilterPauseMinutes: 40 },
    });

    expect(result.strategy.enableLiquidity).toBe(false);
    expect(result.strategy.enableStructure).toBe(false);
    expect(result.strategy.enableDisplacement).toBe(false);
    expect(result.strategy.structuralConvictionEnabled).toBe(false);
    expect(result.instruments.enabled).toEqual(["EUR/USD"]);
    expect(result.instruments.atrFilterEnabled).toBe(true);
    expect(result.instruments.atrFilterMinPips).toBe(7);
    expect(result.instruments.atrFilterMaxPips).toBe(45);
    expect(result.sessions.newsBufferMinutes).toBe(40);
  });

  it("normalizes preset management and method aliases for the editor", () => {
    const result = normalizeBotConfigForEditor({
      exit: { slMethod: "atr", tpMethod: "rr" },
      management: {
        breakEvenEnabled: true,
        breakEvenTriggerPips: 12,
      },
      openingRange: { judasSwing: false, keyLevels: false },
      smcEnhancements: { enableFib3PointTP: true },
    });

    expect(result.exit.stopLossMethod).toBe("atr_based");
    expect(result.exit.takeProfitMethod).toBe("rr_ratio");
    expect(result.exit.breakEvenEnabled).toBe(true);
    expect(result.exit.breakEvenTriggerPips).toBe(12);
    expect(result.openingRange.useJudasSwing).toBe(false);
    expect(result.openingRange.useKeyLevels).toBe(false);
    expect(result.smcEnhancements.enableFibExtension3Point).toBe(true);
  });
});
