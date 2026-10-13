export function deriveBoardState({ health, service }) {
  if (health?.ok) return { state: 'running', detail: 'Board is running' };
  if (service?.installed && service?.running) return { state: 'starting', detail: 'Board service is starting' };
  if (service?.installed) return { state: 'error', detail: 'Board service is installed but unhealthy' };
  return { state: 'stopped', detail: 'Board service is not installed' };
}
