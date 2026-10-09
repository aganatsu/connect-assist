/**
 * D1 / D2 / D3 — source-level pins (the database behaviour is tested in paperSettlementLedger.test.ts).
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url));
const paperTrading = read("../../functions/paper-trading/index.ts");
const d1 = read("../../migrations/20261009020000_d1_revoke_legacy_exposure_rpcs.sql");
const d2 = read("../../migrations/20261009030000_d2_d3_real_exposure_admission.sql");

Deno.test("place_order reports a refused insert instead of a manual trade that does not exist, before any broker mirror", () => {
  const start = paperTrading.indexOf('if (action === "place_order")');
  const block = paperTrading.slice(start, paperTrading.indexOf('if (action === "update_position")', start));
  assert(block.includes('const { error: insertErr } = await supabase.from("paper_positions").insert({'));
  const thrown = block.indexOf("if (insertErr) throw new Error(`Order refused: ${insertErr.message}`);");
  assert(thrown > 0, "the insert error is thrown");
  assert(thrown < block.indexOf("mirrorToMT5("), "thrown before the MT5 mirror");
});

Deno.test("no function calls the four legacy exposure RPCs that D1 closes", () => {
  const sources: string[] = [];
  for (const dir of Deno.readDirSync(new URL("../../functions/", import.meta.url))) {
    if (!dir.isDirectory) continue;
    for (const f of Deno.readDirSync(new URL(`../../functions/${dir.name}/`, import.meta.url))) {
      if (f.isFile && f.name.endsWith(".ts") && !f.name.includes(".test.")) sources.push(read(`../../functions/${dir.name}/${f.name}`));
    }
  }
  for (const fn of ["finalize_market_entry", "finalize_pending_order_fill", "finalize_live_broker_position", "retarget_pending_to_impulse_candidate"]) {
    assertEquals(sources.filter((s) => s.includes(fn)).length, 0, fn);
    assert(d1.includes(`REVOKE ALL ON FUNCTION public.${fn}(`) && d1.includes(`GRANT EXECUTE ON FUNCTION public.${fn}(`), fn);
  }
});

Deno.test("D2: pending_orders client writes revoked (SELECT kept); full-row trigger on pending_orders; INSERT-only trigger on paper_positions", () => {
  assert(d2.includes("REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.pending_orders FROM PUBLIC, anon, authenticated;"));
  assert(d2.includes("GRANT SELECT ON public.pending_orders TO anon, authenticated;"));
  assert(d2.includes("CREATE TRIGGER a_real_exposure_admission BEFORE INSERT OR UPDATE OR DELETE ON public.pending_orders"));
  assert(d2.includes("CREATE TRIGGER a_real_exposure_admission BEFORE INSERT ON public.paper_positions"));
  assert(!/(REVOKE|GRANT)[^;]*ON public\.paper_positions/i.test(d2), "no privilege change on paper_positions");
});

Deno.test("the UI's cancel-pending action writes through the service-role client (no client pending_orders writer exists)", () => {
  const scanner = read("../../functions/bot-scanner/index.ts");
  const i = scanner.indexOf('if (action === "cancel_pending")');
  assert(i > 0 && scanner.slice(i, i + 600).includes('await adminClient.from("pending_orders").update({'));
});
