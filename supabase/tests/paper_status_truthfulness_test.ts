import { assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(
  new URL("../functions/paper-trading/index.ts", import.meta.url),
);
const brokerSource = await Deno.readTextFile(
  new URL("../functions/broker-execute/index.ts", import.meta.url),
);

Deno.test("paper status fails closed when account state cannot be read", () => {
  assertMatch(
    source,
    /data:\s*account,\s*error:\s*accountReadError[\s\S]*account_status_read_failed/,
  );
});

Deno.test("paper status does not flatten failed position reads", () => {
  assertMatch(
    source,
    /data:\s*positions,\s*error:\s*positionsReadError[\s\S]*position_status_read_failed/,
  );
});


Deno.test("paper status does not flatten failed post-close refreshes", () => {
  assertMatch(
    source,
    /data:\s*remaining,\s*error:\s*remainingReadError[\s\S]*position_status_refresh_failed/,
  );
  assertMatch(
    source,
    /data:\s*updatedAccount,\s*error:\s*accountRefreshError[\s\S]*account_status_refresh_failed/,
  );
});

Deno.test("broker connection status reports upstream failures as unknown", () => {
  assertMatch(
    brokerSource,
    /ok:\s*false,\s*state:\s*"unknown"[\s\S]*MetaAPI provisioning/,
  );
  assertMatch(
    brokerSource,
    /ok:\s*false,\s*state:\s*"unknown"[\s\S]*OANDA/,
  );
});
