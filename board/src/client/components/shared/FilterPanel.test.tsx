import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FilterPanel from './FilterPanel';
import { useFilterOptions } from '../../hooks/useData';

vi.mock('../../hooks/useData', () => ({
  useFilterOptions: vi.fn(),
}));

const mockedUseFilterOptions = vi.mocked(useFilterOptions);

describe('FilterPanel', () => {
  beforeEach(() => {
    mockedUseFilterOptions.mockReturnValue({
      data: {
        projects: [],
        workspaces: [],
        topics: [],
        sourceAgents: [],
        sorts: ['updated'],
        pageSizes: [10],
      },
    } as unknown as ReturnType<typeof useFilterOptions>);
  });

  it('keeps rendering when an older API response omits state options', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <FilterPanel />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText('Task State')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'legacy' })).toBeTruthy();
    expect(screen.getByLabelText('Health')).toBeTruthy();
    expect(screen.getAllByRole('option', { name: 'expired' })).toHaveLength(2);
  });
});
