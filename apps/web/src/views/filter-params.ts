/**
 * The two primitive parsers every URL-backed filter builds on: a comma-joined
 * id list and a plain number. Split out from `filters.ts` so they carry no
 * dependencies of their own and can be unit-tested directly.
 */

/** A comma-joined list param, or `undefined` when the key is absent or empty. */
export function listParam(params: URLSearchParams, key: string): string[] | undefined {
  const value = params.get(key);
  return value ? value.split(',').filter(Boolean) : undefined;
}

/** A numeric param, or `undefined` when the key is absent or not a finite number. */
export function numberParam(params: URLSearchParams, key: string): number | undefined {
  const value = params.get(key);
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
