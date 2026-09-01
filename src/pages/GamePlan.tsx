import { AppShell } from "@/components/AppShell";
import { GamePlanPanel } from "@/components/GamePlanPanel";

export default function GamePlan() {
  return (
    <AppShell>
      <div className="h-full flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h1 className="text-lg font-bold font-mono text-foreground">Pre-Session Game Plan</h1>
        </div>
        <div className="flex-1 overflow-auto">
          <GamePlanPanel />
        </div>
      </div>
    </AppShell>
  );
}
