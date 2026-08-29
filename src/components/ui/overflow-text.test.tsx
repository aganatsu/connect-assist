import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "./tooltip";
import { OverflowText } from "./overflow-text";

function renderText(lines: 1 | 2 | 3 = 1) {
  render(
    <TooltipProvider>
      <OverflowText
        text="A long diagnostic explanation that must remain readable"
        lines={lines}
      />
    </TooltipProvider>,
  );
  return screen.getByRole("button", { name: /expand full text/i });
}

describe("OverflowText", () => {
  it("starts compact and exposes the complete value without zooming", () => {
    const text = renderText();

    expect(text.className).toContain("truncate");
    expect(text.getAttribute("title")).toContain("long diagnostic explanation");

    fireEvent.click(text);

    expect(text.getAttribute("aria-expanded")).toBe("true");
    expect(text.className).not.toContain("truncate");
    expect(text.className).toContain("whitespace-pre-wrap");
  });

  it("supports keyboard expansion for clamped multi-line text", () => {
    const text = renderText(2);
    expect(text.className).toContain("line-clamp-2");

    fireEvent.keyDown(text, { key: "Enter" });

    expect(text.getAttribute("aria-expanded")).toBe("true");
    expect(text.className).not.toContain("line-clamp-2");
  });
});
