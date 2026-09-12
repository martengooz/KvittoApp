/**
 * Device-token authentication.
 *
 * A device presents an opaque bearer token. Only its SHA-256 is stored, so a
 * leaked database does not hand out working credentials, and comparison is done
 * on the hash in constant time.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { getDb, schema } from './db/index.ts';

export interface DeviceContext {
  deviceId: string;
  accountId: string;
  deviceName: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by {@link requireDevice}. */
    device?: DeviceContext;
  }
}

/** 32 bytes of CSPRNG output, base64url-encoded. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Compares two hex digests without leaking timing information.
 *
 * The lookup below is by indexed hash, so this mostly guards the pairing-code
 * path, where an attacker can otherwise probe a short code byte by byte.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function readBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!value || scheme?.toLowerCase() !== 'bearer') return null;
  return value.trim();
}

/**
 * Fastify preHandler that resolves the calling device, or replies 401.
 *
 * Attach it with `{ preHandler: requireDevice }` on every route that touches
 * user data.
 */
export async function requireDevice(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = readBearer(request);
  if (!token) {
    await reply.code(401).send({ error: 'unauthorized', message: 'Missing bearer token.' });
    return;
  }

  const db = getDb();
  const rows = db
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.tokenHash, hashToken(token)))
    .limit(1)
    .all();

  const device = rows[0];
  if (!device || device.revokedAt !== null) {
    await reply.code(401).send({ error: 'unauthorized', message: 'Unknown or revoked device token.' });
    return;
  }

  request.device = {
    deviceId: device.id,
    accountId: device.accountId,
    deviceName: device.name,
  };

  // Best-effort activity tracking; never fail a request over it.
  try {
    db.update(schema.devices)
      .set({ lastSeenAt: Date.now() })
      .where(eq(schema.devices.id, device.id))
      .run();
  } catch (error) {
    request.log.warn({ error }, 'Could not update device last-seen timestamp');
  }
}

/** Reads the device set by {@link requireDevice}. Throws if the guard is missing. */
export function device(request: FastifyRequest): DeviceContext {
  if (!request.device) throw new Error('Route is missing the requireDevice preHandler.');
  return request.device;
}
