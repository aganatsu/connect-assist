import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Search, X } from "lucide-react";
import { INSTRUMENTS, INSTRUMENT_TYPES, INSTRUMENT_TYPE_LABELS } from "@/lib/marketData";

interface InstrumentSearchProps {
  open: boolean;
  onClose: () => void;
  mobile?: boolean;
}

const TYPE_COLORS: Record<string, string> = {
  forex: "text-blue-400",
  index: "text-amber-400",
  commodity: "text-yellow-400",
  crypto: "text-purple-400",
};

export function InstrumentSearch({ open, onClose, mobile }: InstrumentSearchProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (open) {
      setQuery("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const filtered = INSTRUMENTS.filter(
    (i) =>
      i.symbol.toLowerCase().includes(query.toLowerCase()) ||
      i.name.toLowerCase().includes(query.toLowerCase())
  );

  const selectSymbol = (symbol: string) => {
    window.dispatchEvent(
      new CustomEvent("smc-symbol-change", { detail: { symbol } })
    );
    onClose();
    navigate("/chart");
  };

  // Group filtered results by type
  const grouped = INSTRUMENT_TYPES.filter(type => filtered.some(i => i.type === type))
    .map(type => ({
      type,
      label: INSTRUMENT_TYPE_LABELS[type],
      instruments: filtered.filter(i => i.type === type),
    }));

  // Mobile: fullscreen overlay
  if (mobile) {
    return (
      <div className="fixed inset-0 z-50 bg-background flex flex-col">
        <div className="p-3 border-b border-border flex items-center gap-3">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search instruments..."
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {grouped.map(group => (
            <div key={group.type}>
              <div className="px-4 py-2 bg-accent/50 sticky top-0">
                <span className={`text-[10px] font-bold uppercase tracking-wider ${TYPE_COLORS[group.type] || "text-muted-foreground"}`}>
                  {group.label}
                </span>
              </div>
              {group.instruments.map((inst) => (
                <button
                  key={inst.symbol}
                  onClick={() => selectSymbol(inst.symbol)}
                  className="w-full text-left px-4 py-3 text-sm hover:bg-accent transition-colors border-b border-border/50 active:bg-accent"
                >
                  <span className="font-medium text-foreground">{inst.symbol}</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">{inst.name}</span>
                </button>
              ))}
            </div>
          ))}
          {filtered.length === 0 && (
            <p className="text-sm text-muted-foreground p-6 text-center">No results</p>
          )}
        </div>
      </div>
    );
  }

  // Desktop: sidebar panel
  return (
    <div className="w-48 bg-sidebar border-r border-sidebar-border flex flex-col h-full">
      <div className="p-2 border-b border-sidebar-border flex items-center gap-2">
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search..."
          className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
        />
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {grouped.map(group => (
          <div key={group.type}>
            <div className="px-3 py-1.5 bg-sidebar-accent/50 sticky top-0">
              <span className={`text-[9px] font-bold uppercase tracking-wider ${TYPE_COLORS[group.type] || "text-muted-foreground"}`}>
                {group.label}
              </span>
            </div>
            {group.instruments.map((inst) => (
              <button
                key={inst.symbol}
                onClick={() => selectSymbol(inst.symbol)}
                className="w-full text-left px-3 py-2 text-xs hover:bg-sidebar-accent transition-colors border-b border-sidebar-border/50"
              >
                <span className="font-medium text-foreground">{inst.symbol}</span>
                <span className="block text-[10px] text-muted-foreground">{inst.name}</span>
              </button>
            ))}
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="text-xs text-muted-foreground p-3 text-center">No results</p>
        )}
      </div>
    </div>
  );
}
