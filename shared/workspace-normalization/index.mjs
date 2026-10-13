import { basename } from 'node:path';

// Canonical workspaces are configured through an environment variable instead
// of a hard-coded project map, so any project can opt in:
//
//   AGENT_HANDOFF_CANONICAL_WORKSPACES='{"my-repo":"/abs/path/to/my-repo"}'
//
// Multiple entries are allowed. Relative values are resolved lazily by the
// caller environment; store absolute paths here. Invalid JSON falls back to an
// empty map (normalization then becomes a pass-through).
function loadCanonicalWorkspaces() {
  const raw = process.env.AGENT_HANDOFF_CANONICAL_WORKSPACES;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const map = {};
    for (const [project, path] of Object.entries(parsed)) {
      if (typeof project === 'string' && project && typeof path === 'string' && path) {
        map[project] = path;
      }
    }
    return map;
  } catch {
    return {};
  }
}

export const CANONICAL_WORKSPACES = loadCanonicalWorkspaces();

export function normalizeWorkspace(project, workspace) {
  const canonical = CANONICAL_WORKSPACES[project];
  if (!canonical) return workspace || null;
  if (!workspace) return canonical;
  const value = workspace.trim();
  if (!value || value === project || value === basename(canonical) || value === canonical) {
    return canonical;
  }
  return value;
}

export function workspaceIdentityCandidates(project, workspace) {
  const normalized = normalizeWorkspace(project, workspace);
  const canonical = CANONICAL_WORKSPACES[project];
  if (!canonical) return [normalized];

  const raw = workspace?.trim() || null;
  const isCanonicalAlias = !raw || raw === project || raw === basename(canonical) || raw === canonical;
  if (!isCanonicalAlias) return [normalized];

  return [...new Set([normalized, raw, canonical, project, basename(canonical)].filter(Boolean))];
}

export function isCanonicalWorkspaceProject(project) {
  return Boolean(CANONICAL_WORKSPACES[project]);
}
