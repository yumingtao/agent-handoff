export function assertNoSecrets(input: unknown): void {
  const text = JSON.stringify(input);
  const checks: Array<[RegExp, string]> = [
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i, "Bearer token"],
    [/\b(cookie|set-cookie)\s*[:=]\s*[^;\n]{12,}/i, "cookie"],
    [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i, "private key"],
    [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
    [/\bASIA[0-9A-Z]{16}\b/, "AWS session key"],
    [/\bgh[pousr]_[A-Za-z0-9_]{30,}\b/, "GitHub token"],
    [/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd)\b\s*[:=]\s*["']?[^"',\s]{12,}/i, "secret-like key/value"],
  ];

  for (const [pattern, label] of checks) {
    if (pattern.test(text)) {
      throw new Error(`Refusing to write handoff because it appears to contain a ${label}. Remove or redact the secret and try again.`);
    }
  }
}

export function assertCleanConclusion(value: string): void {
  const trailingToolCallResidue = /(?:<\/parameter>\s*<\/invoke>|<\/invoke>\s*<\/parameter>)\s*$/i;
  if (trailingToolCallResidue.test(value)) {
    throw new Error("Refusing to write conclusion containing tool-call serialization residue such as </parameter> or </invoke>. Remove the residue and submit once; do not retry blindly.");
  }
}
