import { useCallback, useRef, useState, useMemo } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AgentPalette } from './AgentPalette';
import { AgentNode, type AgentNodeData } from './AgentNode';
import { useAgentCatalog } from '../../hooks/useData';
import { useToast } from '../../App';
import type { CatalogSkill, CatalogPlatform } from '../../types';

const STORAGE_KEY = 'workflow-designer-v1';
const nodeTypes: NodeTypes = { agent: AgentNode };

interface DragData {
  skillId: string;
  platformId: string;
}

/* ── Guided orchestration types ────────────────────────────── */

type StepStatus = 'pending' | 'active' | 'done';

interface GuidedStep {
  nodeId: string;
  stepNumber: number;
  skill: CatalogSkill;
  platform: CatalogPlatform;
  status: StepStatus;
  downstream: string[];
}

/* ── Topological sort for deploy ───────────────────────────── */

function topoSort(
  nodes: Node<AgentNodeData>[],
  edges: Edge[],
): { ordered: Node<AgentNodeData>[]; adjacency: Map<string, string[]> } {
  const dataMap = new Map(nodes.map((n) => [n.id, n]));
  const targets = new Set(edges.map((e) => e.target));
  const startNodes = nodes.filter((n) => !targets.has(n.id));
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.source) || [];
    list.push(edge.target);
    adjacency.set(edge.source, list);
  }

  const ordered: Node<AgentNodeData>[] = [];
  const visited = new Set<string>();

  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const node = dataMap.get(id);
    if (node) ordered.push(node);
    for (const next of adjacency.get(id) || []) visit(next);
  }

  for (const start of startNodes) visit(start.id);
  for (const node of nodes) visit(node.id);

  return { ordered, adjacency };
}

/* ── Main canvas ───────────────────────────────────────────── */

function WorkflowCanvas() {
  const { data: catalog } = useAgentCatalog();
  const toast = useToast();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [showGuidance, setShowGuidance] = useState(false);
  const [guidedSteps, setGuidedSteps] = useState<GuidedStep[]>([]);
  const stepCounter = useRef(0);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<AgentNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Build lookup maps for quick skill/platform access
  const lookup = useMemo(() => {
    const skillMap = new Map<string, { skill: CatalogSkill; platform: CatalogPlatform }>();
    if (!catalog) return skillMap;
    for (const platform of catalog.platforms) {
      for (const skill of platform.skills) {
        const key = `${platform.id}:${skill.id}`;
        skillMap.set(key, { skill, platform });
      }
    }
    return skillMap;
  }, [catalog]);

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge({ ...params, animated: true }, eds)),
    [setEdges],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const raw = e.dataTransfer.getData('application/json');
      if (!raw) return;
      let drag: DragData;
      try {
        drag = JSON.parse(raw);
      } catch {
        return;
      }
      const entry = lookup.get(`${drag.platformId}:${drag.skillId}`);
      if (!entry) return;

      const bounds = wrapperRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const x = e.clientX - bounds.left - 110;
      const y = e.clientY - bounds.top - 40;

      stepCounter.current += 1;
      const nodeData: AgentNodeData = {
        skill: entry.skill,
        platform: entry.platform,
        label: entry.skill.name,
        step: stepCounter.current,
      };
      const newNode: Node<AgentNodeData> = {
        id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'agent',
        position: { x, y },
        data: nodeData,
      };
      setNodes((nds) => [...nds, newNode]);
      toast('success', `Added: ${entry.skill.name}`);
    },
    [lookup, setNodes, toast],
  );

  const saveWorkflow = useCallback(() => {
    const data = {
      nodes: nodes.map((n) => ({ ...n, data: { ...n.data, step: n.data.step } })),
      edges,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    toast('success', `Saved ${nodes.length} steps`);
  }, [nodes, edges, toast]);

  const loadWorkflow = useCallback(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      toast('info', 'No saved workflow found');
      return;
    }
    try {
      const data = JSON.parse(raw);
      setNodes(data.nodes || []);
      setEdges(data.edges || []);
      stepCounter.current = (data.nodes || []).length;
      toast('success', `Loaded ${data.nodes?.length || 0} steps`);
    } catch {
      toast('error', 'Failed to load workflow');
    }
  }, [setNodes, setEdges, toast]);

  const clearWorkflow = useCallback(() => {
    setNodes([]);
    setEdges([]);
    stepCounter.current = 0;
    setGuidedSteps([]);
    setShowGuidance(false);
    toast('info', 'Canvas cleared');
  }, [setNodes, setEdges, toast]);

  /* ── Deploy: build guided step list ── */

  const deploy = useCallback(() => {
    if (nodes.length === 0) {
      toast('info', 'Add at least one step before deploying');
      return;
    }
    const { ordered, adjacency } = topoSort(nodes, edges);
    const steps: GuidedStep[] = ordered.map((node, i) => ({
      nodeId: node.id,
      stepNumber: i + 1,
      skill: node.data.skill,
      platform: node.data.platform,
      status: i === 0 ? 'active' : 'pending',
      downstream: adjacency.get(node.id) || [],
    }));
    setGuidedSteps(steps);
    setShowGuidance(true);
    toast('success', `Deployed ${steps.length} guided step${steps.length > 1 ? 's' : ''}`);
  }, [nodes, edges, toast]);

  /* ── Mark step complete, activate downstream ── */

  const completeStep = useCallback(
    (nodeId: string) => {
      setGuidedSteps((prev) => {
        const updated = prev.map((s) =>
          s.nodeId === nodeId ? { ...s, status: 'done' as StepStatus } : s,
        );
        // Activate downstream steps whose all upstream are done
        const doneIds = new Set(updated.filter((s) => s.status === 'done').map((s) => s.nodeId));
        for (const step of updated) {
          if (step.status !== 'pending') continue;
          const upstream = edges.filter((e) => e.target === step.nodeId).map((e) => e.source);
          const allDone = upstream.length === 0 || upstream.every((id) => doneIds.has(id));
          if (allDone) step.status = 'active';
        }
        return [...updated];
      });
    },
    [edges],
  );

  const resetGuidance = useCallback(() => {
    setGuidedSteps((prev) =>
      prev.map((s, i) => ({ ...s, status: (i === 0 ? 'active' : 'pending') as StepStatus })),
    );
  }, []);

  const doneCount = guidedSteps.filter((s) => s.status === 'done').length;
  const activeCount = guidedSteps.filter((s) => s.status === 'active').length;

  return (
    <div className="rf-workflow">
      <div className="rf-layout">
        <AgentPalette catalog={catalog} />

        <div className="rf-canvas-area" ref={wrapperRef}>
          <div className="rf-toolbar">
            <button type="button" className="secondary" onClick={saveWorkflow}>
              Save
            </button>
            <button type="button" className="secondary" onClick={loadWorkflow}>
              Load
            </button>
            <button
              type="button"
              className={showGuidance ? 'rf-btn-deploy rf-btn-deploy-active' : 'rf-btn-deploy'}
              onClick={deploy}
            >
              {'\u25B6'} Deploy
            </button>
            <button type="button" className="secondary" onClick={clearWorkflow}>
              Clear
            </button>
            <div className="rf-toolbar-info">
              {nodes.length} steps {'\u00B7'} {edges.length} connections
            </div>
          </div>

          <div className="rf-canvas-wrapper" onDrop={onDrop} onDragOver={onDragOver}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              nodeTypes={nodeTypes}
              fitView
              className="rf-flow"
              deleteKeyCode={['Backspace', 'Delete']}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
              <Controls />
              <MiniMap
                nodeColor={(n) => {
                  const data = n.data as unknown as AgentNodeData;
                  return data?.platform?.color || '#5B9CF6';
                }}
                className="rf-minimap"
                maskColor="rgba(0,0,0,0.4)"
              />
            </ReactFlow>

            {nodes.length === 0 && (
              <div className="rf-canvas-hint">
                <div className="rf-canvas-hint-icon">{'\u2191'}</div>
                <p>Drag a skill from the agent catalog on the left to start building a workflow.</p>
              </div>
            )}
          </div>

          {showGuidance && (
            <GuidancePanel
              steps={guidedSteps}
              doneCount={doneCount}
              activeCount={activeCount}
              onComplete={completeStep}
              onReset={resetGuidance}
              onClose={() => setShowGuidance(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Guidance panel ────────────────────────────────────────── */

function GuidancePanel({
  steps,
  doneCount,
  activeCount,
  onComplete,
  onReset,
  onClose,
}: {
  steps: GuidedStep[];
  doneCount: number;
  activeCount: number;
  onComplete: (nodeId: string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const allDone = doneCount === steps.length;
  const pct = steps.length > 0 ? Math.round((doneCount / steps.length) * 100) : 0;

  return (
    <div className="rf-guidance-panel">
      <div className="rf-guidance-header">
        <h3>
          {'\uD83D\uDE4F'} Guided Orchestration
          <span className="rf-guidance-progress">
            {doneCount}/{steps.length} done
          </span>
        </h3>
        <div className="rf-guidance-actions">
          <button type="button" className="secondary" onClick={onReset}>
            Reset
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      <div className="rf-guidance-bar">
        <div className="rf-guidance-bar-fill" style={{ width: `${pct}%` }} />
      </div>

      {allDone && (
        <div className="rf-guidance-complete">
          {'\u2705'} All steps complete! Check the handoff board for results.
        </div>
      )}

      <div className="rf-guidance-steps">
        {steps.map((step) => (
          <GuidanceStepCard key={step.nodeId} step={step} onComplete={onComplete} />
        ))}
      </div>
    </div>
  );
}

/* ── Individual guidance card ──────────────────────────────── */

function GuidanceStepCard({
  step,
  onComplete,
}: {
  step: GuidedStep;
  onComplete: (nodeId: string) => void;
}) {
  const isAuto = step.platform.cliCallable;
  const statusCls = `rf-guide-card rf-guide-${step.status}`;
  const icon = step.status === 'done' ? '\u2705'
    : step.status === 'active' ? '\u25B6\uFE0F'
    : '\u23F3';

  return (
    <div
      className={statusCls}
      style={{
        // @ts-expect-error CSS custom property
        '--pf-color': step.platform.color,
      }}
    >
      <div className="rf-guide-card-header">
        <span className="rf-guide-card-status">{icon}</span>
        <span className="rf-guide-card-step">Step {step.stepNumber}</span>
        <span className="rf-guide-card-icon" style={{ color: step.platform.color }}>
          {step.platform.icon}
        </span>
        <span className="rf-guide-card-platform">{step.platform.label}</span>
        <span className={`rf-guide-mode rf-guide-mode-${isAuto ? 'auto' : 'manual'}`}>
          {isAuto ? '\uD83D\uDD27 CLI' : '\u270B Manual'}
        </span>
      </div>

      <div className="rf-guide-card-body">
        <div className="rf-guide-card-skill">{step.skill.name}</div>
        <p className="rf-guide-card-desc">{step.skill.description}</p>

        {step.status === 'active' && (
          <div className="rf-guide-instruction">
            {isAuto ? (
              <>
                <strong>{'\uD83D\uDD27'} Auto:</strong> Run in terminal &mdash;
                use <code>{step.platform.id}</code> CLI with the{' '}
                <code>{step.skill.skillName}</code> skill, then publish the conclusion via
                the handoff MCP.
              </>
            ) : (
              <>
                <strong>{'\u270B'} Manual:</strong> Open <strong>{step.platform.label}</strong>{' '}
                and execute the <code>{step.skill.skillName}</code> skill.
                After finishing, publish your conclusion through the handoff MCP &mdash;
                the Board will light up the next step.
              </>
            )}
          </div>
        )}
      </div>

      {step.status === 'active' && (
        <button
          type="button"
          className="rf-guide-complete-btn"
          onClick={() => onComplete(step.nodeId)}
        >
          {'\u2705'} Mark Complete
        </button>
      )}
    </div>
  );
}

export default function WorkflowPage() {
  return (
    <ReactFlowProvider>
      <WorkflowCanvas />
    </ReactFlowProvider>
  );
}
