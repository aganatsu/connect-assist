import { LayoutDashboard, LineChart, Brain, Bot, BookOpen, FlaskConical, Settings, Calendar, Sun, Moon, Monitor, Crosshair, ShieldX, Zap, PenLine } from "lucide-react";
import { NavLink } from "@/components/NavLink";
import { useTheme } from "@/contexts/ThemeContext";
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarHeader, SidebarFooter, useSidebar,
} from "@/components/ui/sidebar";

const navGroups = [
  { label: "Trade", items: [
    { title: "Dashboard", url: "/", icon: LayoutDashboard },
    { title: "Bot", url: "/bot", icon: Bot },
    { title: "Chart", url: "/chart", icon: LineChart },
    { title: "Game Plan", url: "/game-plan", icon: Crosshair },
    { title: "Manual Impulse", url: "/manual-impulse", icon: PenLine },
    { title: "Fundamentals", url: "/fundamentals", icon: Calendar },
  ] },
  { label: "Review", items: [
    { title: "Journal", url: "/journal", icon: BookOpen },
    { title: "Rejected Setups", url: "/rejected-setups", icon: ShieldX },
  ] },
  { label: "Research", items: [
    { title: "ICT Analysis", url: "/ict-analysis", icon: Brain },
    { title: "Backtest", url: "/backtest", icon: FlaskConical },
    { title: "Optimizer", url: "/optimizer", icon: Zap },
  ] },
  { label: "System", items: [
    { title: "Settings", url: "/settings", icon: Settings },
  ] },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const { theme, setTheme } = useTheme();

  const cycleTheme = () => {
    const next = theme === "dark" ? "light" : theme === "light" ? "system" : "dark";
    setTheme(next);
  };

  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="p-4">
        {!collapsed && <h1 className="text-lg font-bold text-primary">SMC Trading</h1>}
        {collapsed && <span className="text-lg font-bold text-primary">S</span>}
      </SidebarHeader>
      <SidebarContent>
        {navGroups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton asChild>
                      <NavLink to={item.url} end={item.url === "/"} className="hover:bg-accent/50" activeClassName="bg-accent text-primary font-medium">
                        <item.icon className="mr-2 h-4 w-4" />
                        {!collapsed && <span>{item.title}</span>}
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="p-2">
        <button
          onClick={cycleTheme}
          className="flex items-center gap-2 w-full px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          title={`Theme: ${theme}`}
        >
          <ThemeIcon className="h-4 w-4 shrink-0" />
          {!collapsed && <span className="capitalize">{theme}</span>}
        </button>
      </SidebarFooter>
    </Sidebar>
  );
}
