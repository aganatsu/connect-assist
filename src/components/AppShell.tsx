import { useState, useCallback } from "react";
import { IconRail } from "@/components/IconRail";
import { MobileNav } from "@/components/MobileNav";
import { InstrumentSearch } from "@/components/InstrumentSearch";
import { StatusBar } from "@/components/StatusBar";
import { useIsMobile } from "@/hooks/use-mobile";

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const isMobile = useIsMobile();

  const toggleSearch = useCallback(() => setSearchOpen((v) => !v), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  if (isMobile) {
    return (
      <div className="h-screen flex flex-col">
        {/* Mobile search overlay */}
        {searchOpen && <InstrumentSearch open={searchOpen} onClose={closeSearch} mobile />}
        <main className="flex-1 px-3 py-2 overflow-auto pb-16">
          {children}
        </main>
        <MobileNav onSearchToggle={toggleSearch} />
      </div>
    );
  }

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
