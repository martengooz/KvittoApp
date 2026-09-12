/**
 * This device's identity with the companion server.
 *
 * The pairing token is a bearer credential, so it lives in IndexedDB alongside
 * the receipts rather than in `localStorage`: same origin scoping, but it is
 * covered by the app's own "erase all data" and "unpair" actions.
 */

import { newId, type SyncMeta } from '@kvitto/shared';
import { db, getKv, setKv } from '../db/db.js';

const DEVICE_ID_KEY = 'device:id';
const DEVICE_NAME_KEY = 'device:name';
const TOKEN_KEY = 'sync:token';
const ACCOUNT_KEY = 'sync:accountId';

/** Stable id for this browser profile, minted on first use. */
export async function getDeviceId(): Promise<string> {
  const existing = await getKv<string | null>(DEVICE_ID_KEY, null);
  if (existing) return existing;
  const id = newId();
  await setKv(DEVICE_ID_KEY, id);
  return id;
}

export async function getDeviceName(): Promise<string> {
  return getKv(DEVICE_NAME_KEY, guessDeviceName());
}

export async function setDeviceName(name: string): Promise<void> {
  await setKv(DEVICE_NAME_KEY, name.trim() || guessDeviceName());
}

export async function getDeviceToken(): Promise<string | null> {
  return getKv<string | null>(TOKEN_KEY, null);
}

export async function setDeviceToken(token: string, accountId: string): Promise<void> {
  await setKv(TOKEN_KEY, token);
  await setKv(ACCOUNT_KEY, accountId);
}

export async function getAccountId(): Promise<string | null> {
  return getKv<string | null>(ACCOUNT_KEY, null);
}

export async function isPaired(): Promise<boolean> {
  return (await getDeviceToken()) !== null;
}

/**
 * Forgets the server credential and the sync cursor.
 *
 * Local data stays put, but every record is marked dirty so that pairing with a
 * different server (or re-pairing after a server rebuild) uploads the full
 * archive instead of silently syncing nothing.
 */
export async function unpair(): Promise<void> {
  await db.kv.where('key').startsWith('sync:').delete();
  const now = Date.now();
  const tables = [db.receipts, db.items, db.categories, db.tags, db.receiptTags];
  await db.transaction('rw', tables, async () => {
    for (const table of tables) {
      // Cast through the base entity shape: every sync table shares SyncMeta,
      // but Dexie's per-table `modify` overloads do not unify across them.
      await (table as unknown as { toCollection: () => { modify: (fn: (row: SyncMeta) => void) => Promise<number> } })
        .toCollection()
        .modify((row) => {
          row.dirty = 1;
          row.rev = 0;
          row.updatedAt = Math.max(row.updatedAt, now);
        });
    }
  });
  await db.blobs.toCollection().modify((blob) => {
    blob.uploaded = 0;
  });
}

/** A friendly default label, from the user agent. */
function guessDeviceName(): string {
  const agent = navigator.userAgent;
  if (/iPhone/i.test(agent)) return 'iPhone';
  if (/iPad/i.test(agent)) return 'iPad';
  if (/Android/i.test(agent)) return 'Android-telefon';
  if (/Macintosh/i.test(agent)) return 'Mac';
  if (/Windows/i.test(agent)) return 'Windows-dator';
  if (/Linux/i.test(agent)) return 'Linux-dator';
  return 'Okänd enhet';
}
