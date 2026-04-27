// Shared market data types and constants

export interface Instrument {
  symbol: string;
  name: string;
  type: 'forex' | 'crypto' | 'commodity' | 'index';
  pipSize: number;
  pointValue?: number;   // default 1
  contractSize?: number; // default 100000 for forex
}

export type Timeframe = '1week' | '1day' | '4h' | '1h' | '15min' | '5min';

export const INSTRUMENTS: Instrument[] = [
  // ── Forex Majors ──
  { symbol: 'EUR/USD', name: 'Euro / US Dollar', type: 'forex', pipSize: 0.0001 },
  { symbol: 'GBP/USD', name: 'British Pound / US Dollar', type: 'forex', pipSize: 0.0001 },
  { symbol: 'USD/JPY', name: 'US Dollar / Japanese Yen', type: 'forex', pipSize: 0.01 },
  { symbol: 'AUD/USD', name: 'Australian Dollar / US Dollar', type: 'forex', pipSize: 0.0001 },
  { symbol: 'NZD/USD', name: 'New Zealand Dollar / US Dollar', type: 'forex', pipSize: 0.0001 },
  { symbol: 'USD/CAD', name: 'US Dollar / Canadian Dollar', type: 'forex', pipSize: 0.0001 },
  { symbol: 'USD/CHF', name: 'US Dollar / Swiss Franc', type: 'forex', pipSize: 0.0001 },
  // ── Forex Crosses ──
  { symbol: 'EUR/GBP', name: 'Euro / British Pound', type: 'forex', pipSize: 0.0001 },
  { symbol: 'EUR/JPY', name: 'Euro / Japanese Yen', type: 'forex', pipSize: 0.01 },
  { symbol: 'GBP/JPY', name: 'British Pound / Japanese Yen', type: 'forex', pipSize: 0.01 },
  { symbol: 'EUR/AUD', name: 'Euro / Australian Dollar', type: 'forex', pipSize: 0.0001 },
  { symbol: 'EUR/CAD', name: 'Euro / Canadian Dollar', type: 'forex', pipSize: 0.0001 },
  { symbol: 'EUR/CHF', name: 'Euro / Swiss Franc', type: 'forex', pipSize: 0.0001 },
  { symbol: 'EUR/NZD', name: 'Euro / New Zealand Dollar', type: 'forex', pipSize: 0.0001 },
  { symbol: 'GBP/AUD', name: 'British Pound / Australian Dollar', type: 'forex', pipSize: 0.0001 },
  { symbol: 'GBP/CAD', name: 'British Pound / Canadian Dollar', type: 'forex', pipSize: 0.0001 },
  { symbol: 'GBP/CHF', name: 'British Pound / Swiss Franc', type: 'forex', pipSize: 0.0001 },
  { symbol: 'GBP/NZD', name: 'British Pound / New Zealand Dollar', type: 'forex', pipSize: 0.0001 },
  { symbol: 'AUD/CAD', name: 'Australian Dollar / Canadian Dollar', type: 'forex', pipSize: 0.0001 },
  { symbol: 'AUD/JPY', name: 'Australian Dollar / Japanese Yen', type: 'forex', pipSize: 0.01 },
  { symbol: 'CAD/JPY', name: 'Canadian Dollar / Japanese Yen', type: 'forex', pipSize: 0.01 },
  // ── Indices ──
  { symbol: 'US30', name: 'Dow Jones Industrial', type: 'index', pipSize: 1.0, pointValue: 1, contractSize: 1 },
  { symbol: 'NAS100', name: 'Nasdaq 100', type: 'index', pipSize: 0.25, pointValue: 1, contractSize: 1 },
  { symbol: 'SPX500', name: 'S&P 500', type: 'index', pipSize: 0.25, pointValue: 1, contractSize: 1 },
  // ── Commodities ──
  { symbol: 'XAU/USD', name: 'Gold / US Dollar', type: 'commodity', pipSize: 0.01, pointValue: 1, contractSize: 100 },
  { symbol: 'XAG/USD', name: 'Silver / US Dollar', type: 'commodity', pipSize: 0.001, pointValue: 1, contractSize: 5000 },
  { symbol: 'US Oil', name: 'Crude Oil', type: 'commodity', pipSize: 0.01, pointValue: 1, contractSize: 1000 },
  // ── Crypto ──
  { symbol: 'BTC/USD', name: 'Bitcoin / US Dollar', type: 'crypto', pipSize: 1.0, pointValue: 1, contractSize: 1 },
  { symbol: 'ETH/USD', name: 'Ethereum / US Dollar', type: 'crypto', pipSize: 0.01, pointValue: 1, contractSize: 1 },
];

export const INSTRUMENT_TYPES = ['forex', 'index', 'commodity', 'crypto'] as const;

export const INSTRUMENT_TYPE_LABELS: Record<string, string> = {
  forex: 'Forex',
  index: 'Indices',
  commodity: 'Commodities',
  crypto: 'Crypto',
};

export const FOREX_PAIRS = INSTRUMENTS.filter(i => i.type === 'forex').map(i => i.symbol);

export const TIMEFRAMES: { value: Timeframe; label: string }[] = [
  { value: '1week', label: '1W' },
  { value: '1day', label: '1D' },
  { value: '4h', label: '4H' },
  { value: '1h', label: '1H' },
  { value: '15min', label: '15M' },
  { value: '5min', label: '5M' },
];

// Display-only session windows (UTC hours, approximate for chart overlays).
// These are cosmetic — the actual gating uses _shared/sessions.ts (NY time).
export const SESSIONS = [
  { name: "Asian", start: 0, end: 7, color: "hsl(280, 60%, 65%)" },
  { name: "London", start: 7, end: 13, color: "hsl(210, 100%, 52%)" },
  { name: "New York", start: 13, end: 21, color: "hsl(38, 92%, 50%)" },
  { name: "Off-Hours", start: 21, end: 0, color: "hsl(270, 55%, 70%)" },
];

export const KILL_ZONES = [
  { name: "Asian KZ", start: 0, end: 3, color: "hsl(280, 60%, 65%)" },
  { name: "London KZ", start: 7, end: 9, color: "hsl(210, 100%, 52%)" },
  { name: "NY KZ", start: 12, end: 14, color: "hsl(38, 92%, 50%)" },
  { name: "London Close KZ", start: 15, end: 16, color: "hsl(142, 72%, 45%)" },
];

export function getCurrentSession(): string {
  // Use Intl to get NY local hour (DST-aware), matching the canonical session boundaries.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  let h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  if (h === 24) h = 0;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const t = h + m / 60;
  if (t >= 2 && t < 8.5) return "London";
  if (t >= 8.5 && t < 16) return "New York";
  if (t >= 16 && t < 20) return "Off-Hours";
  return "Asian"; // 20:00 - 02:00 NY
}

export function isInKillzone(): { active: boolean; name: string } {
  const h = new Date().getUTCHours();
  for (const kz of KILL_ZONES) {
    if (h >= kz.start && h < kz.end) return { active: true, name: kz.name };
  }
  return { active: false, name: "" };
}

// Demo data generators
export function generateEquityCurve(days = 90): { date: string; equity: number; drawdown: number; pnl: number }[] {
  const data = [];
  let equity = 10000;
  let peak = equity;
  const now = Date.now();
  
  for (let i = days; i >= 0; i--) {
    const date = new Date(now - i * 86400000);
    const pnl = (Math.random() - 0.45) * 200;
    equity += pnl;
    peak = Math.max(peak, equity);
    const drawdown = peak > 0 ? ((equity - peak) / peak) * 100 : 0;
    
    data.push({
      date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      equity: parseFloat(equity.toFixed(2)),
      drawdown: parseFloat(drawdown.toFixed(2)),
      pnl: parseFloat(pnl.toFixed(2)),
    });
  }
  return data;
}

export function formatMoney(val: number, showSign = false): string {
  const abs = Math.abs(val);
  const str = abs >= 1000
    ? `$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${abs.toFixed(2)}`;
  if (showSign) return val >= 0 ? `+${str}` : `-${str}`;
  return str;
}
