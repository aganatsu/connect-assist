

# UI/UX Overhaul Plan — SMC Trading Dashboard

This plan transforms the current dashboard from a standard sidebar-app into the brutalist trading workstation described in the spec. The changes are organized by priority and grouped logically.

---

## What's Already Built (No Changes Needed)
- 7 views: Dashboard, Chart, ICT Analysis, Bot, Journal, Backtest, Settings
- Dark theme with semantic colors (success/destructive/warning/primary)
- Sidebar navigation with collapsible icons
- All core data flows (live quotes, SMC analysis, paper trading, scan logs)
- Bot controls, scan history, trade journal, backtest engine
- Session map, kill zones, premium/discount, currency strength
- Settings with broker connections, risk management, bot config presets

## What Needs to Change

### 1. Design System Overhaul (Global CSS)
Replace current rounded, soft design with brutalist terminal aesthetic:
- **Zero border radius** everywhere (`--radius: 0px`)
- Add **Space Grotesk** (headings/labels) and **IBM Plex Mono** (all numbers/prices) fonts
- Enable tabular numerals globally on mono font
- Update color tokens to OKLCH-based palette (near-black bg, cyan accent instead of blue)
- Add custom CSS classes: `.panel` (4px borders), `.glow-cyan`, `.glow-border-left`, `.status-dot-active` (pulsing)
- Custom scrollbar styling (6px, dark track)

**Files:** `index.html` (font imports), `src/index.css`, `tailwind.config.ts`

### 2. Navigation — Icon Rail (Replace Sidebar)
Replace the current `AppSidebar` + `AppShell` with a **48px vertical icon rail**:
- Fixed left rail with icons only (no text, no collapsing)
- Active state: 2px cyan left border + cyan bg tint
- Hover tooltips showing label + keyboard shortcut
- **Keyboard shortcuts**: `1`-`7` for view switching, `/` for instrument search, `Escape` to dismiss
- Instrument search panel: slides out from rail on `/` press, filters instruments, dispatches `smc-symbol-change` event

**Files:** New `src/components/IconRail.tsx`, new `src/components/InstrumentSearch.tsx`, update `src/components/AppShell.tsx`

### 3. Status Bar (Footer)
Add a **24px footer** across the bottom:
- Connection status (green/red WiFi icon)
- "PAPER MODE" label
- Data source label ("Yahoo Finance")
- Local clock (updated every 60s)

**Files:** New `src/components/StatusBar.tsx`, update `src/components/AppShell.tsx`

### 4. Dashboard View Enhancements
- Add **Active Signals Strip** below live prices (signals from latest scan)
- Add **Bot Activity Timeline** at bottom (last 20 events with colored icons and timestamps)
- Apply mono font to all price/number displays
- Flash animation on price changes

**Files:** Update `src/pages/Index.tsx`

### 5. Chart View — Analysis Panel Upgrades
Add missing accordion panels to the right sidebar:
- **Confluence Score panel** — large score display with bias badge
- **Multi-Timeframe panel** — weekly/daily/4H/1H trend badges
- **Entry Checklist** — pass/fail items with go/no-go score rating (A+/Strong/Moderate/Weak)
- **Session / Kill Zone panel** — current session, active KZ, session high/low
- **Judas Swing panel** — detection status, type, midnight open
- Make analysis panel **collapsible** (hide/show entire right side)

**Files:** Update `src/pages/Chart.tsx`

### 6. Bot View — Full Spec Layout
Major restructure into three-zone layout:
- **Top control bar**: Start/Stop/Pause + manual order form (collapsible) + engine status badge + mode toggle
- **Manual Order Form**: Order type, symbol, direction, size, trigger price, SL, TP, reason, score
- **Left column (~65%)**: Tabbed positions (Open / Pending / Closed Today / All History)
- **Right column (~35%)**: Account summary, strategy metrics, autonomous engine controls, latest scan results with factor tags
- **Bottom zone**: Live log stream with colored icons
- **Safety overlays**: Kill switch banner (full-width red), live mode banner, live mode confirmation dialog

**Files:** Update `src/pages/BotView.tsx`

### 7. Journal View — Trade Detail Panel
- Add **clickable trade rows** that open a slide-in detail panel (~35% width)
- Detail panel shows: full trade card, signal reasoning, post-mortem section
- Add **date range picker** to filter bar
- Performance tab: add daily P&L bar chart

**Files:** Update `src/pages/Journal.tsx`

### 8. Backtest View — Configuration Sidebar
Restructure into two-pane layout:
- **Left config sidebar** with collapsible sections: General, Spread/Slippage, Strategy (SMC toggles), Risk, Entry, Exit, Sessions
- Add missing parameters: cooldown, pyramiding, close-on-reverse, trailing stop, break-even, partial TP, time-based exit
- Results: add monthly P&L heatmap, setup distribution, exit distribution, long vs short breakdown
- **Saved runs** with localStorage persistence and comparison mode

**Files:** Update `src/pages/Backtest.tsx`

### 9. Settings — Bot Config as Full-Screen Modal
Move bot configuration from Settings tab into a **full-screen modal overlay** accessible from Bot view's "Config" button:
- 8 sections: Strategy, Risk, Entry, Exit, Instruments, Sessions, Notifications, Protection
- Uses toggle/number/select/section primitives
- Progressive disclosure with collapsible subsections

**Files:** New `src/components/BotConfigModal.tsx`, update `src/pages/BotView.tsx`, update `src/pages/Settings.tsx`

### 10. ICT Analysis — Missing Panels
Add:
- **Correlation Matrix** — color-coded grid of pair correlations
- **Fundamentals section** — economic calendar with countdowns (already exists on separate page, integrate here)

**Files:** Update `src/pages/IctAnalysis.tsx`

---

## Implementation Order
1. Design system + fonts (CSS/Tailwind) — foundation for everything
2. Icon rail + status bar + AppShell restructure
3. Dashboard enhancements
4. Chart view panels
5. Bot view full restructure + config modal
6. Journal detail panel
7. Backtest config sidebar
8. ICT Analysis additions

## Technical Notes
- Keyboard shortcuts use a global `useEffect` with `keydown` listener, disabled when `activeElement` is an input/textarea
- Instrument search dispatches `window.dispatchEvent(new CustomEvent('smc-symbol-change', { detail: { symbol } }))`
- Views listen via `useEffect` + `addEventListener`
- All number displays get `font-mono` class with `font-feature-settings: "tnum" 1`
- No backend changes needed — this is purely frontend UI/UX

