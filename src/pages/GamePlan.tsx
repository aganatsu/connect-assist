import { AppShell } from "@/components/AppShell";
import { GamePlanPanel } from "@/components/GamePlanPanel";
import { WorkspaceBody, WorkspaceHeader, WorkspacePage } from "@/components/WorkspacePage";
import { Map } from "lucide-react";

export default function GamePlan() {
  return (
    <AppShell>
      <WorkspacePage layout="canvas">
        <WorkspaceHeader icon={Map} eyebrow="Session preparation" title="Pre-Session Game Plan" />
        <WorkspaceBody padded={false} scroll>
          <GamePlanPanel />
        </WorkspaceBody>
      </WorkspacePage>
    </AppShell>
  );
}
