// §OWN / §11.4 / §0.11: V2 isolation enforced on the import graph.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clause } from "./helpers/clause.ts";

const ROOT = new URL("../../functions/", import.meta.url).pathname;
const specs = (src: string) => [...src.matchAll(/(?:import|export)[^"']*from\s*["']([^"']+)["']/g)].map((m) => m[1]);
async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(p); else if (p.endsWith(".ts")) yield p;
  }
}

clause(["OWN", "11.4", "0.11", "AM3"], "v2/ imports only its own modules and smcAnalysis.calculateATR (no sessions.ts, no A decision logic)", async () => {
  const bad: string[] = [];
  for await (const f of walk(`${ROOT}_shared/v2`)) {
    const src = await Deno.readTextFile(f);
    for (const s of specs(src)) if (!(s.startsWith("./") || s === "../smcAnalysis.ts")) bad.push(`${f}: ${s}`);
    if (src.includes("../smcAnalysis.ts") && !/import \{ calculateATR \} from "\.\.\/smcAnalysis\.ts"/.test(src)) bad.push(`${f}: imports more than calculateATR`);
  }
  assertEquals(bad, []);
});

clause(["OWN", "12.1"], "the fidelity checker imports nothing outside v2check/", async () => {
  const bad: string[] = [];
  for await (const f of walk(`${ROOT}_shared/v2check`)) for (const s of specs(await Deno.readTextFile(f))) if (!s.startsWith("./")) bad.push(`${f}: ${s}`);
  assertEquals(bad, []);
});

clause(["OWN", "11.5"], "no production function imports v2/ or v2check/ (V2 is not wired into Baseline A)", async () => {
  const bad: string[] = [];
  for await (const f of walk(ROOT.replace(/\/$/, ""))) {
    if (f.includes("/_shared/v2/") || f.includes("/_shared/v2check/")) continue;
    for (const s of specs(await Deno.readTextFile(f))) if (/(^|\/)v2(check)?\//.test(s)) bad.push(`${f}: ${s}`);
  }
  assertEquals(bad, []);
});
