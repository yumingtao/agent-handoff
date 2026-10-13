const SENSITIVE_KEY = /(authorization|cookie|token|secret|password|api[-_]?key|private[-_]?key)/iu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;

export function redact(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.replace(BEARER, 'Bearer [REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(child)]));
  }
  return value;
}

export function safeJson(value) {
  return JSON.stringify(redact(value ?? {}));
}
