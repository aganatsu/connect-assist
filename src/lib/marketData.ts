// Shared market data types and constants

export interface Instrument {
  symbol: string;
  name: string;
  type: 'forex' | 'crypto' | 'commodity';
  pipSize: number;
}

export type Timeframe = '1week' | '1day' | '4h' | '1h' | '15min' | '5min';

export const INSTRUMENTS: Instrument[] = [
  { symbol: 'EUR/USD', name: 'Euro / US Dollar', type: 'forex', pipSize: 0.0001 },
  { symbol: 'GBP/USD', name: 'British Pound / US Dollar', type: 'forex', pipSize: 0.0001 },
  { symbol: 'USD/JPY', name: 'US Dollar / Japanese Yen', type: 'forex', pipSize: 0.01 },
  { symbol: 'GBP/JPY', name: 'British Pound / Japanese Yen', type: 'forex', pipSize: 0.01 },
  { symbol: 'AUD/USD', name: 'Australian Dollar / US Dollar', type: 'forex', pipSize: 0.0001 },
  { symbol: 'USD/CAD', name: 'US Dollar / Canadian Dollar', type: 'forex', pipSize: 0.0001 },
  { symbol: 'EUR/GBP', name: 'Euro / British Pound', type: 'forex', pipSize: 0.0001 },
  { symbol: 'NZD/USD', name: 'New Zealand Dollar / US Dollar', type: 'forex', pipSize: 0.0001 },
  { symbol: 'XAU/USD', name: 'Gold / US Dollar', type: 'commodity', pipSize: 0.01 },
  { symbol: 'BTC/USD', name: 'Bitcoin / US Dollar', type: 'crypto', pipSize: 0.01 },
];

export const TIMEFRAMES: { value: Timeframe; label: string }[] = [
  { value: '1week', label: '1W' },
  { value: '1day', label: '1D' },
  { value: '4h', label: '4H' },
  { value: '1h', label: '1H' },
  { value: '15min', label: '15M' },
  { value: '5min', label: '5M' },
];

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
