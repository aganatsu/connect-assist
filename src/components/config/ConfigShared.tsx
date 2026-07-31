import React, { createContext, useContext, useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  FEATURE_STATE_LABELS,
  type FeatureState,
} from "@/lib/featureState";

export type { FeatureState } from "@/lib/featureState";

// ─── Context for search highlighting ────────────────────────────────────────
export const HighlightContext = createContext<Set<string>>(new Set());

// Collects every `label` prop found anywhere in a React subtree, so a
// collapsible section can tell whether it contains a search match.
function collectLabels(node: React.ReactNode, out: string[] = []): string[] {
  React.Children.forEach(node, (child) => {
    if (!React.isValidElement(child)) return;
    const props: any = child.props;
    if (typeof props?.label === "string") out.push(props.label.toLowerCase());
    if (typeof props?.title === "string") out.push(props.title.toLowerCase());
    if (props?.children) collectLabels(props.children, out);
  });
  return out;
}

// ─── Types ──────────────────────────────────────────────────────────────────
export interface ConfigTabProps {
  config: any;
  setConfig: React.Dispatch<React.SetStateAction<any>>;
  updateField: (section: string, key: string, value: any) => void;
  highlightedLabels?: Set<string>;
}

export function FeatureStateBadge({ state }: { state: FeatureState }) {
  const style = {
    active: "border-success/40 bg-success/10 text-success",
    shadow: "border-primary/40 bg-primary/10 text-primary",
    "log-only": "border-warning/40 bg-warning/10 text-warning",
    monitoring: "border-info-c/40 bg-info-c/10 text-info-c",
    inactive: "border-border bg-muted text-muted-foreground",
    disabled: "border-border bg-muted text-muted-foreground",
    unavailable: "border-destructive/30 bg-destructive/10 text-destructive",
  }[state];

  return (
    <span className={`ml-2 inline-flex rounded border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wide ${style}`}>
      {FEATURE_STATE_LABELS[state]}
    </span>
  );
}

// ─── Collapsible Section ────────────────────────────────────────────────────
interface CollapsibleSectionProps {
  id: string;
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  searchLabels?: string[];
  children: React.ReactNode;
}

export function CollapsibleSection({
  id,
  title,
  subtitle,
  icon,
  badge,
  defaultOpen = false,
  searchLabels = [],
  children,
}: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const highlighted = useContext(HighlightContext);
  const hasMatch =
    highlighted.size > 0 &&
    (highlighted.has(title.toLowerCase()) ||
      searchLabels.some((label) => highlighted.has(label.toLowerCase())) ||
      collectLabels(children).some((l) => highlighted.has(l)));

  useEffect(() => {
    if (hasMatch) setIsOpen(true);
  }, [hasMatch]);

  return (
    <div
      data-config-match={hasMatch ? "true" : undefined}
      className={`border rounded-lg overflow-hidden ${hasMatch ? "border-primary/60 ring-1 ring-primary/30" : "border-border"}`}
    >
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors text-left"
      >
        <span className="text-muted-foreground">
          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
        {icon && <span className="text-muted-foreground">{icon}</span>}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{title}</span>
            {badge}
          </div>
          {subtitle && (
            <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{subtitle}</p>
          )}
        </div>
      </button>
      {isOpen && (
        <div className="px-4 pb-4 pt-1 border-t border-border space-y-4">
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Section Header (reused from original) ──────────────────────────────────
export function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-sm font-bold text-foreground">{title}</h3>
      {description && <p className="text-[10px] text-muted-foreground mt-0.5">{description}</p>}
    </div>
  );
}

// ─── Field Group (reused from original, with search highlighting) ───────────
export function FieldGroup({
  label,
  description,
  status,
  children,
}: {
  label: string;
  description?: string;
  status?: FeatureState;
  children: React.ReactNode;
}) {
  const highlighted = useContext(HighlightContext);
  const isHighlighted = highlighted.has(label.toLowerCase());

  return (
    <div
      data-config-match={isHighlighted ? "true" : undefined}
      className={`space-y-1.5 scroll-mt-6 ${isHighlighted ? "ring-2 ring-primary rounded-md p-2 -m-2 bg-primary/10" : ""}`}
    >
      <div>
        <label className="text-xs font-medium text-foreground">
          {label}
          {status && <FeatureStateBadge state={status} />}
        </label>
        {description && <p className="text-[10px] text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

// ─── Toggle Field (reused from original, with search highlighting) ──────────
export function ToggleField({
  label,
  description,
  checked,
  onChange,
  disabled,
  status,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  status?: FeatureState;
}) {
  const highlighted = useContext(HighlightContext);
  const isHighlighted = highlighted.has(label.toLowerCase());

  return (
    <div
      data-config-match={isHighlighted ? "true" : undefined}
      className={`flex items-center justify-between gap-4 py-1.5 scroll-mt-6 ${isHighlighted ? "ring-2 ring-primary rounded-md p-2 -m-1 bg-primary/10" : ""}`}
    >
      <div className="min-w-0">
        <span className="text-xs font-medium text-foreground">
          {label}
          {status && <FeatureStateBadge state={status} />}
        </span>
        {description && <p className="text-[10px] text-muted-foreground">{description}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} className="shrink-0" />
    </div>
  );
}

// ─── Status Badge ───────────────────────────────────────────────────────────
export function StatusBadge({ count, total, label }: { count: number; total: number; label?: string }) {
  const color = count === 0 ? "text-muted-foreground bg-muted" : count === total ? "text-success bg-success/10" : "text-primary bg-primary/10";
  return (
    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${color}`}>
      {count}/{total} {label || "active"}
    </span>
  );
}
