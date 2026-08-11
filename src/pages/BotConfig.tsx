import { AppShell } from "@/components/AppShell";
import { BotConfigModal } from "@/components/BotConfigModal";

/**
 * Bot configuration as a route rather than a dialog.
 *
 * The panel is the same component the modal uses, rendered with variant="page":
 * one implementation, two presentations. Copying the 600-line body into a page
 * would have produced two configs that drift — the pattern documented in
 * docs/CONCEPT_INVENTORY.md.
 *
 * The modal is deliberately left in place. Five callers open it contextually
 * (BotView, Settings, Brokers, Recommendations), often deep-linked to a tab or
 * a search term, and that is a genuinely different job from browsing the whole
 * config.
 */
export default function BotConfig() {
  return (
    <AppShell>
      <div className="p-3 sm:p-4">
        <BotConfigModal open variant="page" onClose={() => {}} />
      </div>
    </AppShell>
  );
}
