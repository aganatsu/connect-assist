import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(
  new URL(
    "../../functions/broker-connections/index.ts",
    import.meta.url,
  ),
);

Deno.test("broker connection operations preserve upstream broker error origin", () => {
  const helper = source.split("function brokerFailure")[1]
    ?.split("Deno.serve")[0] || "";
  assertStringIncludes(helper, 'errorOrigin: "broker"');
  assertStringIncludes(helper, "brokerStatus");

  const actionSections = [
    ['if (action === "auto_map_symbols")', 'if (action === "probe_symbols")'],
    ['if (action === "probe_symbols")', 'if (action === "test")'],
    ['if (action === "test")', 'if (action === "list_symbols")'],
    [
      'if (action === "list_symbols")',
      'return respond({ error: "Unknown action" })',
    ],
  ] as const;

  for (const [start, end] of actionSections) {
    const section = source.split(start)[1]?.split(end)[0] || "";
    assertStringIncludes(
      section,
      "brokerFailure(",
      `${start} must label upstream failures as broker-originated`,
    );
  }
});
