import { useMemo } from 'react';
import type { WorkflowGraph, WorkflowGraphNode } from '../../types';

const LABEL_WIDTH = 180;
const LANE_HEADER_H = 26;
const SUBLANE_H = 38;
const PADDING_X = 24;
const PADDING_Y = 16;
const MIN_CHART_W = 480;
const NODE_R = 7;

const KIND_COLORS: Record<string, string> = {
  handoff: 'var(--accent-purple)',
  event: 'var(--accent-green)',
  trace: 'var(--accent-amber)',
};

function timeToX(at: string, minMs: number, spanMs: number, chartW: number): number {
  if (spanMs <= 0) return chartW / 2;
  const t = new Date(at).getTime();
  const ratio = (t - minMs) / spanMs;
  return PADDING_X + ratio * (chartW - 2 * PADDING_X);
}

interface SubLaneRow {
  laneIndex: number;
  subLaneIndex: number;
  agent: string;
  model: string;
  modelDisplay: string;
  isLegacy: boolean;
  nodes: WorkflowGraphNode[];
}

export function WorkflowFlowDiagram({
  graph,
  onNodeClick,
}: {
  graph: WorkflowGraph;
  onNodeClick?: (timelineKey: string) => void;
}) {
  const layout = useMemo(() => {
    const lanes = graph.lanes || [];

    // Flatten into rows for rendering
    const rows: SubLaneRow[] = [];
    for (let li = 0; li < lanes.length; li++) {
      const lane = lanes[li];
      for (let si = 0; si < lane.subLanes.length; si++) {
        const sub = lane.subLanes[si];
        rows.push({
          laneIndex: li,
          subLaneIndex: si,
          agent: lane.agent,
          model: sub.model,
          modelDisplay: sub.modelDisplay || sub.model,
          isLegacy: sub.isLegacy,
          nodes: sub.nodes,
        });
      }
    }

    const minMs = graph.minTime ? new Date(graph.minTime).getTime() : 0;
    const maxMs = graph.maxTime ? new Date(graph.maxTime).getTime() : 0;
    const spanMs = Math.max(1, maxMs - minMs);

    // Chart width grows with node count
    const maxNodesInRow = Math.max(1, ...rows.map((r) => r.nodes.length));
    const chartW = Math.max(MIN_CHART_W, maxNodesInRow * 28 + 2 * PADDING_X);

    const totalH = PADDING_Y * 2 + rows.length * SUBLANE_H + lanes.length * LANE_HEADER_H;

    // Compute Y for each row
    let cursorY = PADDING_Y;
    const rowYs: number[] = [];
    const laneHeaderYs: number[] = [];
    let lastLaneIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].laneIndex !== lastLaneIndex) {
        laneHeaderYs[rows[i].laneIndex] = cursorY;
        cursorY += LANE_HEADER_H;
        lastLaneIndex = rows[i].laneIndex;
      }
      rowYs[i] = cursorY + SUBLANE_H / 2;
      cursorY += SUBLANE_H;
    }

    return { rows, chartW, totalH, minMs, spanMs, rowYs, laneHeaderYs };
  }, [graph]);

  if (!graph.lanes?.length || graph.nodeCount === 0) {
    return (
      <div className="wfd-empty muted">
        No workflow activity in the loaded window.
      </div>
    );
  }

  const { rows, chartW, totalH, minMs, spanMs, rowYs, laneHeaderYs } = layout;

  // Collect unique lane indices for header rendering
  const laneHeaders = rows
    .map((r) => r.laneIndex)
    .filter((v, i, arr) => arr.indexOf(v) === i);

  return (
    <div className="wfd-container">
      <div className="wfd-header">
        <span className="wfd-title">Workflow swimlanes</span>
        <span className="wfd-note muted">{graph.windowNote}</span>
      </div>
      <div className="wfd-scroll">
        <svg
          width={LABEL_WIDTH + chartW}
          height={totalH}
          className="wfd-svg"
          role="img"
          aria-label="Workflow swimlane diagram"
        >
          {/* Lane headers */}
          {laneHeaders.map((li) => {
            const lane = graph.lanes[li];
            const headerY = laneHeaderYs[li];
            // Count total rows under this lane to get total height
            const subCount = lane.subLanes.length;
            const laneH = LANE_HEADER_H + subCount * SUBLANE_H;
            return (
              <g key={`lane-${li}`}>
                <rect
                  x={0}
                  y={headerY}
                  width={LABEL_WIDTH + chartW}
                  height={laneH}
                  fill={li % 2 === 0 ? 'var(--bg-raised)' : 'var(--bg-base)'}
                  opacity={0.5}
                />
                <text
                  x={12}
                  y={headerY + LANE_HEADER_H / 2 + 4}
                  className="wfd-lane-label"
                >
                  {lane.agent}
                </text>
                <line
                  x1={0}
                  y1={headerY}
                  x2={LABEL_WIDTH + chartW}
                  y2={headerY}
                  className="wfd-lane-sep"
                />
              </g>
            );
          })}

          {/* Label column separator */}
          <line
            x1={LABEL_WIDTH}
            y1={0}
            x2={LABEL_WIDTH}
            y2={totalH}
            className="wfd-label-sep"
          />

          {/* Sub-lane labels */}
          {rows.map((row, i) => {
            const maxLen = 22;
            const full = row.isLegacy ? 'legacy/unknown' : row.modelDisplay;
            const truncated = full.length > maxLen ? full.slice(0, maxLen - 1) + '\u2026' : full;
            return (
              <text
                key={`sublabel-${i}`}
                x={LABEL_WIDTH - 12}
                y={rowYs[i] + 4}
                textAnchor="end"
                className={`wfd-sublabel ${row.isLegacy ? 'wfd-sublabel-legacy' : ''}`}
              >
                {truncated}
                {truncated !== full && <title>{full}</title>}
              </text>
            );
          })}

          {/* Sub-lane center lines */}
          {rows.map((row, i) => (
            <line
              key={`line-${i}`}
              x1={LABEL_WIDTH}
              y1={rowYs[i]}
              x2={LABEL_WIDTH + chartW}
              y2={rowYs[i]}
              className="wfd-row-line"
            />
          ))}

          {/* Nodes */}
          {rows.map((row, ri) =>
            row.nodes.map((node, ni) => {
              const x = LABEL_WIDTH + timeToX(node.at, minMs, spanMs, chartW);
              const y = rowYs[ri];
              const color = KIND_COLORS[node.kind] || 'var(--accent-blue)';
              return (
                <g
                  key={`node-${node.timelineKey}`}
                  className="wfd-node-group"
                  onClick={() => onNodeClick?.(node.timelineKey)}
                >
                  <circle
                    cx={x}
                    cy={y}
                    r={NODE_R}
                    fill={color}
                    className="wfd-node-circle"
                  />
                  <title>{node.title} [{node.kind}: {node.id}] — {node.at}</title>
                </g>
              );
            }),
          )}

          {/* Bottom separator */}
          <line
            x1={0}
            y1={totalH - 1}
            x2={LABEL_WIDTH + chartW}
            y2={totalH - 1}
            className="wfd-lane-sep"
          />
        </svg>
      </div>
      <div className="wfd-legend">
        <span className="wfd-legend-item">
          <span className="wfd-legend-dot" style={{ background: KIND_COLORS.handoff }} />
          handoff
        </span>
        <span className="wfd-legend-item">
          <span className="wfd-legend-dot" style={{ background: KIND_COLORS.event }} />
          event
        </span>
        <span className="wfd-legend-item">
          <span className="wfd-legend-dot" style={{ background: KIND_COLORS.trace }} />
          trace
        </span>
      </div>
    </div>
  );
}
