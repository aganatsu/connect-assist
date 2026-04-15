import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Search, X } from "lucide-react";
import { INSTRUMENTS } from "@/lib/marketData";

interface InstrumentSearchProps {
  open: boolean;
  onClose: () => void;
}

export function InstrumentSearch({ open, onClose }: InstrumentSearchProps) {
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
        {filtered.map((inst) => (
          <button
            key={inst.symbol}
            onClick={() => selectSymbol(inst.symbol)}
            className="w-full text-left px-3 py-2 text-xs hover:bg-sidebar-accent transition-colors border-b border-sidebar-border/50"
          >
            <span className="font-medium text-foreground">{inst.symbol}</span>
            <span className="block text-[10px] text-muted-foreground">{inst.name}</span>
          </button>
        ))}
        {filtered.length === 0 && (
          <p className="text-xs text-muted-foreground p-3 text-center">No results</p>
        )}
      </div>
    </div>
  );
}
