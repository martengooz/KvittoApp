export type DebugLevel = 'info' | 'warn' | 'error';

export interface DebugEntry {
  id: number;
  timestamp: number;
  level: DebugLevel;
  source: 'client' | 'server';
  message: string;
  details: Record<string, string | number | boolean | null>;
}

const STORAGE_KEY = 'kvitto.debug-log';
const MAX_ENTRIES = 300;
let installed = false;

export function appendClientDebug(
  level: DebugLevel,
  message: string,
  details: DebugEntry['details'] = {},
): void {
  const entries = readEntries();
  entries.push({
    id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
    timestamp: Date.now(),
    level,
    source: 'client',
    message: redact(message),
    details: Object.fromEntries(
      Object.entries(details).map(([key, value]) => [key, typeof value === 'string' ? redact(value) : value]),
    ),
  });
  writeEntries(entries.slice(-MAX_ENTRIES));
}

export function getClientDebugEntries(): DebugEntry[] {
  return readEntries().reverse();
}

export function clearClientDebugEntries(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Debug logging must never interfere with the application.
  }
}

export function installClientDebugLogging(): void {
  if (installed) return;
  installed = true;
  appendClientDebug('info', 'Application started', {
    online: navigator.onLine,
    standalone: window.matchMedia('(display-mode: standalone)').matches,
  });
  window.addEventListener('error', (event) => {
    appendClientDebug('error', 'Unhandled error', {
      message: event.message,
      source: filenameOnly(event.filename),
      line: event.lineno,
      column: event.colno,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    appendClientDebug('error', 'Unhandled promise rejection', {
      message: errorMessage(event.reason),
    });
  });
  window.addEventListener('online', () => appendClientDebug('info', 'Network online'));
  window.addEventListener('offline', () => appendClientDebug('warn', 'Network offline'));
}

function readEntries(): DebugEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isDebugEntry).slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

function writeEntries(entries: DebugEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Private mode and full storage can reject writes. Logging remains optional.
  }
}

function isDebugEntry(value: unknown): value is DebugEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<DebugEntry>;
  return (
    typeof entry.id === 'number' &&
    typeof entry.timestamp === 'number' &&
    (entry.level === 'info' || entry.level === 'warn' || entry.level === 'error') &&
    entry.source === 'client' &&
    typeof entry.message === 'string' &&
    Boolean(entry.details && typeof entry.details === 'object')
  );
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? `${value.name}: ${value.message}` : String(value);
}

function filenameOnly(value: string): string {
  if (!value) return '';
  try {
    return new URL(value).pathname.split('/').at(-1) ?? '';
  } catch {
    return '';
  }
}

function redact(value: string): string {
  return value
    .slice(0, 500)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk[-_][A-Za-z0-9_-]{8,}\b/g, '[redacted]');
}