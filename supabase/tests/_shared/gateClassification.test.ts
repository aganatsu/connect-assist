import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { GATE_CLASS, V3_LOGGED_ONLY_GATE_IDS } from "../../functions/_shared/simplification.ts";

/** Every safety gate carries a stable id, and every id is classified strategy vs risk (Impulse-on-V3 step 4a). */

const SRC = Deno.readTextFileSync(new URL("../../functions/bot-scanner/index.ts", import.meta.url));

Deno.test("gates: every gates.push in bot-scanner carries a gateId, and every gateId is classified", () => {
  const pushes = [...SRC.matchAll(/gates\.push\(\{([^\n]*)/g)].map((m) => m[1]);
  assert(pushes.length >= 87, `${pushes.length} gate pushes`);
  const untagged = pushes.filter((p) => !/^\s*gateId: "/.test(p));
  assertEquals(untagged, [], "a gate without an id could never be switched or classified");
  const ids = new Set(pushes.map((p) => /gateId: "([a-z_0-9]+)"/.exec(p)![1]));
  const unclassified = [...ids].filter((id) => !(id in GATE_CLASS));
  assertEquals(unclassified, []);
});

Deno.test("gates: the owner's split — account / risk rules stay enforcing under V3; the legacy strategy filters only record", () => {
  for (const id of ["max_positions", "per_symbol", "portfolio_heat", "daily_loss", "drawdown", "consecutive_losses", "daily_dollar_loss", "correlation", "cooldown", "instrument_enabled"]) {
    assertEquals(GATE_CLASS[id as keyof typeof GATE_CLASS], "risk", id);
    assert(!V3_LOGGED_ONLY_GATE_IDS.has(id), id);
  }
  for (const id of ["score", "direction_verdict", "game_plan", "smt", "fotsi", "tier1", "regime", "news_event", "news_alignment", "premium_discount", "htf_bias", "kill_zone"]) {
    assert(V3_LOGGED_ONLY_GATE_IDS.has(id), id);
  }
});
