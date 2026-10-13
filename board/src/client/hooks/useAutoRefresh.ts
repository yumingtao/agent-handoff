import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export const REFRESH_INTERVALS: ReadonlyArray<{ label: string; value: number }> = [
  { label: 'Off', value: 0 },
  { label: '15s', value: 15 },
  { label: '30s', value: 30 },
  { label: '1m', value: 60 },
  { label: '5m', value: 300 },
];

const STORAGE_KEY = 'loop-board.refresh-interval';
const MIN_INTERVAL = 15;

const DEFAULT_INTERVAL = 15;

function readStoredInterval(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_INTERVAL;
    const val = Number(raw);
    return val === 0 || val >= MIN_INTERVAL ? val : DEFAULT_INTERVAL;
  } catch {
    return DEFAULT_INTERVAL;
  }
}

/**
 * Manages auto-refresh: periodically invalidates all React Query caches.
 * The interval choice is persisted to localStorage.
 */
export function useAutoRefresh() {
  const queryClient = useQueryClient();
  const [interval, setIntervalState] = useState<number>(readStoredInterval);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshNow = useCallback(() => {
    queryClient.invalidateQueries();
    setLastRefreshedAt(new Date());
  }, [queryClient]);

  const setInterval_ = useCallback((seconds: number) => {
    const safe = seconds === 0 || seconds >= MIN_INTERVAL ? seconds : 0;
    setIntervalState(safe);
    try {
      localStorage.setItem(STORAGE_KEY, String(safe));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (interval > 0) {
      timerRef.current = setInterval(() => {
        queryClient.invalidateQueries();
        setLastRefreshedAt(new Date());
      }, interval * 1000);
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [interval, queryClient]);

  return { interval, setInterval: setInterval_, refreshNow, lastRefreshedAt };
}
