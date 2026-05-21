/**
 * useChartAnalysis — Wraps the smc-analysis call with timeframe-aware refresh.
 * 
 * Refresh intervals:
 *  - 5m/15m → 30s
 *  - 1h/4h  → 5 min
 *  - 1d/1w  → manual only (no auto-refresh)
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { marketApi, smcApi, type CandleSource } from '@/lib/api';
import { supabase } from '@/integrations/supabase/client';
import type { Timeframe } from '@/lib/marketData';

function getRefreshInterval(tf: Timeframe): number | false {
  switch (tf) {
    case '5min':
    case '15min':
      return 30_000;
    case '1h':
    case '4h':
      return 300_000;
    default:
      return false; // 1day, 1week — manual refresh only
  }
}

function getStaleTime(tf: Timeframe): number {
  switch (tf) {
    case '5min':
    case '15min':
      return 20_000;
    case '1h':
    case '4h':
      return 120_000;
    default:
      return 600_000;
  }
}

export interface ChartAnalysisResult {
  candles: any[] | undefined;
  candleSource: CandleSource;
  dailyCandles: any[] | undefined;
  analysis: any | undefined;
  botScanSignal: { signal: any; scannedAt: string } | null | undefined;
  isLoading: boolean;
  isAnalysisLoading: boolean;
  refetch: () => void;
}

export function useChartAnalysis(symbol: string, timeframe: Timeframe): ChartAnalysisResult {
  const refreshInterval = getRefreshInterval(timeframe);
  const staleTime = getStaleTime(timeframe);

  // Candles
  const { data: candleData, isLoading: candlesLoading } = useQuery({
    queryKey: ['chart-candles', symbol, timeframe],
    queryFn: () => marketApi.candlesWithMeta(symbol, timeframe, 500),
    staleTime,
    refetchInterval: refreshInterval,
  });
  const candles = candleData?.candles;
  const candleSource: CandleSource = candleData?.source ?? 'unknown';

  // Daily candles (for HTF context)
  const { data: dailyCandles } = useQuery({
    queryKey: ['chart-daily', symbol],
    queryFn: () => marketApi.candles(symbol, '1day', 30),
    staleTime: 300_000,
  });

  // SMC Analysis
  const { data: analysis, isLoading: analysisLoading, refetch } = useQuery({
    queryKey: ['chart-smc', symbol, candles?.length],
    queryFn: () => smcApi.fullAnalysis(candles!, dailyCandles),
    enabled: !!candles && candles.length > 0,
    staleTime,
    refetchInterval: refreshInterval,
  });

  // Bot scan signal
  const { data: botScanSignal } = useQuery({
    queryKey: ['chart-bot-scan', symbol],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('scan_logs')
        .select('details_json, scanned_at')
        .order('scanned_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      const details = Array.isArray(data?.details_json) ? data.details_json : [];
      const match = (details as any[]).find((d) => d?.pair === symbol);
      return match ? { signal: match, scannedAt: data?.scanned_at as string } : null;
    },
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  const isLoading = candlesLoading;
  const isAnalysisLoading = analysisLoading;

  return useMemo(() => ({
    candles,
    candleSource,
    dailyCandles,
    analysis,
    botScanSignal,
    isLoading,
    isAnalysisLoading,
    refetch,
  }), [candles, candleSource, dailyCandles, analysis, botScanSignal, isLoading, isAnalysisLoading, refetch]);
}
