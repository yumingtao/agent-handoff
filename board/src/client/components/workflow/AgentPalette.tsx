import { useState, useMemo } from 'react';
import type { AgentCatalog, CatalogPlatform, CatalogSkill } from '../../types';

interface Props {
  catalog: AgentCatalog | undefined;
}

export function AgentPalette({ catalog }: Props) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const platforms = useMemo(() => {
    if (!catalog) return [];
    if (!query.trim()) return catalog.platforms;
    const q = query.toLowerCase();
    return catalog.platforms
      .map((p) => ({
        ...p,
        skills: p.skills.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            s.skillName.toLowerCase().includes(q),
        ),
      }))
      .filter((p) => p.skills.length > 0);
  }, [catalog, query]);

  function togglePlatform(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const totalSkills = catalog?.platforms.reduce((acc, p) => acc + p.skillCount, 0) ?? 0;

  return (
    <div className="rf-palette">
      <div className="rf-palette-header">
        <h3>Agent Catalog</h3>
        <div className="rf-palette-count">
          {catalog ? `${catalog.platforms.length} platforms \u00B7 ${totalSkills} skills` : 'Loading\u2026'}
        </div>
      </div>

      <input
        className="rf-palette-search"
        type="text"
        placeholder="Search skills\u2026"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="rf-palette-list">
        {platforms.map((platform) => (
          <PlatformGroup
            key={platform.id}
            platform={platform}
            expanded={expanded.has(platform.id)}
            onToggle={() => togglePlatform(platform.id)}
          />
        ))}
        {platforms.length === 0 && query.trim() && (
          <div className="rf-palette-empty">No skills match &ldquo;{query}&rdquo;</div>
        )}
      </div>
    </div>
  );
}

function PlatformGroup({
  platform,
  expanded,
  onToggle,
}: {
  platform: CatalogPlatform;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rf-palette-group">
      <button
        type="button"
        className="rf-palette-group-header"
        onClick={onToggle}
        style={{ borderLeftColor: platform.color }}
      >
        <span className="rf-palette-group-icon" style={{ color: platform.color }}>
          {platform.icon}
        </span>
        <span className="rf-palette-group-label">{platform.label}</span>
        <span
          className={`rf-palette-mode rf-palette-mode-${platform.cliCallable ? 'auto' : 'manual'}`}
          title={platform.cliCallable ? 'CLI auto-executable' : 'Desktop app (manual)'}
        >
          {platform.cliCallable ? '\uD83D\uDD27' : '\u270B'}
        </span>
        <span className="rf-palette-group-count">{platform.skillCount}</span>
        <span className={`rf-palette-chevron ${expanded ? 'rf-palette-chevron-open' : ''}`}>
          {'\u25B8'}
        </span>
      </button>
      {expanded && (
        <div className="rf-palette-skills">
          {platform.skills.map((skill) => (
            <PaletteSkillCard key={skill.id} skill={skill} platform={platform} />
          ))}
        </div>
      )}
    </div>
  );
}

function PaletteSkillCard({
  skill,
  platform,
}: {
  skill: CatalogSkill;
  platform: CatalogPlatform;
}) {
  function onDragStart(e: React.DragEvent) {
    e.dataTransfer.setData(
      'application/json',
      JSON.stringify({ skillId: skill.id, platformId: platform.id }),
    );
    e.dataTransfer.effectAllowed = 'move';
  }

  const seText = skill.sideEffects === 'read' ? 'read-only' : skill.sideEffects;

  return (
    <div
      className="rf-palette-skill"
      draggable
      onDragStart={onDragStart}
      title={`Drag to canvas: ${skill.name} (${platform.label})`}
    >
      <div className="rf-palette-skill-name">{skill.name}</div>
      <div className="rf-palette-skill-desc">{skill.description}</div>
      <div className="rf-palette-skill-tags">
        <span className="rf-node-badge rf-node-badge-muted">{seText}</span>
        {skill.scope && skill.scope !== 'general' && (
          <span className="rf-node-badge rf-node-badge-muted">{skill.scope}</span>
        )}
      </div>
    </div>
  );
}
