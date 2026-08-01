export interface EvidenceTimeframes {
  roles?: Partial<Record<
    "bias" | "structure" | "setup" | "confirmation" | "refinement",
    string
  >>;
  runtimeHTF?: string;
  runtimeEntry?: string;
}

const TIMEFRAME_ROLE_ORDER = [
  ["bias", "Bias"],
  ["structure", "Structure"],
  ["setup", "Setup"],
  ["confirmation", "Confirmation"],
  ["refinement", "Refinement"],
] as const;

export function formatTimeframeLadder(
  timeframes: EvidenceTimeframes | null | undefined,
): string {
  if (!timeframes) return "";
  const roleSteps = TIMEFRAME_ROLE_ORDER.flatMap(([key, label]) => {
    const timeframe = timeframes.roles?.[key];
    return timeframe ? [`${label} ${timeframe}`] : [];
  });
  const runtimeSteps = [
    timeframes.runtimeHTF ? `Runtime HTF ${timeframes.runtimeHTF}` : null,
    timeframes.runtimeEntry ? `Runtime entry ${timeframes.runtimeEntry}` : null,
  ].filter((step): step is string => Boolean(step));
  return [...roleSteps, ...runtimeSteps].join(" → ");
}
