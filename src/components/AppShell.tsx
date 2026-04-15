import { useState, useCallback } from "react";
import { IconRail } from "@/components/IconRail";
import { InstrumentSearch } from "@/components/InstrumentSearch";
import { StatusBar } from "@/components/StatusBar";

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [searchOpen, setSearchOpen] = useState(false);

  const toggleSearch = useCallback(() => setSearchOpen((v) => !v), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  return (
    <div className="h-screen flex flex-col">
      <div className="flex-1 flex min-h-0">
        <IconRail onSearchToggle={toggleSearch} />
        {searchOpen && <InstrumentSearch open={searchOpen} onClose={closeSearch} />}
        <main className="flex-1 p-4 overflow-auto">
          {children}
        </main>
      </div>
      <StatusBar />
    </div>
  );
}
