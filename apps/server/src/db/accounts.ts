/**
 * Account and pairing-code management.
 *
 * The deployment target is a household: one account, several devices. An
 * account is created lazily on first use so the operator never has to run a
 * setup command before generating their first pairing code.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';

import { newId, newPairingCode } from '@kvitto/shared';

import { generateToken, hashToken } from '../auth.ts';
import { config } from '../env.ts';
import { getDb, schema } from './index.ts';

/** The single account, created on first call. */
export function ensureDefaultAccount(): string {
  const db = getDb();
  const existing = db.select().from(schema.accounts).limit(1).all()[0];
  if (existing) return existing.id;

  const id = newId();
  db.insert(schema.accounts)
    .values({ id, name: 'Hushåll', createdAt: Date.now(), revCounter: 0 })
    .run();
  return id;
}

export interface PairingCode {
  code: string;
  expiresAt: number;
}

/** Mints a short-lived pairing code the user types into the app. */
export function createPairingCode(accountId: string): PairingCode {
  const db = getDb();
  const now = Date.now();
  const expiresAt = now + config.pairingCodeTtlMinutes * 60_000;
  const code = newPairingCode();

  db.insert(schema.pairingCodes)
    .values({ code, accountId, createdAt: now, expiresAt, usedAt: null, usedByDeviceId: null })
    .run();

  // Housekeeping: drop codes that expired long ago so the table cannot grow
  // unbounded on a server that mints many.
  db.delete(schema.pairingCodes)
    .where(sql`${schema.pairingCodes.expiresAt} < ${now - 24 * 60 * 60_000}`)
    .run();

  return { code, expiresAt };
}

export type RedeemResult =
  | { ok: true; accountId: string; token: string; deviceId: string; deviceName: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' };

/**
 * Exchanges a pairing code for a device token.
 *
 * Re-pairing with a `deviceId` the account already knows rotates that device's
 * token rather than creating a duplicate, so a user who re-pairs after clearing
 * their browser does not accumulate ghost devices.
 */
export function redeemPairingCode(code: string, deviceId: string, deviceName: string): RedeemResult {
  const db = getDb();
  const now = Date.now();
  const normalized = code.trim().toUpperCase();

  const row = db
    .select()
    .from(schema.pairingCodes)
    .where(eq(schema.pairingCodes.code, normalized))
    .limit(1)
    .all()[0];

  if (!row) return { ok: false, reason: 'unknown' };
  if (row.usedAt !== null) return { ok: false, reason: 'used' };
  if (row.expiresAt < now) return { ok: false, reason: 'expired' };

  const token = generateToken();
  const tokenHash = hashToken(token);

  db.transaction((tx) => {
    const existing = tx
      .select()
      .from(schema.devices)
      .where(and(eq(schema.devices.id, deviceId), eq(schema.devices.accountId, row.accountId)))
      .limit(1)
      .all()[0];

    if (existing) {
      tx.update(schema.devices)
        .set({ tokenHash, name: deviceName, revokedAt: null, lastSeenAt: now })
        .where(eq(schema.devices.id, deviceId))
        .run();
    } else {
      tx.insert(schema.devices)
        .values({
          id: deviceId,
          accountId: row.accountId,
          name: deviceName,
          tokenHash,
          createdAt: now,
          lastSeenAt: now,
          revokedAt: null,
        })
        .run();
    }

    tx.update(schema.pairingCodes)
      .set({ usedAt: now, usedByDeviceId: deviceId })
      .where(eq(schema.pairingCodes.code, normalized))
      .run();
  });

  return { ok: true, accountId: row.accountId, token, deviceId, deviceName };
}

export function listDevices(accountId: string) {
  return getDb()
    .select({
      id: schema.devices.id,
      name: schema.devices.name,
      createdAt: schema.devices.createdAt,
      lastSeenAt: schema.devices.lastSeenAt,
      revokedAt: schema.devices.revokedAt,
    })
    .from(schema.devices)
    .where(eq(schema.devices.accountId, accountId))
    .all();
}

export function revokeDevice(accountId: string, deviceId: string): boolean {
  const result = getDb()
    .update(schema.devices)
    .set({ revokedAt: Date.now() })
    .where(
      and(
        eq(schema.devices.id, deviceId),
        eq(schema.devices.accountId, accountId),
        isNull(schema.devices.revokedAt),
      ),
    )
    .run();
  return result.changes > 0;
}
