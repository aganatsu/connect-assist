import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, root));

Deno.test("single-ownership comparison is exposed in Rejected Setups", async () => {
  const [endpoint, api, rejectedSetups, scanTab] = await Promise.all([
    read("supabase/functions/bot-config/index.ts"),
    read("src/lib/api.ts"),
    read("src/pages/RejectedSetups.tsx"),
    read("src/components/config/ScanTab.tsx"),
  ]);

  assertStringIncludes(endpoint, 'action === "single_ownership.comparison"');
  assertStringIncludes(endpoint, 'from("paper_trade_history")');
  assertStringIncludes(endpoint, 'from("rejected_setups")');
  assertStringIncludes(api, "getSingleOwnershipComparison");
  assertStringIncludes(rejectedSetups, "Trade Decision Comparison");
  assert(!scanTab.includes("Trade Decision Comparison"));
});
