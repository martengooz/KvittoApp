const SECRET_KEY_PATTERN = /(token|secret|api[_-]?key|authorization|cookie|password)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > 0 ? '[REDACTED]' : '';
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }
  if (isRecord(value)) {
    return redactDiagnostics(value);
  }
  return '[REDACTED]';
}

export function redactDiagnostics(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = redactValue(value);
      continue;
    }

    if (Array.isArray(value)) {
      out[key] = value.map((entry) => (isRecord(entry) ? redactDiagnostics(entry) : entry));
      continue;
    }

    if (isRecord(value)) {
      out[key] = redactDiagnostics(value);
      continue;
    }

    out[key] = value;
  }
  return out;
}
