import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOT_CONFIG_SEARCH_CATALOG,
  searchBotConfigSettings,
  type BotConfigTabId,
} from "./botConfigSearch";

const tabFiles: Record<BotConfigTabId, string> = {
  scan: resolve("src/components/config/ScanTab.tsx"),
  enter: resolve("src/components/config/EnterTab.tsx"),
  exit: resolve("src/components/config/ExitTab.tsx"),
  risk: resolve("src/components/config/RiskTab.tsx"),
};

function literalSearchLabels(source: string): string[] {
  const pattern =
    /<(?:FieldGroup|ToggleField)\b[^>]*?label="([^"]+)"|<CollapsibleSection\b[^>]*?title="([^"]+)"|<Label\b[^>]*>([^<{][^<]*)</gs;
  return [...source.matchAll(pattern)].map((match) =>
    (match[1] ?? match[2] ?? match[3]).trim(),
  );
}

function propertyValues(
  source: string,
  startMarker: string,
  endMarker: string,
  property: "label" | "name",
): string[] {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  const block = source.slice(start, end);
  const pattern = new RegExp(`${property}: ["']([^"']+)["']`, "g");
  return [...block.matchAll(pattern)].map((match) => match[1]);
}

function resultPairs(query: string): string[] {
  return searchBotConfigSettings(query).map(
    (entry) => `${entry.tab}:${entry.label}`,
  );
}

describe("Bot Config search catalog", () => {
  it("indexes every rendered standard control under its real tab", () => {
    for (const [tab, file] of Object.entries(tabFiles) as [
      BotConfigTabId,
      string,
    ][]) {
      const source = readFileSync(file, "utf8");
      const missing = literalSearchLabels(source).filter(
        (label) =>
          !BOT_CONFIG_SEARCH_CATALOG.some(
            (entry) => entry.tab === tab && entry.label === label,
          ),
      );

      expect(missing, `${tab} search catalog drift`).toEqual([]);
    }
  });

  it("has no duplicate entries within a tab", () => {
    const keys = BOT_CONFIG_SEARCH_CATALOG.map(
      (entry) => `${entry.tab}:${entry.label.toLowerCase()}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("indexes dynamic module, factor, and override controls", () => {
    const scanSource = readFileSync(tabFiles.scan, "utf8");
    const enterSource = readFileSync(tabFiles.enter, "utf8");
    const dynamicLabels: [BotConfigTabId, string][] = [
      ...propertyValues(
        scanSource,
        "const ICT2022_MODULES",
        "const SMC_ENHANCEMENT_MODULES",
        "label",
      ).map((label) => ["scan", label] as [BotConfigTabId, string]),
      ...propertyValues(
        scanSource,
        "const SMC_ENHANCEMENT_MODULES",
        "// ─── Component",
        "label",
      ).map((label) => ["scan", label] as [BotConfigTabId, string]),
      ...propertyValues(
        enterSource,
        "const FACTOR_WEIGHT_DEFS",
        "const TIER_META",
        "name",
      ).map((label) => ["enter", label] as [BotConfigTabId, string]),
      ...propertyValues(
        enterSource,
        "const OVERRIDE_FIELDS",
        "] as const",
        "label",
      ).map((label) => ["enter", label] as [BotConfigTabId, string]),
    ];

    const missing = dynamicLabels.filter(
      ([tab, label]) =>
        !BOT_CONFIG_SEARCH_CATALOG.some(
          (entry) => entry.tab === tab && entry.label === label,
        ),
    );
    expect(missing).toEqual([]);
  });

  it("routes the liquidity-sweep requirement to ENTER, not SCAN", () => {
    const results = resultPairs("require liquidity sweep");
    expect(results).toContain("enter:Require Liquidity Sweep");
    expect(results).not.toContain("scan:Require Liquidity Sweep");
  });

  it.each([
    ["scan interval", "scan:Scan Interval (minutes)"],
    ["direction verdict", "scan:HTF Bias"],
    ["thesis validation", "enter:Setup Thesis Validity"],
    ["break even", "exit:Auto Break-Even"],
    ["position sizing", "risk:Position Sizing"],
    ["starting balance", "risk:Starting Balance ($)"],
  ])("finds %s in the correct tab", (query, expected) => {
    expect(resultPairs(query)).toContain(expected);
  });

  it.each([
    ["auto scan interval", "scan:Scan Interval (minutes)"],
    ["news filter", "scan:News Event Filter"],
    ["normalized scoring", "enter:Score Normalization"],
    ["fixed sl pips", "exit:Fixed SL (pips)"],
    ["same direction stacking", "risk:Allow Same-Direction Stacking"],
  ])("keeps the old search phrase %s working", (query, expected) => {
    expect(resultPairs(query)).toContain(expected);
  });
});
