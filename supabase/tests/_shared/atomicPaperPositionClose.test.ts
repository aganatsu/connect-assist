import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { finalizePaperPositionClose } from "../../functions/_shared/finalizePaperPositionClose.ts";

const migrationUrl = new URL(
  "../../migrations/20260817110000_atomic_paper_position_close.sql",
  import.meta.url,
);

Deno.test("paper close migration locks once and commits ledger changes together", async () => {
  const sql = await Deno.readTextFile(migrationUrl.pathname);
  assertStringIncludes(sql, "FROM public.paper_positions");
  assertStringIncludes(sql, "FOR UPDATE");
  assertStringIncludes(sql, "INSERT INTO public.paper_trade_history");
  assertStringIncludes(sql, "UPDATE public.paper_accounts");
  assertStringIncludes(sql, "DELETE FROM public.paper_positions");
  assertStringIncludes(sql, "idx_paper_trade_history_source_position");
  assertStringIncludes(sql, "idx_paper_trade_history_final_lifecycle");
  assertStringIncludes(sql, "WHEN unique_violation");
  assertStringIncludes(sql, "auth.uid() IS DISTINCT FROM p_user_id");
  assertStringIncludes(sql, "TO authenticated, service_role");
});

Deno.test("paper close migration reconciles legacy duplicate P&L but excludes partial closes", async () => {
  const sql = await Deno.readTextFile(migrationUrl.pathname);
  assertStringIncludes(sql, "paper_trade_history_duplicate_audit");
  assertStringIncludes(sql, "h.close_reason <> 'partial_tp'");
  assertStringIncludes(sql, "SET balance = a.balance - d.duplicated_pnl");
  assertStringIncludes(sql, "DELETE FROM public.paper_trade_history h");
  assertStringIncludes(sql, "sum(COALESCE(pnl, 0))");
});

Deno.test("paper close helper maps one finalization request to the atomic RPC", async () => {
  let rpcName = "";
  let rpcArgs: Record<string, unknown> = {};
  const supabase = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcName = name;
      rpcArgs = args;
      return Promise.resolve({
        data: {
          closed: true,
          code: "closed",
          balance: 98_877,
          peak_balance: 100_000,
        },
        error: null,
      });
    },
  };

  const result = await finalizePaperPositionClose(supabase, {
    positionRowId: "position-row",
    userId: "user-id",
    botId: "smc",
    exitPrice: 1.15979,
    pnl: -1123,
    pnlPips: -78.5,
    closeReason: "sl_hit",
    closedAt: "2026-08-17T07:10:33.000Z",
  });

  assertEquals(rpcName, "finalize_paper_position_close");
  assertEquals(rpcArgs.p_position_row_id, "position-row");
  assertEquals(rpcArgs.p_pnl, -1123);
  assertEquals(result.closed, true);
  assertEquals(result.balance, 98_877);
});

Deno.test("paper close helper rejects invalid close data before touching storage", async () => {
  await assertRejects(
    () =>
      finalizePaperPositionClose({ rpc: () => Promise.resolve({}) }, {
        positionRowId: "position-row",
        userId: "user-id",
        botId: "smc",
        exitPrice: 0,
        pnl: -1123,
        pnlPips: -78.5,
        closeReason: "sl_hit",
      }),
    Error,
    "exit price must be positive",
  );
});

Deno.test("every full-close caller delegates to the atomic finalizer", async () => {
  const root = new URL("../../functions/", import.meta.url);
  const paper = await Deno.readTextFile(
    new URL("paper-trading/index.ts", root).pathname,
  );
  const scanner = await Deno.readTextFile(
    new URL("bot-scanner/index.ts", root).pathname,
  );
  const propFirm = await Deno.readTextFile(
    new URL("_shared/propFirmGate.ts", root).pathname,
  );

  assertStringIncludes(paper, "finalizePaperPositionClose(serviceSupabase");
  assertStringIncludes(scanner, "finalizePaperPositionClose(supabase");
  assertStringIncludes(propFirm, "finalizePaperPositionClose(supabase");
  assertStringIncludes(paper, "if (!finalization.closed)");
  assertStringIncludes(scanner, "if (!finalization.closed)");
  assertStringIncludes(propFirm, "if (!finalization.closed)");
  assertEquals(paper.includes('.from("paper_trade_history").insert'), false);
  assertEquals(scanner.includes('.from("paper_trade_history").insert'), false);
  assertEquals(propFirm.includes('.from("paper_trade_history").insert'), false);
});
