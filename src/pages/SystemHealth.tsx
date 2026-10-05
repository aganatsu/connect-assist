import { AppShell } from "@/components/AppShell";
import { SystemResetCard } from "@/components/SystemResetPanel";

/** Admin-only: ledger health, reset readiness, and the approved reset. */
export default function SystemHealth() {
  return (
    <AppShell>
      <div className="p-4 max-w-6xl mx-auto">
        <SystemResetCard />
      </div>
    </AppShell>
  );
}
