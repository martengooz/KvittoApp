/**
 * The one place an HTTP response's shape is decided, so a status code or a
 * field name cannot drift apart between routes just because they were
 * written on different days.
 */

import type { FastifyReply } from 'fastify';

import { SYNC_PROTOCOL_VERSION } from '@kvitto/shared';

/** Sends the standard `{ error, message }` shape for a failed request. */
export function fail(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: code, message });
}

/** Appends `serverTime`, which every sync-relevant response carries. */
export function withServerTime<T extends object>(payload: T): T & { serverTime: number } {
  return { ...payload, serverTime: Date.now() };
}

/**
 * `withServerTime`, plus the protocol version — for the handful of endpoints
 * a client checks before it trusts anything else in the response.
 */
export function withSyncEnvelope<T extends object>(
  payload: T,
): T & { serverTime: number; protocolVersion: number } {
  return { ...payload, serverTime: Date.now(), protocolVersion: SYNC_PROTOCOL_VERSION };
}

/** Media types a receipt scan can legitimately be, wherever one is accepted. */
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const IMAGE_TYPE_SET = new Set<string>(IMAGE_TYPES);

export function isImageType(value: string): boolean {
  return IMAGE_TYPE_SET.has(value);
}

/** The 415 every image-accepting endpoint sends for anything else. */
export function unsupportedMediaType(reply: FastifyReply): FastifyReply {
  return fail(reply, 415, 'unsupported_media_type', `Endast ${IMAGE_TYPES.join(', ')} stöds.`);
}

/**
 * Parses a query-string integer the way a route actually receives one: maybe
 * absent, maybe not a number at all. Bad or missing input becomes `default`
 * rather than `NaN` reaching a SQL `LIMIT`, and the result is then clamped to
 * `[min, max]` when either is given.
 */
export function intQuery(
  query: Record<string, string | undefined>,
  key: string,
  options: { min?: number; max?: number; default: number },
): number {
  const raw = query[key];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  let value = Number.isFinite(parsed) ? parsed : options.default;
  if (options.min !== undefined) value = Math.max(options.min, value);
  if (options.max !== undefined) value = Math.min(options.max, value);
  return value;
}
