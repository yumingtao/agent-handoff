import { useState, useCallback } from 'react';

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard not available
    }
  }, [value]);

  const display = label || value.slice(0, 8);

  return (
    <button type="button" className="copy-id" onClick={handleClick}>
      <span className="copy-id-value">{copied ? 'copied' : display}</span>
      <span className="copy-id-icon" aria-hidden="true">
        ⧉
      </span>
    </button>
  );
}
