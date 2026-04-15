import { useEffect, useRef, memo } from 'react';
import type { Instrument, Timeframe } from '@/lib/marketData';

interface Props {
  instrument: Instrument;
  timeframe: Timeframe;
}

function getTVSymbol(instrument: Instrument): string {
  const symbolMap: Record<string, string> = {
    'EUR/USD': 'FX:EURUSD',
    'GBP/USD': 'FX:GBPUSD',
    'USD/JPY': 'FX:USDJPY',
    'GBP/JPY': 'FX:GBPJPY',
    'AUD/USD': 'FX:AUDUSD',
    'USD/CAD': 'FX:USDCAD',
    'EUR/GBP': 'FX:EURGBP',
    'NZD/USD': 'FX:NZDUSD',
    'BTC/USD': 'BITSTAMP:BTCUSD',
    'XAU/USD': 'OANDA:XAUUSD',
  };
  return symbolMap[instrument.symbol] || instrument.symbol.replace('/', '');
}

function getTVInterval(timeframe: Timeframe): string {
  const intervalMap: Record<string, string> = {
    '1week': 'W', '1day': 'D', '4h': '240', '1h': '60', '15min': '15', '5min': '5',
  };
  return intervalMap[timeframe] || 'D';
}

function TradingViewChart({ instrument, timeframe }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    container.innerHTML = '';

    const widgetContainer = document.createElement('div');
    widgetContainer.className = 'tradingview-widget-container';
    widgetContainer.style.height = '100%';
    widgetContainer.style.width = '100%';

    const widgetDiv = document.createElement('div');
    widgetDiv.className = 'tradingview-widget-container__widget';
    widgetDiv.style.height = '100%';
    widgetDiv.style.width = '100%';
    widgetContainer.appendChild(widgetDiv);
    container.appendChild(widgetContainer);

    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.type = 'text/javascript';
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: getTVSymbol(instrument),
      interval: getTVInterval(timeframe),
      timezone: 'Etc/UTC',
      theme: 'dark',
      style: '1',
      locale: 'en',
      allow_symbol_change: true,
      calendar: false,
      hide_top_toolbar: false,
      hide_side_toolbar: false,
      hide_legend: false,
      hide_volume: false,
      save_image: true,
      withdateranges: true,
      backgroundColor: 'rgba(10, 10, 15, 1)',
      gridColor: 'rgba(255, 255, 255, 0.03)',
      studies: [],
      watchlist: ['FX:EURUSD', 'FX:GBPUSD', 'FX:USDJPY', 'BITSTAMP:BTCUSD', 'OANDA:XAUUSD'],
    });

    widgetContainer.appendChild(script);

    return () => {
      container.innerHTML = '';
    };
  }, [instrument.symbol, timeframe]);

  return (
    <div ref={containerRef} className="w-full h-full min-h-[500px] rounded-lg overflow-hidden border border-border bg-card" />
  );
}

export default memo(TradingViewChart);
