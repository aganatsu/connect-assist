import { describe, expect, it } from "vitest";

import {
  pendingOrderConfirmationPresentation,
  pendingOrderPostConfirmationPresentation,
} from "@/lib/pendingOrderDisplay";

describe("OperationsDashboard decision pipeline", () => {
  it.each([
    ["choch", "MSS / CHoCH, displacement, or reversal"],
    ["indicators", "Indicator consensus"],
    [
      "choch_and_indicators",
      "MSS / CHoCH, displacement, or reversal + indicators",
    ],
  ] as const)("uses the frozen %s confirmation label", (method, expectedLabel) => {
    const presentation = pendingOrderConfirmationPresentation({
      confirmation_method: method,
      confirmation_config: { afterChochMode: "confirmation_close" },
      impulse_entry_lifecycle: { mode: "observe" },
    });

    expect(presentation.label).toBe(expectedLabel);
    expect(presentation.methodSource).toBe("frozen");
    expect(presentation.frozenAtSetup).toBe(true);
  });

  it("uses the latest effective lifecycle mode for indicator setups", () => {
    const presentation = pendingOrderConfirmationPresentation({
      confirmation_method: "indicators",
      confirmation_config: { afterChochMode: "confirmation_close" },
      impulse_entry_lifecycle: { mode: "observe" },
      pending_authorization_observation: {
        confirmation: {
          latest: {
            method: "indicators",
            lifecycleMode: "enforce",
            detectorPassed: true,
            lifecyclePassed: false,
            lifecycleGatePassed: false,
          },
        },
      },
    });

    expect(presentation.label).toBe("MSS / CHoCH + indicators");
    expect(presentation.structureLifecycleEnforced).toBe(true);
    expect(presentation.complete).toBe(false);
    expect(presentation.detail).toBe(
      "Indicator consensus ready; waiting for protected structure",
    );
  });

  it("does not mark lifecycle-only evidence as complete", () => {
    const presentation = pendingOrderConfirmationPresentation({
      confirmation_method: "indicators",
      confirmation_config: { afterChochMode: "confirmation_close" },
      impulse_entry_lifecycle: { mode: "enforce" },
      pending_authorization_observation: {
        confirmation: {
          latest: {
            method: "indicators",
            lifecycleMode: "enforce",
            detectorPassed: false,
            lifecyclePassed: true,
            lifecycleGatePassed: true,
          },
        },
      },
    });

    expect(presentation.complete).toBe(false);
    expect(presentation.detail).toBe(
      "Protected structure ready; waiting for indicator consensus",
    );
  });

  it("does not treat the pre-gate observation as definitive completion", () => {
    const presentation = pendingOrderConfirmationPresentation({
      confirmation_method: "choch_and_indicators",
      confirmation_config: { afterChochMode: "wait_retracement" },
      impulse_entry_lifecycle: { mode: "enforce" },
      pending_authorization_observation: {
        confirmation: {
          latest: {
            method: "choch_and_indicators",
            lifecycleMode: "enforce",
            detectorPassed: true,
            lifecyclePassed: true,
            lifecycleGatePassed: true,
          },
        },
      },
    });

    expect(presentation.complete).toBe(false);
    expect(presentation.detail).toBe(
      "Confirmation gates observed; completing downstream checks",
    );
  });

  it("marks confirmation complete only after a downstream artifact exists", () => {
    const retracement = pendingOrderConfirmationPresentation({
      status: "awaiting_confirmation",
      confirmation_method: "choch_and_indicators",
      confirmation_config: { afterChochMode: "wait_retracement" },
      impulse_entry_lifecycle: { mode: "enforce" },
      post_confirmation_entry: { state: "awaiting_retracement" },
    });
    const authorization = pendingOrderConfirmationPresentation({
      status: "awaiting_confirmation",
      confirmation_method: "choch",
      confirmation_config: { afterChochMode: "confirmation_close" },
      final_authorization: {
        authorized: false,
        evaluatedAt: "2026-08-24T12:00:00Z",
      },
    });

    expect(retracement.complete).toBe(true);
    expect(retracement.detail).toBe(
      "Structure and indicator confirmation recorded",
    );
    expect(authorization.complete).toBe(true);
    expect(authorization.detail).toBe("Closed-bar confirmation recorded");
  });

  it("ignores stale authorization evidence after a later attempt or zone reset", () => {
    const laterAttempt = pendingOrderConfirmationPresentation({
      status: "awaiting_confirmation",
      confirmation_method: "choch",
      confirmation_config: { afterChochMode: "confirmation_close" },
      final_authorization: {
        authorized: false,
        evaluatedAt: "2026-08-24T12:00:00Z",
      },
      pending_authorization_observation: {
        confirmation: {
          latest: {
            sampledAt: "2026-08-24T12:05:00Z",
            method: "choch",
            lifecycleMode: "observe",
            detectorPassed: true,
            lifecyclePassed: false,
            lifecycleGatePassed: true,
          },
        },
        finalAuthorization: {
          evaluatedAt: "2026-08-24T12:00:00Z",
        },
      },
    });
    const resetToWatching = pendingOrderConfirmationPresentation({
      status: "pending",
      confirmation_method: "choch",
      confirmation_config: { afterChochMode: "confirmation_close" },
      final_authorization: {
        authorized: false,
        evaluatedAt: "2026-08-24T12:00:00Z",
      },
    });

    expect(laterAttempt.complete).toBe(false);
    expect(resetToWatching.complete).toBe(false);
  });

  it("omits a post-confirmation step for confirmation-close entry", () => {
    expect(pendingOrderPostConfirmationPresentation({
      confirmation_config: { afterChochMode: "confirmation_close" },
    }, true)).toEqual({
      step: null,
      entryReady: true,
    });
  });

  it("shows observation-only retracement without blocking authorization", () => {
    const presentation = pendingOrderPostConfirmationPresentation({
      confirmation_config: { afterChochMode: "observe_retracement" },
    }, true);

    expect(presentation.step).toEqual({
      label: "Retracement observation",
      detail: "Observation only; does not block entry",
      state: "complete",
    });
    expect(presentation.entryReady).toBe(true);
  });

  it("shows the frozen retracement zone type and blocks until ready", () => {
    const waiting = pendingOrderPostConfirmationPresentation({
      confirmation_config: { afterChochMode: "wait_retracement" },
      post_confirmation_entry: {
        state: "awaiting_retracement",
        zone: { type: "fvg" },
      },
    }, true);
    const ready = pendingOrderPostConfirmationPresentation({
      confirmation_config: { afterChochMode: "wait_retracement" },
      post_confirmation_entry: {
        state: "ready",
        zone: { type: "micro_ob" },
      },
    }, true);

    expect(waiting.step).toEqual({
      label: "FVG retracement",
      detail: "awaiting retracement",
      state: "active",
    });
    expect(waiting.entryReady).toBe(false);
    expect(ready.step).toEqual({
      label: "Micro OB retracement",
      detail: "ready",
      state: "complete",
    });
    expect(ready.entryReady).toBe(true);
  });

  it("marks retracement not required when a non-CHoCH signal reached authorization", () => {
    const presentation = pendingOrderPostConfirmationPresentation({
      confirmation_config: { afterChochMode: "wait_retracement" },
      final_authorization: { authorized: false },
    }, true);

    expect(presentation.step).toEqual({
      label: "Post-confirmation retracement",
      detail: "Not required by the accepted confirmation",
      state: "complete",
    });
    expect(presentation.entryReady).toBe(true);
  });

  it("labels an unknown legacy contract instead of inventing frozen settings", () => {
    const confirmation = pendingOrderConfirmationPresentation({});
    const postConfirmation = pendingOrderPostConfirmationPresentation({}, false);

    expect(confirmation).toMatchObject({
      label: "Confirmation (runtime fallback)",
      methodSource: "fallback",
      methodKnown: false,
      frozenAtSetup: false,
      complete: false,
    });
    expect(postConfirmation).toEqual({
      step: {
        label: "Post-confirmation mode",
        detail: "Resolved from current settings for this legacy setup",
        state: "pending",
      },
      entryReady: false,
    });
  });

  it("uses observed runtime settings for a legacy order when available", () => {
    const presentation = pendingOrderConfirmationPresentation({
      pending_authorization_observation: {
        confirmation: {
          latest: {
            method: "indicators",
            lifecycleMode: "observe",
            detectorPassed: false,
            lifecyclePassed: false,
            lifecycleGatePassed: true,
          },
        },
      },
    });

    expect(presentation).toMatchObject({
      method: "indicators",
      methodSource: "runtime_observation",
      methodKnown: true,
      label: "Indicator consensus",
      frozenAtSetup: false,
    });
  });

  it("reads a legacy persisted method before using runtime observations", () => {
    const presentation = pendingOrderConfirmationPresentation({
      signal_reason: {
        watchlistLifecycle: { confirmationMethod: "indicators" },
      },
      pending_authorization_observation: {
        confirmation: {
          latest: {
            method: "choch",
            lifecycleMode: "observe",
          },
        },
      },
    });

    expect(presentation.method).toBe("indicators");
    expect(presentation.methodSource).toBe("legacy_persisted");
    expect(presentation.frozenAtSetup).toBe(false);
  });
});
