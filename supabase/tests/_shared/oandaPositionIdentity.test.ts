import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type BrokerConnection,
  findOandaBrokerPosition,
} from "./reconcileBrokerState.ts";

const connection: BrokerConnection = {
  id: "connection-1",
  account_id: "account-1",
  api_key: "secret",
  broker_type: "oanda",
  display_name: "OANDA",
  is_active: true,
};

Deno.test("OANDA reconciliation prefers exact client position identity", () => {
  const result = findOandaBrokerPosition(
    [
      {
        id: "legacy-trade",
        instrument: "EUR_USD",
        currentUnits: "1000",
      },
      {
        id: "exact-trade",
        instrument: "EUR_USD",
        currentUnits: "1000",
        clientExtensions: {
          id: "position-1",
          comment: "paper:position-1",
        },
      },
    ],
    {
      position_id: "position-1",
      symbol: "EUR/USD",
      direction: "long",
    },
    connection,
  );

  assertEquals(result.match, "exact");
  assertEquals(result.trade?.id, "exact-trade");
});

Deno.test("OANDA reconciliation refuses ambiguous legacy matches", () => {
  const result = findOandaBrokerPosition(
    [
      {
        id: "legacy-1",
        instrument: "EUR_USD",
        currentUnits: "1000",
      },
      {
        id: "legacy-2",
        instrument: "EUR_USD",
        currentUnits: "2000",
      },
    ],
    {
      position_id: "position-1",
      symbol: "EUR/USD",
      direction: "long",
    },
    connection,
  );

  assertEquals(result.match, "ambiguous");
  assertEquals(result.trade, null);
});
