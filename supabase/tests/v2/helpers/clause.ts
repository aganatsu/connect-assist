// Every V2 test declares the spec clauses it covers; coverage.test.ts checks that every normative clause has one.
export function clause(ids: string[], name: string, fn: () => void | Promise<void>) {
  Deno.test(`[§${ids.join(" §")}] ${name}`, fn);
}
