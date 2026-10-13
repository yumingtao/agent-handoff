import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchJSON, postForm } from '../../net/client';
import { useToast } from '../../App';
import type { HealthData } from '../../types';

export default function OpsView() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [flash, setFlash] = useState<{ op: string; result: any } | null>(null);

  const { data: health } = useQuery({
    queryKey: ['ops', 'health'],
    queryFn: () => fetchJSON<HealthData>('/ops/health'),
  });

  const backupMut = useMutation({
    mutationFn: (label: string) => postForm<{ ok: boolean; result: any }>('/ops/backup', { label }),
    onSuccess: (data) => {
      setFlash({ op: 'backup', result: data.result });
      toast('success', 'Backup completed');
      queryClient.invalidateQueries();
    },
    onError: (err) => {
      toast('error', `Backup failed: ${err.message}`);
    },
  });

  const cleanupMut = useMutation({
    mutationFn: ({ before, status }: { before: string; status: string }) =>
      postForm<{ ok: boolean; result: any }>('/ops/cleanup-preview', { before, status }),
    onSuccess: (data) => {
      setFlash({ op: 'cleanup-preview', result: data.result });
      toast('info', 'Cleanup preview ready');
    },
    onError: (err) => {
      toast('error', `Cleanup preview failed: ${err.message}`);
    },
  });

  const publishMut = useMutation({
    mutationFn: (data: Record<string, string>) =>
      postForm<{ ok: boolean; result: any }>('/ops/publish-event', data),
    onSuccess: () => {
      toast('success', 'Event published');
      queryClient.invalidateQueries();
    },
    onError: (err) => {
      toast('error', `Publish failed: ${err.message}`);
    },
  });

  return (
    <>
      <section className="hero">
        <div>
          <h1>Ops</h1>
          <div className="hero-copy">
            Maintenance-only tools. Keep them out of the main reading flow unless you are
            troubleshooting or cleaning local storage.
          </div>
        </div>
      </section>

      <section className="section">
        <div className="ops-grid">
          {/* Backup */}
          <form
            className="ops-card"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              backupMut.mutate((fd.get('label') as string) || '');
            }}
          >
            <div className="ops-card-header">
              <strong>Backup storage</strong>
            </div>
            <div className="small muted">
              Create a local snapshot of the DB and JSON fallback files.
            </div>
            <div className="toolbar">
              <input type="text" name="label" placeholder="Optional label" />
              <button type="submit" disabled={backupMut.isPending}>
                {backupMut.isPending ? 'Running...' : 'Run backup'}
              </button>
            </div>
          </form>

          {/* Cleanup Preview */}
          <form
            className="ops-card"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              cleanupMut.mutate({
                before: (fd.get('before') as string) || '',
                status: (fd.get('status') as string) || 'superseded,archived',
              });
            }}
          >
            <div className="ops-card-header">
              <strong>Cleanup preview</strong>
            </div>
            <div className="small muted">
              Dry-run only. Shows old superseded or archived records before the selected time.
            </div>
            <div className="toolbar">
              <input type="datetime-local" name="before" id="cleanup-before" />
              <select name="status" defaultValue="superseded,archived">
                <option value="superseded,archived">superseded,archived</option>
                <option value="superseded">superseded</option>
                <option value="archived">archived</option>
              </select>
              <button type="submit" className="secondary" disabled={cleanupMut.isPending}>
                {cleanupMut.isPending ? 'Previewing...' : 'Preview cleanup'}
              </button>
            </div>
          </form>

          {/* Publish Event */}
          <form
            className="ops-card"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              publishMut.mutate(Object.fromEntries(fd.entries()) as Record<string, string>);
            }}
          >
            <div className="ops-card-header">
              <strong>Publish agent event</strong>
            </div>
            <div className="small muted">
              Record claim, progress, block, release, or heartbeat without editing handoff
              conclusions.
            </div>
            <div className="toolbar">
              <div className="field">
                <span className="field-label">Project</span>
                <input type="text" name="project" required placeholder="project" />
              </div>
              <div className="field">
                <span className="field-label">Workspace</span>
                <input type="text" name="workspace" placeholder="optional" />
              </div>
              <div className="field">
                <span className="field-label">Topic</span>
                <input type="text" name="topic" required placeholder="topic" />
              </div>
              <div className="field">
                <span className="field-label">Agent</span>
                <input type="text" name="agent" required placeholder="agent" />
              </div>
              <div className="field">
                <span className="field-label">Event</span>
                <select name="eventType" defaultValue="task_claimed">
                  <option value="task_claimed">task_claimed</option>
                  <option value="task_progress">task_progress</option>
                  <option value="task_blocked">task_blocked</option>
                  <option value="task_released">task_released</option>
                  <option value="agent_heartbeat">agent_heartbeat</option>
                </select>
              </div>
            </div>
            <textarea name="payload" rows={3} placeholder='{"note":"optional"}' />
            <div className="toolbar">
              <button type="submit" disabled={publishMut.isPending}>
                {publishMut.isPending ? 'Publishing...' : 'Publish event'}
              </button>
            </div>
          </form>

          {/* Health */}
          <details className="ops-card">
            <summary>Health</summary>
            <pre className="json-box">{JSON.stringify(health, null, 2)}</pre>
          </details>

          {/* Flash */}
          {flash && (
            <details open className="ops-card ops-flash">
              <summary>Last operation</summary>
              <pre className="json-box">{JSON.stringify(flash, null, 2)}</pre>
            </details>
          )}
        </div>
      </section>
    </>
  );
}
