/**
 * The sync engine: push local changes, pull remote ones, reconcile.
 *
 * Design constraints, in priority order:
 *
 * 1. **The device is the source of truth while offline.** Nothing here may
 *    block a local write, and a failed sync must leave local data untouched.
 * 2. **Convergence without a server round-trip per conflict.** Both sides run
 *    the same `resolveConflict` (last-write-wins on `updatedAt`, with a
 *    deterministic tie-break), so two devices reach the same answer
 *    independently.
 * 3. **Images are optional and secondary.** They are content-addressed and
 *    synced after the metadata, so a slow or metered connection delays photos
 *    rather than the data that makes the app useful.
 */

import {
  ENTITY_KINDS,
  changeSetSize,
  isEmptyChangeSet,
  resolveConflict,
  type AnyEntity,
  type ChangeSet,
  type EntityKind,
} from '@kvitto/shared';

import { bus } from '../core/events.js';
import { getSettings } from '../core/settings.js';
import { db, getKv, setKv, SYNC_TABLES } from '../db/db.js';
import { putBlob } from '../db/blobs.js';

import { blobStatus, downloadBlob, pullChanges, pushChanges, SyncError, uploadBlob } from './client.js';
import { isPaired } from './identity.js';

const CURSOR_KEY = 'sync:cursor';
const LAST_SYNC_KEY = 'sync:lastSuccess';

/** Records pushed per request. Small enough to stay under proxy body limits. */
const PUSH_BATCH = 200;
/** Images uploaded per sync pass, so a big backlog does not stall forever. */
const BLOB_BATCH = 12;

export interface SyncReport {
  ok: boolean;
  pushed: number;
  pulled: number;
  blobsUploaded: number;
  blobsDownloaded: number;
  /** Records the server rejected as stale; they were re-pulled. */
  stale: number;
  error: string | null;
  durationMs: number;
}

export interface SyncState {
  status: 'idle' | 'syncing' | 'error' | 'offline' | 'unpaired';
  lastSuccess: number | null;
  pendingChanges: number;
  message: string | null;
}

let running: Promise<SyncReport> | null = null;
let lastError: string | null = null;

/** Number of local records waiting to be uploaded. */
export async function countPending(): Promise<number> {
  let total = 0;
  for (const getTable of Object.values(SYNC_TABLES)) {
    total += await getTable().where('dirty').equals(1).count();
  }
  return total;
}

export async function getSyncState(): Promise<SyncState> {
  const settings = getSettings();
  const pendingChanges = await countPending();
  const lastSuccess = await getKv<number | null>(LAST_SYNC_KEY, null);

  if (!settings.sync.serverUrl || !(await isPaired())) {
    return { status: 'unpaired', lastSuccess, pendingChanges, message: null };
  }
  if (running) return { status: 'syncing', lastSuccess, pendingChanges, message: null };
  if (!navigator.onLine) return { status: 'offline', lastSuccess, pendingChanges, message: null };
  if (lastError) return { status: 'error', lastSuccess, pendingChanges, message: lastError };
  return { status: 'idle', lastSuccess, pendingChanges, message: null };
}

/**
 * Runs a full sync pass. Concurrent calls share the in-flight run rather than
 * starting a second one — several UI events can request a sync at once.
 */
export function sync(options: { includeImages?: boolean } = {}): Promise<SyncReport> {
  running ??= runSync(options).finally(() => {
    running = null;
  });
  return running;
}

async function runSync(options: { includeImages?: boolean }): Promise<SyncReport> {
  const started = performance.now();
  const settings = getSettings();
  const serverUrl = settings.sync.serverUrl;
  const includeImages = options.includeImages ?? settings.sync.syncImages;

  const report: SyncReport = {
    ok: false,
    pushed: 0,
    pulled: 0,
    blobsUploaded: 0,
    blobsDownloaded: 0,
    stale: 0,
    error: null,
    durationMs: 0,
  };

  if (!serverUrl || !(await isPaired())) {
    report.error = 'Enheten är inte parkopplad med någon server.';
    report.durationMs = Math.round(performance.now() - started);
    return report;
  }

  bus.emit('sync:state', { state: 'syncing' });
  try {
    // Push before pull: local edits get their revisions assigned first, so the
    // pull that follows returns them already reconciled rather than as conflicts.
    const pushResult = await pushAll(serverUrl);
    report.pushed = pushResult.pushed;
    report.stale = pushResult.stale;

    report.pulled = await pullAll(serverUrl);

    if (includeImages) {
      report.blobsUploaded = await uploadPendingBlobs(serverUrl);
      report.blobsDownloaded = await downloadMissingBlobs(serverUrl);
    }

    await setKv(LAST_SYNC_KEY, Date.now());
    lastError = null;
    report.ok = true;
    bus.emit('sync:state', { state: 'idle' });
  } catch (error) {
    const message = error instanceof SyncError ? error.message : String(error);
    lastError = message;
    report.error = message;
    bus.emit('sync:state', { state: 'error', message });
  }

  report.durationMs = Math.round(performance.now() - started);
  if (report.pulled > 0) bus.emit('data:changed', { kinds: [...ENTITY_KINDS] });
  return report;
}

// --- push -----------------------------------------------------------------

async function pushAll(serverUrl: string): Promise<{ pushed: number; stale: number }> {
  let pushed = 0;
  let stale = 0;

  // Loop until nothing is dirty: applying a batch can leave more behind, and a
  // record edited during the sync must not be dropped.
  for (let pass = 0; pass < 20; pass += 1) {
    const changes = await collectDirty(PUSH_BATCH);
    if (isEmptyChangeSet(changes)) break;

    const response = await pushChanges(serverUrl, changes);
    const sent = snapshotUpdatedAt(changes);

    await db.transaction('rw', Object.values(SYNC_TABLES).map((getTable) => getTable()), async () => {
      for (const result of response.results) {
        const table = SYNC_TABLES[result.kind]();
        const current = await table.get(result.id);
        if (!current) continue;

        if (result.outcome === 'applied') {
          // Only clear `dirty` when the record has not changed since it was
          // serialised — otherwise an edit made mid-sync would never upload.
          const unchanged = current.updatedAt === sent.get(`${result.kind}:${result.id}`);
          await table.update(result.id, unchanged ? { rev: result.rev, dirty: 0 } : { rev: result.rev });
          if (unchanged) pushed += 1;
        } else if (result.outcome === 'stale') {
          // The server holds a newer version; the pull below will bring it in
          // and `applyRemote` decides the winner.
          stale += 1;
          await table.update(result.id, { rev: result.rev });
        } else {
          // Rejected records would otherwise be retried forever. Keep them
          // dirty but log loudly; the Settings screen surfaces the count.
          console.warn(`Server rejected ${result.kind}/${result.id}: ${result.reason ?? 'no reason given'}`);
        }
      }
    });

    if (changeSetSize(changes) < PUSH_BATCH) break;
  }

  return { pushed, stale };
}

async function collectDirty(limit: number): Promise<ChangeSet> {
  const changes: ChangeSet = {};
  let remaining = limit;

  // Iterated in dependency order so a receipt never reaches the server before
  // the category it points at.
  for (const kind of ENTITY_KINDS) {
    if (remaining <= 0) break;
    const rows = await SYNC_TABLES[kind]().where('dirty').equals(1).limit(remaining).toArray();
    if (rows.length === 0) continue;
    // `dirty` is a local-only flag; the server stores its own.
    (changes as Record<string, unknown[]>)[kind] = rows.map((row) => ({ ...row, dirty: 0 }));
    remaining -= rows.length;
  }
  return changes;
}

function snapshotUpdatedAt(changes: ChangeSet): Map<string, number> {
  const map = new Map<string, number>();
  for (const [kind, rows] of Object.entries(changes)) {
    for (const row of (rows ?? []) as AnyEntity[]) map.set(`${kind}:${row.id}`, row.updatedAt);
  }
  return map;
}

// --- pull -----------------------------------------------------------------

async function pullAll(serverUrl: string): Promise<number> {
  let cursor = await getKv(CURSOR_KEY, 0);
  let pulled = 0;

  for (let page = 0; page < 100; page += 1) {
    const response = await pullChanges(serverUrl, cursor);
    const size = changeSetSize(response.changes);
    if (size > 0) {
      await applyRemote(response.changes);
      pulled += size;
    }
    cursor = response.cursor;
    await setKv(CURSOR_KEY, cursor);
    if (!response.hasMore) break;
  }
  return pulled;
}

/**
 * Merges a remote change set into the local database.
 *
 * A remote record wins only if `resolveConflict` says so. Crucially, a local
 * record that is still dirty and *newer* keeps its dirty flag, so the next push
 * sends the local version rather than silently losing the user's edit.
 */
async function applyRemote(changes: ChangeSet): Promise<void> {
  await db.transaction('rw', Object.values(SYNC_TABLES).map((getTable) => getTable()), async () => {
    for (const kind of ENTITY_KINDS) {
      const rows = changes[kind] as AnyEntity[] | undefined;
      if (!rows?.length) continue;
      const table = SYNC_TABLES[kind as EntityKind]();

      for (const remote of rows) {
        const local = await table.get(remote.id);

        if (!local) {
          await table.put({ ...remote, dirty: 0 } as never);
          continue;
        }
        if (local.dirty === 0) {
          // No local edit to protect: take the server's version outright.
          await table.put({ ...remote, dirty: 0 } as never);
          continue;
        }

        const winner = resolveConflict(local, remote);
        if (winner === remote) {
          await table.put({ ...remote, dirty: 0 } as never);
        } else {
          // Local wins, but adopt the server's revision so the next push is not
          // rejected as stale for being behind.
          await table.update(remote.id, { rev: remote.rev });
        }
      }
    }
  });
}

// --- images ---------------------------------------------------------------

async function uploadPendingBlobs(serverUrl: string): Promise<number> {
  const candidates = await db.blobs.where('uploaded').equals(0).limit(BLOB_BATCH * 4).toArray();
  if (candidates.length === 0) return 0;

  // Ask first: a blob is content-addressed, so another device may already have
  // uploaded the identical image and re-sending it would be pure waste.
  const { present, missing } = await blobStatus(serverUrl, candidates.map((blob) => blob.id));
  if (present.length > 0) {
    await db.blobs.where('id').anyOf(present).modify({ uploaded: 1 });
  }

  const wanted = new Set(missing);
  let uploaded = 0;
  for (const blob of candidates) {
    if (uploaded >= BLOB_BATCH) break;
    if (!wanted.has(blob.id)) continue;
    await uploadBlob(serverUrl, blob.id, blob.data);
    await db.blobs.update(blob.id, { uploaded: 1 });
    uploaded += 1;
  }
  return uploaded;
}

/** Fetches images for receipts that arrived from another device. */
async function downloadMissingBlobs(serverUrl: string): Promise<number> {
  const wanted = new Set<string>();
  await db.receipts.where('deletedAt').equals(0).each((receipt) => {
    // Thumbnails first — they are what the list view needs, and they are tiny.
    if (receipt.thumbId) wanted.add(receipt.thumbId);
    if (receipt.imageId) wanted.add(receipt.imageId);
  });

  let downloaded = 0;
  for (const id of wanted) {
    if (downloaded >= BLOB_BATCH) break;
    if (await db.blobs.get(id)) continue;

    try {
      const data = await downloadBlob(serverUrl, id);
      const storedId = await putBlob(data, { role: 'processed' });
      await db.blobs.update(storedId, { uploaded: 1 });
      downloaded += 1;
    } catch (error) {
      // A single missing image must not fail the whole sync — the metadata is
      // already safe, and the next pass will try again.
      console.warn(`Could not download blob ${id}`, error);
    }
  }
  return downloaded;
}

// --- scheduling -----------------------------------------------------------

let autoTimer: ReturnType<typeof setTimeout> | undefined;
let started = false;

/**
 * Wires up automatic syncing: on reconnect, on local changes (debounced), and
 * on a slow heartbeat to pick up other devices' edits.
 */
export function startAutoSync(): void {
  if (started) return;
  started = true;

  const trigger = (delay: number): void => {
    if (!getSettings().sync.autoSync) return;
    if (autoTimer !== undefined) clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      if (navigator.onLine) void sync();
    }, delay);
  };

  window.addEventListener('online', () => {
    bus.emit('net:online', { online: true });
    trigger(1_000);
  });
  window.addEventListener('offline', () => {
    bus.emit('net:online', { online: false });
    bus.emit('sync:state', { state: 'offline' });
  });

  // Debounced so a burst of edits (editing every line of a receipt) results in
  // one sync rather than one per keystroke.
  bus.on('data:changed', () => trigger(5_000));

  // Catch changes made on other devices even when this one is idle.
  setInterval(() => trigger(0), 5 * 60_000);

  // Push anything still pending when the app is backgrounded, which on mobile
  // is often the last moment before the page is frozen.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') return;
    trigger(500);
  });

  trigger(2_000);
}
