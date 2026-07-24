import React, { createContext, useContext, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Switch } from "@/components/ui/switch";

// ─── Context for search highlighting ────────────────────────────────────────
export const HighlightContext = createContext<Set<string>>(new Set());

// ─── Types ──────────────────────────────────────────────────────────────────
export interface ConfigTabProps {
  config: any;
  setConfig: React.Dispatch<React.SetStateAction<any>>;
  updateField: (section: string, key: string, value: any) => void;
  highlightedLabels?: Set<string>;
}

// ─── Collapsible Section ────────────────────────────────────────────────────
interface CollapsibleSectionProps {
  id: string;
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export function CollapsibleSection({
  id,
  title,
  subtitle,
  icon,
  badge,
  defaultOpen = false,
  children,
}: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border border-border rounded-lg overflow-hidden">
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
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  const highlighted = useContext(HighlightContext);
  const isHighlighted = highlighted.has(label.toLowerCase());

  return (
    <div className={`space-y-1.5 ${isHighlighted ? "ring-1 ring-primary/50 rounded-md p-2 -m-2 bg-primary/5" : ""}`}>
      <div>
        <label className="text-xs font-medium text-foreground">{label}</label>
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
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const highlighted = useContext(HighlightContext);
  const isHighlighted = highlighted.has(label.toLowerCase());

  return (
    <div className={`flex items-center justify-between gap-4 py-1.5 ${isHighlighted ? "ring-1 ring-primary/50 rounded-md p-2 -m-1 bg-primary/5" : ""}`}>
      <div className="min-w-0">
        <span className="text-xs font-medium text-foreground">{label}</span>
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
