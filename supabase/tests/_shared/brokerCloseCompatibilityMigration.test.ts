import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migrationUrl = new URL(
  "../../migrations/20260823120000_add_broker_close_compatibility_foundation.sql",
  import.meta.url,
);
const marketEntryOwnerUrl = new URL(
  "../../migrations/20260728212203_315c8ec5-26d1-4051-9c1b-13ce0bf5386f.sql",
  import.meta.url,
);
const pendingFillOwnerUrl = new URL(
  "../../migrations/20260813020000_enforce_pending_expiry_at_fill.sql",
  import.meta.url,
);

function functionDefinition(sql: string, name: string): string {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}`;
  const start = sql.indexOf(marker);
  assert(start >= 0, `${name} must be defined by the migration`);
  const next = sql.indexOf(
    "\nCREATE OR REPLACE FUNCTION public.",
    start + marker.length,
  );
  return sql.slice(start, next < 0 ? sql.length : next);
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function plpgsqlBody(sql: string, name: string): string {
  const definition = functionDefinition(sql, name);
  const start = definition.indexOf("DECLARE");
  const end = definition.indexOf("\nEND;", start);
  assert(start >= 0 && end >= 0, `${name} must have a PL/pgSQL body`);
  return definition.slice(start, end + "\nEND;".length);
}

function normalizeEntryBody(body: string): string {
  return body
    .replace(/^\s*--.*$/gm, "")
    .replace(/^\s*v_position_status TEXT;\s*$/gm, "")
    .replace(/^\s*v_broker_execution_state TEXT;\s*$/gm, "")
    .replace(
      /RETURNING id, position_status, broker_execution_state\s+INTO v_position_uuid, v_position_status, v_broker_execution_state;/g,
      "RETURNING id INTO v_position_uuid;",
    )
    .replace(
      /,\s*'execution_mode', v_account\.execution_mode,\s*'position_status', v_position_status,\s*'broker_execution_state', v_broker_execution_state/g,
      "",
    )
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim();
}

Deno.test("broker-close compatibility migration adds helpers without Phase 2 enforcement", async () => {
  const sql = await Deno.readTextFile(migrationUrl.pathname);

  for (
    const helper of [
      "broker_close_has_terminal_proof",
      "broker_open_exact_position_id",
      "broker_close_resolves_open",
      "paper_position_broker_close_requirements",
      "broker_connection_effective_account_identity",
      "list_unresolved_broker_open_orphans",
      "broker_connection_has_unresolved_managed_exposure",
      "broker_connection_mutation_preflight",
      "paper_account_has_unresolved_managed_exposure",
    ]
  ) {
    assertStringIncludes(sql, `CREATE OR REPLACE FUNCTION public.${helper}`);
  }

  assert(!sql.includes("CREATE TRIGGER"), "Phase 1 must not install triggers");
  assert(!sql.includes("ALTER TABLE"), "Phase 1 must not change constraints");
  assert(
    !sql.includes("CREATE OR REPLACE FUNCTION public.guard_"),
    "Phase 1 must not install enforcement guards",
  );
  assert(
    !sql.includes("REVOKE ALL ON FUNCTION public.finalize_"),
    "Phase 1 must not revoke existing finalizer access",
  );
  assert(
    !/REVOKE\s+(?:ALL|INSERT|UPDATE|DELETE)[^;]*\sON\s+(?:TABLE\s+)?public\./i
      .test(sql),
    "Phase 1 must not revoke existing table privileges",
  );
});

Deno.test("terminal close proof is exact and never inferred from absence", async () => {
  const sql = await Deno.readTextFile(migrationUrl.pathname);
  const proof = functionDefinition(sql, "broker_close_has_terminal_proof");
  const claim = functionDefinition(sql, "claim_broker_execution");

  assertStringIncludes(proof, "p_status = 'succeeded'");
  assertStringIncludes(
    proof,
    "p_response_payload->'close_confirmed' = 'true'::JSONB",
  );
  assertStringIncludes(proof, "p_request_payload->>'brokerPositionId'");
  assertStringIncludes(proof, "p_response_payload->>'broker_position_id'");
  assertStringIncludes(claim, "observed_absence_not_terminal_proof");
});

Deno.test("claim hardening is close-only and preserves legacy open callers", async () => {
  const sql = await Deno.readTextFile(migrationUrl.pathname);
  const claim = functionDefinition(sql, "claim_broker_execution");

  assertStringIncludes(
    claim.replaceAll(/\s+/g, " "),
    "claim_broker_execution( p_user_id UUID, p_bot_id TEXT, p_position_id TEXT, p_broker_connection_id UUID, p_action TEXT, p_route TEXT, p_request_payload JSONB )",
  );
  assertStringIncludes(claim, "IF p_action = 'close' THEN");
  assertEquals(occurrences(claim, "IF p_action = 'open'"), 0);
  assertStringIncludes(claim, "broker_position_identity_unavailable");
  assertStringIncludes(claim, "open_execution_in_flight");
  assertStringIncludes(claim, "interval '2 minutes'");
  assertStringIncludes(claim, "interval '30 seconds'");
  assertStringIncludes(claim, "attempt_count = attempt_count + 1");
  assertStringIncludes(claim, "public.broker_open_exact_position_id(");
  assert(
    !claim.includes("finished_at = COALESCE(finished_at, now())"),
    "same-transaction timestamps must not make a later close look simultaneous",
  );
  assert(
    !claim.includes("v_open_attempt.broker_order_id"),
    "legacy broker_order_id is not guaranteed to identify the opened position",
  );

  for (
    const incompatibleOpenRequirement of [
      "broker_connection_identity_unavailable",
      "effectiveAccountId",
      "provisional_position_missing",
      "execution_mode_not_live",
      "prop_firm_daily_lock",
    ]
  ) {
    assert(
      !claim.includes(incompatibleOpenRequirement),
      `Phase 1 must not require ${incompatibleOpenRequirement} from open callers`,
    );
  }
});

Deno.test("completion requires exact proof only for successful closes", async () => {
  const sql = await Deno.readTextFile(migrationUrl.pathname);
  const complete = functionDefinition(sql, "complete_broker_execution");

  assertStringIncludes(
    complete.replaceAll(/\s+/g, " "),
    "complete_broker_execution( p_ledger_id UUID, p_user_id UUID, p_claim_token UUID, p_status TEXT, p_response_payload JSONB, p_broker_order_id TEXT, p_last_error TEXT )",
  );
  assertStringIncludes(complete, "v_row.action = 'close'");
  assertStringIncludes(complete, "public.broker_close_has_terminal_proof(");
  assertStringIncludes(complete, "broker_close_proof_missing");
  assertStringIncludes(complete, "v_effective_status := 'uncertain'");
  assertStringIncludes(complete, "'requested_status', p_status");
  assertStringIncludes(complete, "'completed', true");
  assert(
    !complete.includes("broker_open_proof_missing"),
    "legacy successful opens must remain completable without a new identity requirement",
  );
});

Deno.test("exposure helpers include uncertain opens and exact later closes", async () => {
  const sql = await Deno.readTextFile(migrationUrl.pathname);
  const requirements = functionDefinition(
    sql,
    "paper_position_broker_close_requirements",
  );
  const orphans = functionDefinition(
    sql,
    "list_unresolved_broker_open_orphans",
  );
  const connection = functionDefinition(
    sql,
    "broker_connection_has_unresolved_managed_exposure",
  );
  const account = functionDefinition(
    sql,
    "paper_account_has_unresolved_managed_exposure",
  );

  const openIdentity = functionDefinition(sql, "broker_open_exact_position_id");
  const resolution = functionDefinition(sql, "broker_close_resolves_open");

  for (const definition of [requirements, orphans]) {
    assertStringIncludes(
      definition,
      "status IN ('succeeded', 'attempting', 'uncertain')",
    );
    assertStringIncludes(definition, "public.broker_close_resolves_open(");
  }

  assertStringIncludes(openIdentity, "p_response_payload->>'positionId'");
  assertStringIncludes(
    openIdentity,
    "p_response_payload#>>'{orderFillTransaction,tradeOpened,tradeID}'",
  );
  assert(!openIdentity.includes("orderFillTransaction,id"));
  assert(!openIdentity.includes("broker_order_id"));
  assertStringIncludes(resolution, "p_close_started_at > p_open_completed_at");
  assertStringIncludes(resolution, "public.broker_close_has_terminal_proof(");
  assertStringIncludes(
    requirements.replaceAll(/\s+/g, " "),
    "COALESCE( open_ledger.finished_at, open_ledger.started_at )",
  );
  assertStringIncludes(requirements, "unknown_identity_connection_ids UUID[]");
  assertStringIncludes(requirements, "broker_position_ids JSONB");

  assertStringIncludes(
    connection,
    "public.paper_position_broker_close_requirements(",
  );
  assert(
    !connection.includes("public.broker_close_has_terminal_proof("),
    "the connection helper must delegate close-evidence ownership",
  );

  assertStringIncludes(
    account,
    "cardinality(requirements.missing_close_connection_ids) > 0",
  );
  assertStringIncludes(
    account,
    "cardinality(requirements.required_connection_ids) = 0",
  );
  assertStringIncludes(account, "NOT IN ('paper', 'rejected')");
  assertStringIncludes(account, "public.list_unresolved_broker_open_orphans(");

  const missingIndex = account.indexOf(
    "cardinality(requirements.missing_close_connection_ids) > 0",
  );
  const stateIndex = account.indexOf("NOT IN ('paper', 'rejected')");
  assert(
    missingIndex >= 0 && missingIndex < stateIndex,
    "missing close proof must block independently of the lifecycle label",
  );
});

Deno.test("entry RPCs expose lifecycle state without changing capacity behavior", async () => {
  const sql = await Deno.readTextFile(migrationUrl.pathname);
  const marketOwner = await Deno.readTextFile(marketEntryOwnerUrl.pathname);
  const pendingOwner = await Deno.readTextFile(pendingFillOwnerUrl.pathname);
  const market = functionDefinition(sql, "finalize_market_entry");
  const pending = functionDefinition(sql, "finalize_pending_order_fill");

  assertEquals(
    occurrences(sql, "'execution_mode', v_account.execution_mode"),
    2,
  );
  assertEquals(occurrences(sql, "'position_status', v_position_status"), 2);
  assertEquals(
    occurrences(sql, "'broker_execution_state', v_broker_execution_state"),
    2,
  );

  for (const definition of [market, pending]) {
    assertStringIncludes(
      definition.replaceAll(/\s+/g, " "),
      "RETURNING id, position_status, broker_execution_state INTO v_position_uuid, v_position_status, v_broker_execution_state",
    );
    assertStringIncludes(definition, "position_status = 'open'");
    assert(
      !definition.includes("position_status IN ('open', 'pending')"),
      "Phase 1 must not change entry capacity semantics",
    );
  }

  assertEquals(
    normalizeEntryBody(plpgsqlBody(sql, "finalize_market_entry")),
    normalizeEntryBody(plpgsqlBody(marketOwner, "finalize_market_entry")),
  );
  assertEquals(
    normalizeEntryBody(plpgsqlBody(sql, "finalize_pending_order_fill")),
    normalizeEntryBody(
      plpgsqlBody(pendingOwner, "finalize_pending_order_fill"),
    ),
  );
});
