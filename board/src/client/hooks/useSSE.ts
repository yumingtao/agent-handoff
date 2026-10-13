import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export type SSEStatus = 'connecting' | 'connected' | 'disconnected';

/**
 * SSE hook: connects to /events, invalidates React Query on update events.
 * Exposes connection status for UI indicators.
 */
export function useSSE() {
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);
  const [status, setStatus] = useState<SSEStatus>('connecting');

  useEffect(() => {
    const es = new EventSource('/events');
    esRef.current = es;

    es.addEventListener('ready', () => {
      setStatus('connected');
    });

    es.addEventListener('update', (event) => {
      setStatus('connected');
      try {
        const msg = JSON.parse((event as MessageEvent).data);
        // Targeted invalidation based on event type
        if (msg.type === 'backup' || msg.type === 'event') {
          queryClient.invalidateQueries({ queryKey: ['topics'] });
          queryClient.invalidateQueries({ queryKey: ['agents'] });
          queryClient.invalidateQueries({ queryKey: ['overview'] });
          queryClient.invalidateQueries({ queryKey: ['ops'] });
        } else {
          // Unknown event type: full invalidation as fallback
          queryClient.invalidateQueries();
        }
      } catch {
        // If we can't parse, invalidate everything
        queryClient.invalidateQueries();
      }
    });

    es.addEventListener('ping', () => {
      setStatus('connected');
    });

    es.onerror = () => {
      setStatus('disconnected');
    };

    return () => {
      es.close();
      esRef.current = null;
      setStatus('disconnected');
    };
  }, [queryClient]);

  return status;
}
