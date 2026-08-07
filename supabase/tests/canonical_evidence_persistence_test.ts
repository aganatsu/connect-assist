const source = await Deno.readTextFile(new URL("../functions/bot-scanner/index.ts", import.meta.url));

Deno.test("scanner persists canonical workflow and structure evidence across outcome routes", () => {
  if (!source.includes("function canonicalEvidenceSnapshot")) throw new Error("missing canonical evidence snapshot helper");
  for (const field of ["canonicalScannerState", "canonicalStructureAuthority", "canonicalLiquiditySequence", "canonicalStructureDecision", "canonicalStructureEnforcement"]) {
    if (!source.includes(`${field}: detail.${field} || null`)) throw new Error(`missing ${field}`);
  }
  const uses = source.match(/\.\.\.canonicalEvidenceSnapshot\(detail\)/g) || [];
  if (uses.length < 5) throw new Error(`expected persistence across at least 5 routes, found ${uses.length}`);
});
