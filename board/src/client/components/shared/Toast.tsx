import { useEffect, useState, useCallback } from 'react';

export type ToastTone = 'success' | 'error' | 'info';

export interface Toast {
  id: string;
  tone: ToastTone;
  message: string;
}

let toastIdCounter = 0;

/**
 * Toast hook: returns toasts + push/dismiss helpers.
 * Use for ephemeral feedback (form submission, copy, etc.).
 */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((tone: ToastTone, message: string, ttl = 4000) => {
    const id = `toast-${++toastIdCounter}`;
    setToasts((prev) => [...prev, { id, tone, message }]);
    if (ttl > 0) {
      setTimeout(() => dismiss(id), ttl);
    }
    return id;
  }, [dismiss]);

  return { toasts, push, dismiss };
}

export function ToastContainer({ toasts, dismiss }: {
  toasts: Toast[];
  dismiss: (id: string) => void;
}) {
  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`} onClick={() => dismiss(t.id)}>
          <span className="toast-icon">
            {t.tone === 'success' ? '✓' : t.tone === 'error' ? '✕' : 'ℹ'}
          </span>
          <span className="toast-message">{t.message}</span>
        </div>
      ))}
    </div>
  );
}
