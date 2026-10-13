import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useToasts } from './Toast';

describe('useToasts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('starts with empty toasts', () => {
    const { result } = renderHook(() => useToasts());
    expect(result.current.toasts).toEqual([]);
  });

  it('pushes a toast', () => {
    const { result } = renderHook(() => useToasts());
    act(() => {
      result.current.push('success', 'Done!');
    });
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].tone).toBe('success');
    expect(result.current.toasts[0].message).toBe('Done!');
  });

  it('dismisses a toast', () => {
    const { result } = renderHook(() => useToasts());
    let id: string;
    act(() => {
      id = result.current.push('info', 'Hello');
    });
    act(() => {
      result.current.dismiss(id!);
    });
    expect(result.current.toasts).toHaveLength(0);
  });

  it('auto-dismisses after TTL', () => {
    const { result } = renderHook(() => useToasts());
    act(() => {
      result.current.push('error', 'Oops', 3000);
    });
    expect(result.current.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.toasts).toHaveLength(0);
  });
});
