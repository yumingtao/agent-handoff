import { useSearchParams } from 'react-router-dom';
import { useFilterOptions } from '../../hooks/useData';
import type { FilterOptions } from '../../types';

const defaultFilterOptions: FilterOptions = {
  projects: [],
  workspaces: [],
  topics: [],
  sourceAgents: [],
  sorts: ['updated', 'healthState', 'taskState', 'state', 'agent', 'topic'],
  pageSizes: [10, 20, 50],
  taskStates: ['open', 'done', 'cancelled', 'legacy'],
  healthStates: ['healthy', 'stale', 'blocked', 'expired'],
};

function renderOptions(values: string[], selected: string, placeholder: string) {
  return (
    <>
      <option value="">{placeholder}</option>
      {values.map((v) => (
        <option key={v} value={v}>
          {v}
        </option>
      ))}
    </>
  );
}

export default function FilterPanel() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: filterOptions } = useFilterOptions();

  const activeFilters = [
    searchParams.get('sort') && searchParams.get('sort') !== 'updated' && `Sort: ${searchParams.get('sort')}`,
    searchParams.get('project') && `Project: ${searchParams.get('project')}`,
    searchParams.get('workspace') && `Workspace: ${searchParams.get('workspace')}`,
    searchParams.get('topic') && `Topic: ${searchParams.get('topic')}`,
    searchParams.get('sourceAgent') && `Agent: ${searchParams.get('sourceAgent')}`,
    searchParams.get('state') && `State: ${searchParams.get('state')}`,
    searchParams.get('taskState') && `Task state: ${searchParams.get('taskState')}`,
    searchParams.get('healthState') && `Health: ${searchParams.get('healthState')}`,
    searchParams.get('q') && `Search: ${searchParams.get('q')}`,
  ].filter(Boolean);

  const fo: FilterOptions = {
    ...defaultFilterOptions,
    ...filterOptions,
    taskStates: filterOptions?.taskStates ?? defaultFilterOptions.taskStates,
    healthStates: filterOptions?.healthStates ?? defaultFilterOptions.healthStates,
  };

  const currentView = searchParams.get('view') || 'topics';

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const next = new URLSearchParams();
    next.set('view', currentView);
    for (const [k, v] of fd.entries()) {
      if (v) next.set(k, v as string);
    }
    setSearchParams(next, { replace: true });
  }

  function handleReset() {
    const next = new URLSearchParams();
    next.set('view', currentView);
    setSearchParams(next, { replace: true });
  }

  return (
    <details className="panel filter-panel" open={activeFilters.length > 0}>
      <summary>
        <strong>Filters</strong>
        <span className="helper">Narrow the board by scope before switching views.</span>
      </summary>
      <form onSubmit={handleSubmit} className="toolbar">
        <div className="field">
          <label className="field-label" htmlFor="filter-q">Search</label>
          <input
            id="filter-q"
            type="text"
            name="q"
            defaultValue={searchParams.get('q') || ''}
            placeholder="Search text"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="filter-project">Project</label>
          <select id="filter-project" name="project" defaultValue={searchParams.get('project') || ''}>
            {renderOptions(fo.projects, searchParams.get('project') || '', 'All projects')}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="filter-workspace">Workspace</label>
          <select id="filter-workspace" name="workspace" defaultValue={searchParams.get('workspace') || ''}>
            {renderOptions(fo.workspaces, searchParams.get('workspace') || '', 'All workspaces')}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="filter-topic">Topic</label>
          <select id="filter-topic" name="topic" defaultValue={searchParams.get('topic') || ''}>
            {renderOptions(fo.topics, searchParams.get('topic') || '', 'All topics')}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="filter-source-agent">Source Agent</label>
          <select id="filter-source-agent" name="sourceAgent" defaultValue={searchParams.get('sourceAgent') || ''}>
            {renderOptions(fo.sourceAgents, searchParams.get('sourceAgent') || '', 'All agents')}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="filter-state">Derived State</label>
          <select id="filter-state" name="state" defaultValue={searchParams.get('state') || ''}>
            <option value="">All states</option>
            {['active', 'blocked', 'stale', 'expired', 'done', 'cancelled', 'done-suspect'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="filter-task-state">Task State</label>
          <select id="filter-task-state" name="taskState" defaultValue={searchParams.get('taskState') || ''}>
            <option value="">All task states</option>
            {fo.taskStates.map((state) => (
              <option key={state} value={state}>{state}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="filter-health-state">Health</label>
          <select id="filter-health-state" name="healthState" defaultValue={searchParams.get('healthState') || ''}>
            <option value="">All health states</option>
            {fo.healthStates.map((state) => (
              <option key={state} value={state}>{state}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="filter-sort">Sort</label>
          <select id="filter-sort" name="sort" defaultValue={searchParams.get('sort') || 'updated'}>
            {renderOptions(fo.sorts, searchParams.get('sort') || 'updated', 'Sort by')}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="filter-page-size">Page Size</label>
          <select id="filter-page-size" name="pageSize" defaultValue={searchParams.get('pageSize') || '10'}>
            {fo.pageSizes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="toolbar-actions">
          <button type="submit">Apply</button>
          <button type="button" className="secondary" onClick={handleReset}>
            Reset
          </button>
        </div>
      </form>
      {activeFilters.length > 0 && (
        <div className="filter-summary">
          {activeFilters.map((f, i) => (
            <span key={i} className="filter-chip">
              {f}
            </span>
          ))}
        </div>
      )}
    </details>
  );
}
