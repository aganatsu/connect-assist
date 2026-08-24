import { render, screen } from "@testing-library/react";
import { Activity } from "lucide-react";
import { describe, expect, it } from "vitest";

import { WorkspaceBody, WorkspaceHeader, WorkspacePage } from "./WorkspacePage";

describe("WorkspacePage", () => {
  it("renders the shared page identity and action surface", () => {
    const { container } = render(
      <WorkspacePage layout="canvas">
        <WorkspaceHeader
          icon={Activity}
          eyebrow="Market intelligence"
          title="Analysis"
          description="EUR/USD"
          actions={<button type="button">Refresh</button>}
        />
        <WorkspaceBody padded={false} scroll>
          <p>Workspace content</p>
        </WorkspaceBody>
      </WorkspacePage>,
    );

    expect(screen.getByRole("heading", { name: "Analysis" })).toBeInTheDocument();
    expect(screen.getByText("Market intelligence")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("workspace-page--canvas");
    expect(screen.getByText("Workspace content").parentElement).toHaveClass("workspace-page__body--scroll");
    expect(screen.getByText("Workspace content").parentElement).not.toHaveClass("workspace-page__body--padded");
  });

  it("uses the document layout and padded body by default", () => {
    const { container } = render(
      <WorkspacePage>
        <WorkspaceBody>Content</WorkspaceBody>
      </WorkspacePage>,
    );

    expect(container.firstElementChild).toHaveClass("workspace-page--document");
    expect(screen.getByText("Content")).toHaveClass("workspace-page__body--padded");
  });
});
