export const OMITTED_EXPORT_FIELDS = Object.freeze([
  'pairing.token',
  'device.id',
  'device.name',
  'account.id',
  'secrets',
  'ai.apiKey',
  'company.apiKey',
  'debug.logs',
]);

export const IMPORTABLE_SETTINGS_PATHS = Object.freeze([
  'scan.autoCapture',
  'scan.jpegQuality',
  'scan.colorMode',
  'ocr.languages',
  'ocr.languageCorrection',
  'sync.autoSync',
  'sync.wifiOnly',
  'ui.locale',
  'ui.currency',
  'ui.compactList',
  'ai.mode',
  'ai.provider',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function flattenPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
      out.push(...flattenPaths(value, path));
      continue;
    }
    out.push(path);
  }
  return out;
}

function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]!;
    const next = cursor[part];
    if (!isPlainObject(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

function getByPath(source: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cursor: unknown = source;
  for (const part of parts) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

export function findDisallowedSettingsPaths(settings: unknown): string[] {
  if (!isPlainObject(settings)) return ['<root>'];
  const allowed = new Set(IMPORTABLE_SETTINGS_PATHS);
  return flattenPaths(settings).filter((path) => !allowed.has(path));
}

export function redactSettings(settings: unknown): Record<string, unknown> {
  if (!isPlainObject(settings)) return {};
  const out: Record<string, unknown> = {};
  for (const path of IMPORTABLE_SETTINGS_PATHS) {
    const value = getByPath(settings, path);
    if (value !== undefined) setByPath(out, path, value);
  }
  return out;
}

export function shouldExportEntityKind(kind: string): boolean {
  return kind !== 'secrets';
}
