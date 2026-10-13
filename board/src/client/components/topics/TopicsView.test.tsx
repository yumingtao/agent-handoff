import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TopicsView from './TopicsView';
import { useOverview, useTopics } from '../../hooks/useData';

vi.mock('../../hooks/useData', () => ({
  useOverview: vi.fn(),
  useTopics: vi.fn(),
}));

const mockedUseOverview = vi.mocked(useOverview);
const mockedUseTopics = vi.mocked(useTopics);

function topic(key: string, taskState: string | null, healthState: string) {
  return {
    key,
    logicalTopicId: key,
    project: 'my-repo',
    workspace: null,
    workspaceKey: '_',
    topic: key,
    rawTopics: [key],
    aliasCount: 1,
    latestStatus: 'active',
    latestSourceAgent: 'opencode',
    latestSourceHost: null,
    latestUpdatedAt: '2026-07-30T09:00:00.000Z',
    latestUpdatedAtDisplay: '2026-07-30 17:00:00',
    latestConclusionId: `${key}-conclusion`,
    latestConclusionPreview: null,
    expiresAt: null,
    isExpired: false,
    hasNextAction: false,
    refsCount: 0,
    supersedeDepth: 0,
    participantAgents: ['opencode'],
    participantCount: 1,
    recordCount: 1,
    taskState,
    healthState,
    displayState: taskState === 'done' ? 'done' : healthState,
    completedAt: null,
    completedBy: null,
    cancelledAt: null,
    cancelledBy: null,
    derivedTaskState: taskState === 'done' ? 'done' : healthState,
    relatedRunIds: [],
    relatedRunStatus: null,
    lastRunAt: null,
    lastEventAt: null,
    lastEventType: null,
    blockedCount24h: 0,
    heartbeatCount24h: 0,
    claimCount24h: 0,
  };
}

describe('TopicsView', () => {
  beforeEach(() => {
    mockedUseOverview.mockReturnValue({
      data: {
        openTaskTopics: 1,
        doneTaskTopics: 1,
        cancelledTaskTopics: 0,
        legacyTaskTopics: 0,
        healthyTopics: 0,
        blockedHealthTopics: 0,
        staleHealthTopics: 0,
        expiredHealthTopics: 2,
      },
    } as unknown as ReturnType<typeof useOverview>);
    mockedUseTopics.mockReturnValue({
      data: {
        topics: [
          topic('done-expired', 'done', 'expired'),
          topic('open-expired', 'open', 'expired'),
          topic('cancelled-blocked', 'cancelled', 'blocked'),
        ],
        pagination: { totalTopics: 3, totalPages: 1, currentPage: 1, pageSize: 10 },
        filterOptions: { projects: [], workspaces: [], topics: [], sourceAgents: [], sorts: [], pageSizes: [], taskStates: [], healthStates: [] },
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useTopics>);
  });

  it('renders task state and health independently for the same topic', () => {
    render(
      <MemoryRouter initialEntries={['/?taskState=done&healthState=expired']}>
        <Routes><Route path="/" element={<TopicsView />} /></Routes>
      </MemoryRouter>,
    );

    expect(screen.getByLabelText('Task state: done')).toBeTruthy();
    expect(screen.getAllByLabelText('Health: expired')).toHaveLength(2);
    expect(screen.getByLabelText('Task state: cancelled')).toBeTruthy();
    expect(screen.getByLabelText('Health: blocked')).toBeTruthy();
  });

  it('keeps independent filters in sort links', () => {
    render(
      <MemoryRouter initialEntries={['/?taskState=done&healthState=expired']}>
        <Routes><Route path="/" element={<TopicsView />} /></Routes>
      </MemoryRouter>,
    );

    const href = screen.getByRole('link', { name: 'Sort by health' }).getAttribute('href');
    expect(href).toContain('taskState=done');
    expect(href).toContain('healthState=expired');
    expect(href).toContain('sort=healthState');
  });

  it('sorts in place without leaving the SPA', () => {
    render(
      <MemoryRouter initialEntries={['/?sort=updated&page=1']}>
        <Routes><Route path="/" element={<TopicsView />} /></Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Sort by topic' }));

    expect(screen.getByRole('heading', { name: 'Topics' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sort by topic' }).getAttribute('href')).toBe('/?sort=topic&page=1');
  });
});
