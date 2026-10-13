import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { CatalogSkill, CatalogPlatform } from '../../types';

export interface AgentNodeData {
  skill: CatalogSkill;
  platform: CatalogPlatform;
  label: string;
  step: number;
  [key: string]: unknown;
}

function sideEffectBadge(se: string): { text: string; cls: string } {
  if (se === 'read') return { text: 'read-only', cls: 'rf-node-badge-info' };
  if (se === 'write' || se === 'none') return { text: se, cls: 'rf-node-badge-ok' };
  return { text: se, cls: 'rf-node-badge-muted' };
}

function AgentNodeInner({ data }: { data: AgentNodeData }) {
  const { skill, platform, step } = data;
  const se = sideEffectBadge(skill.sideEffects);
  const mode = platform.cliCallable ? 'auto' : 'manual';

  return (
    <div
      className="rf-agent-node"
      style={{
        // @ts-expect-error CSS custom property
        '--pf-color': platform.color,
      }}
    >
      <Handle type="target" position={Position.Left} className="rf-handle rf-handle-left" />

      <div className="rf-node-header">
        <span className="rf-node-step">{step}</span>
        <span className="rf-node-icon" style={{ color: platform.color }}>
          {platform.icon}
        </span>
        <div className="rf-node-titles">
          <div className="rf-node-skill">{skill.name}</div>
          <div className="rf-node-platform">{platform.label}</div>
        </div>
        <span
          className={`rf-node-mode rf-node-mode-${mode}`}
          title={mode === 'auto' ? 'CLI auto-executable' : 'Desktop app (manual)'}
        >
          {mode === 'auto' ? '\uD83D\uDD27' : '\u270B'}
        </span>
      </div>

      <p className="rf-node-desc">{skill.description}</p>

      <div className="rf-node-tags">
        <span className={`rf-node-badge ${se.cls}`}>{se.text}</span>
        {skill.scope && skill.scope !== 'general' && (
          <span className="rf-node-badge rf-node-badge-muted">{skill.scope}</span>
        )}
      </div>

      <Handle type="source" position={Position.Right} className="rf-handle rf-handle-right" />
    </div>
  );
}

export const AgentNode = memo(AgentNodeInner);
