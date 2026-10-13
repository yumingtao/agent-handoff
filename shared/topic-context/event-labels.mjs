export const EVENT_TYPE_LABELS = {
  agent_heartbeat: 'Agent heartbeat',
  task_claimed: 'Task claimed',
  task_released: 'Task released',
  task_blocked: 'Task blocked',
  task_completed: 'Task completed',
  task_started: 'Task started',
  task_failed: 'Task failed',
  review_requested: 'Review requested',
  review_approved: 'Review approved',
  review_rejected: 'Review rejected',
  deploy_started: 'Deploy started',
  deploy_succeeded: 'Deploy succeeded',
  deploy_failed: 'Deploy failed',
  handoff_published: 'Handoff published',
  handoff_superseded: 'Handoff superseded',
  warning: 'Warning',
  error: 'Error',
};

export function labelEventType(eventType) {
  if (!eventType) return 'Event';
  return EVENT_TYPE_LABELS[eventType]
    || eventType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
