import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { HealthStateBadge, StateBadge, StatusBadge, TaskStateBadge } from './Badge';

describe('StateBadge', () => {
  it('renders active state with good tone', () => {
    const { container } = render(<StateBadge value="active" />);
    const badge = container.querySelector('.badge-good');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('active');
  });

  it('renders blocked-suspect state with bad tone', () => {
    const { container } = render(<StateBadge value="blocked-suspect" />);
    const badge = container.querySelector('.badge-bad');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('blocked-suspect');
  });

  it('renders stale state with warn tone', () => {
    const { container } = render(<StateBadge value="stale" />);
    const badge = container.querySelector('.badge-warn');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('stale');
  });

  it('renders unknown state with neutral tone', () => {
    const { container } = render(<StateBadge value="unknown-state" />);
    const badge = container.querySelector('.badge-neutral');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('unknown-state');
  });
});

describe('StatusBadge', () => {
  it('renders active status with good tone', () => {
    const { container } = render(<StatusBadge value="active" />);
    const badge = container.querySelector('.badge-good');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('active');
  });

  it('renders superseded status with warn tone', () => {
    const { container } = render(<StatusBadge value="superseded" />);
    const badge = container.querySelector('.badge-warn');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('superseded');
  });

  it('renders archived status with neutral tone', () => {
    const { container } = render(<StatusBadge value="archived" />);
    const badge = container.querySelector('.badge-neutral');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('archived');
  });
});

describe('TaskStateBadge and HealthStateBadge', () => {
  it('keeps a terminal task state separate from an unhealthy health state', () => {
    const { container } = render(
      <>
        <TaskStateBadge value="done" />
        <HealthStateBadge value="expired" />
      </>,
    );

    expect(container.querySelector('[aria-label="Task state: done"]')?.textContent).toBe('done');
    expect(container.querySelector('[aria-label="Health: expired"]')?.textContent).toBe('expired');
  });

  it('labels a null task state as legacy without inferring open', () => {
    const { container } = render(<TaskStateBadge value={null} />);
    expect(container.querySelector('[aria-label="Task state: legacy"]')?.textContent).toBe('legacy');
  });
});
