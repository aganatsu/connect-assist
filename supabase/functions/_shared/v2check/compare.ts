// Event-log comparison between the V2 engine and the independent checker: 100% agreement required.
export interface AnyEvent { t: number; pair: string; entity: string; id: string; event: string; data?: Record<string, unknown> }

const KEEP: Record<string, string[]> = {
  DIR: ["status", "bias"],
  TRADE: ["exitPrice", "gapDuring"],
  SETUP: ["entry", "sl", "tp", "lots"],
};

export function canonical(e: AnyEvent): string {
  const keys = KEEP[e.entity] ?? [];
  const d = keys.filter((k) => e.data && e.data[k] !== undefined).map((k) => `${k}=${e.data![k]}`).join(",");
  return `${e.t}|${e.pair}|${e.entity}|${e.id}|${e.event}${d ? `|${d}` : ""}`;
}

export interface Diff { onlyEngine: string[]; onlyChecker: string[]; agree: number }

export function compare(engine: AnyEvent[], checker: AnyEvent[]): Diff {
  const count = (xs: AnyEvent[]) => { const m = new Map<string, number>(); for (const x of xs) { const k = canonical(x); m.set(k, (m.get(k) ?? 0) + 1); } return m; };
  const a = count(engine), b = count(checker);
  const onlyEngine: string[] = [], onlyChecker: string[] = [];
  let agree = 0;
  for (const [k, n] of a) { const m = b.get(k) ?? 0; agree += Math.min(n, m); for (let i = m; i < n; i++) onlyEngine.push(k); }
  for (const [k, n] of b) { const m = a.get(k) ?? 0; for (let i = m; i < n; i++) onlyChecker.push(k); }
  onlyEngine.sort(); onlyChecker.sort();
  return { onlyEngine, onlyChecker, agree };
}
