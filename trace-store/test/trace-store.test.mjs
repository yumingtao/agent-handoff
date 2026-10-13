import test from 'node:test';
import assert from 'node:assert/strict';
import { TraceStore } from '../src/trace-store.mjs';
import { renderDashboard } from '../src/dashboard.mjs';

test('stores a complete redacted workflow trace', () => {
  const store = new TraceStore();
  const runId = store.createRun({
    capabilityId: 'code-review-panel',
    actor: 'engineer',
    metadata: {
      apiToken: 'secret',
      handoff: {
        project: 'my-repo',
        workspace: '/tmp/ws',
        topic: 'handoff-board',
        logical_topic_id: 'topic-1',
      },
    },
  });
  const spanId = store.startSpan({ runId, kind: 'agent', name: 'correctness', attributes: { authorization: 'Bearer abc' } });
  store.recordToolCall({ runId, spanId, tool: 'git.diff', effect: 'read', decision: 'allow', outcome: 'ok' });
  store.recordPolicyDecision({ runId, actor: 'correctness', tool: 'git.diff', effect: 'read', decision: 'allow' });
  store.endSpan(spanId, 'ok');
  store.recordHumanGate({ runId, gate: 'review-verdict', verdict: 'approved', decidedBy: 'engineer' });
  store.finishRun(runId);

  const run = store.getRun(runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.metadata.apiToken, '[REDACTED]');
  assert.equal(run.spans.length, 1);
  assert.equal(run.toolCalls[0].tool, 'git.diff');
  assert.equal(run.policyDecisions[0].decision, 'allow');
  assert.equal(run.humanGates[0].verdict, 'approved');
  const metrics = store.metrics();
  assert.equal(metrics.runs.byStatus.completed, 1);
  assert.equal(metrics.agents.total, 1);
  const topicLinks = store.listRunTopicsByLogicalTopic('topic-1');
  assert.equal(topicLinks.length, 1);
  assert.equal(topicLinks[0].run_id, runId);
  assert.equal(topicLinks[0].topic_raw, 'handoff-board');
  assert.match(renderDashboard(metrics, store.listRuns()), /Governed multi-agent traces/);
  assert.equal(store.pruneBefore('9999-01-01T00:00:00.000Z'), 1);
  assert.equal(store.getRun(runId), null);
  store.close();
});
