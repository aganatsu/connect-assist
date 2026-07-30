import { describe, expect, it } from "vitest";
import {
  getLiveThesisConvictionDisplay,
  getWatchlistDisplay,
} from "./featureState";

describe("truthful feature states", () => {
  it("shows live Thesis Conviction as shadow when active mode was requested", () => {
    const display = getLiveThesisConvictionDisplay(true, "active");

    expect(display.state).toBe("shadow");
    expect(display.description).toContain("does not change entry scoring");
  });

  it("shows disabled Thesis Conviction as inactive", () => {
    expect(getLiveThesisConvictionDisplay(false, "shadow").state).toBe("inactive");
  });

  it("distinguishes a non-executable Watchlist candidate from shadow mode", () => {
    const display = getWatchlistDisplay(false);

    expect(display.state).toBe("monitoring");
    expect(display.label).toBe("WATCHING · NO VALID ZONE");
    expect(display.description).toContain("cannot execute");
  });

  it("keeps an execution-eligible Watchlist candidate active", () => {
    expect(getWatchlistDisplay(true).state).toBe("active");
  });
});
