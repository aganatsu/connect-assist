import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  LayoutDashboard, LineChart, Bot, Search, MoreHorizontal,
  Brain, BookOpen, FlaskConical, Settings, Server, Calendar, X, Play,
} from "lucide-react";

const PRIMARY_ITEMS = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "Chart", url: "/chart", icon: LineChart },
  { title: "Bot", url: "/bot", icon: Bot },
];

const MORE_ITEMS = [
  { title: "ICT Analysis", url: "/ict-analysis", icon: Brain },
  { title: "Fundamentals", url: "/fundamentals", icon: Calendar },
  { title: "Journal", url: "/journal", icon: BookOpen },
  { title: "Backtest", url: "/backtest", icon: FlaskConical },
  { title: "Brokers", url: "/brokers", icon: Server },
  { title: "Trade Replay", url: "/trade-replay", icon: Play },
  { title: "Settings", url: "/settings", icon: Settings },
];

interface MobileNavProps {
  onSearchToggle: () => void;
}

export function MobileNav({ onSearchToggle }: MobileNavProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);

  const isActive = (url: string) =>
    url === "/" ? location.pathname === "/" : location.pathname.startsWith(url);

  return (
    <>
      {/* More menu overlay */}
      {moreOpen && (
        <div className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm" onClick={() => setMoreOpen(false)}>
          <div
            className="absolute bottom-14 left-0 right-0 bg-card border-t border-border p-3 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">More</span>
              <button onClick={() => setMoreOpen(false)} className="text-muted-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {MORE_ITEMS.map((item) => (
                <button
                  key={item.url}
                  onClick={() => {
                    navigate(item.url);
                    setMoreOpen(false);
                  }}
                  className={`flex flex-col items-center gap-1 p-3 rounded-lg transition-colors ${
                    isActive(item.url)
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  <item.icon className="h-5 w-5" />
                  <span className="text-[10px] font-medium">{item.title}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Bottom tab bar */}
      <div className="fixed bottom-0 left-0 right-0 z-30 bg-card border-t border-border safe-area-bottom">
        <div className="flex items-center justify-around h-14">
          {PRIMARY_ITEMS.map((item) => (
            <button
              key={item.url}
              onClick={() => navigate(item.url)}
              className={`flex flex-col items-center gap-0.5 px-3 py-1.5 transition-colors ${
                isActive(item.url)
                  ? "text-primary"
                  : "text-muted-foreground"
              }`}
            >
              <item.icon className="h-5 w-5" />
              <span className="text-[10px] font-medium">{item.title}</span>
            </button>
          ))}

          {/* Search */}
          <button
            onClick={onSearchToggle}
            className="flex flex-col items-center gap-0.5 px-3 py-1.5 text-muted-foreground"
          >
            <Search className="h-5 w-5" />
            <span className="text-[10px] font-medium">Search</span>
          </button>

          {/* More */}
          <button
            onClick={() => setMoreOpen((v) => !v)}
            className={`flex flex-col items-center gap-0.5 px-3 py-1.5 transition-colors ${
              moreOpen ? "text-primary" : "text-muted-foreground"
            }`}
          >
            <MoreHorizontal className="h-5 w-5" />
            <span className="text-[10px] font-medium">More</span>
          </button>
        </div>
      </div>
    </>
  );
}
