import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const tracker = await Deno.readTextFile(
  new URL(
    "../../functions/outcome-tracker/index.ts",
    import.meta.url,
  ),
);
const candleSource = await Deno.readTextFile(
  new URL(
    "../../functions/_shared/candleSource.ts",
    import.meta.url,
  ),
);

Deno.test("outcome tracker preserves developing setups and requests their frozen historical range", () => {
  assertStringIncludes(tracker, "const candleRequest = outcomeCandleRequest(");
  assertStringIncludes(tracker, "interval: candleRequest.interval");
  assertStringIncludes(tracker, "startAt: candleRequest.startAt");
  assertStringIncludes(tracker, "endAt: candleRequest.endAt");
  assertStringIncludes(tracker, "const outcome = classifyTrackedOutcome(");
  assertStringIncludes(tracker, "outcome_status: outcome.outcome_status");
});

Deno.test("bounded historical ranges reach both public candle providers", () => {
  assertStringIncludes(
    candleSource,
    "start_date=${encodeURIComponent(formatRangeTime(range.startAt))}",
  );
  assertStringIncludes(
    candleSource,
    "end_date=${encodeURIComponent(formatRangeTime(range.endAt))}",
  );
  assertStringIncludes(
    candleSource,
    "const to = range?.endAt ? new Date(range.endAt) : new Date()",
  );
  assertStringIncludes(candleSource, "const from = range?.startAt");
  assertStringIncludes(
    candleSource,
    '${baseCacheScope}:range:${opts.startAt ?? "open"}:${opts.endAt ?? "now"}',
  );
});

Deno.test("unavailable candle rows rotate instead of starving later setups", () => {
  assertStringIncludes(
    tracker,
    '.order("outcome_checked_at", { ascending: true, nullsFirst: true })',
  );
  assertStringIncludes(tracker, 'outcome_reason: "candle_data_unavailable"');
  assertStringIncludes(tracker, 'outcome_reason: "tracking_error"');
});
