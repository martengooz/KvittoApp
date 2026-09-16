import { webCryptoDigest } from './hash.js';
import {
  BLOB_METADATA_PATH,
  BLOBS_DIR,
  MANIFEST_PATH,
  canonicalBlobPath,
  normalizeArchivePath,
  validateArchivePath,
} from './paths.js';
import { findDisallowedSettingsPaths } from './redaction.js';
import {
  ARCHIVE_ENTITY_KINDS,
  DEFAULT_ARCHIVE_LIMITS,
  KVITTO_ARCHIVE_FORMAT,
  KVITTO_ARCHIVE_VERSION,
  type ArchiveEntry,
  type ArchiveEntrySource,
  type ArchiveLimits,
  type ArchiveEntityKind,
  type BlobMetadataRecord,
  type ParsedArchiveManifest,
  type PreflightIssue,
  type PreflightOptions,
  type PreflightReport,
  type SyncLikeEntity,
} from './types.js';

function mergeLimits(partial?: Partial<ArchiveLimits>): ArchiveLimits {
  return {
    ...DEFAULT_ARCHIVE_LIMITS,
    ...partial,
  };
}

function decoder(): { decode: (bytes: Uint8Array, opts?: { stream?: boolean }) => string } {
  const Ctor = (globalThis as { TextDecoder?: new () => { decode: (bytes: Uint8Array, opts?: { stream?: boolean }) => string } }).TextDecoder;
  if (Ctor) return new Ctor();
  throw new Error('TextDecoder is unavailable in this runtime.');
}

async function readEntryText(entry: ArchiveEntry, maxBytes: number): Promise<string> {
  if (entry.uncompressedSize > maxBytes) {
    throw new Error(`Entry exceeds allowed size: ${entry.path}`);
  }

  const td = decoder();
  let total = 0;
  let text = '';
  for await (const chunk of entry.open()) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new Error(`Entry exceeds allowed size while reading: ${entry.path}`);
    }
    text += td.decode(chunk, { stream: true });
  }
  text += td.decode(new Uint8Array(0));
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseManifest(value: unknown): ParsedArchiveManifest | null {
  if (!isRecord(value)) return null;
  if (value.format !== KVITTO_ARCHIVE_FORMAT) return null;
  if (typeof value.version !== 'number') return null;
  if (typeof value.createdAt !== 'string') return null;
  if (!isRecord(value.entityStreams)) return null;
  if (typeof value.settingsPath !== 'string') return null;
  if (typeof value.blobMetadataPath !== 'string') return null;

  const entityStreams: Partial<Record<ArchiveEntityKind, string>> = {};
  for (const kind of ARCHIVE_ENTITY_KINDS) {
    const streamPath = value.entityStreams[kind];
    if (typeof streamPath !== 'string') return null;
    entityStreams[kind] = streamPath;
  }

  return {
    format: KVITTO_ARCHIVE_FORMAT,
    version: value.version,
    createdAt: value.createdAt,
    entityStreams: entityStreams as Record<ArchiveEntityKind, string>,
    settingsPath: value.settingsPath,
    blobMetadataPath: value.blobMetadataPath,
  };
}

function validateSyncEntity(record: unknown): record is SyncLikeEntity {
  if (!isRecord(record)) return false;
  if (typeof record.id !== 'string' || record.id.length === 0) return false;
  if (typeof record.updatedAt !== 'number') return false;
  if (typeof record.deletedAt !== 'number') return false;
  if (typeof record.rev !== 'number') return false;
  if (record.dirty !== 0 && record.dirty !== 1) return false;
  return true;
}

function validateBlobMetadata(record: unknown): record is BlobMetadataRecord {
  if (!isRecord(record)) return false;
  if (typeof record.sha256 !== 'string') return false;
  if (!/^[a-f0-9]{64}$/.test(record.sha256)) return false;
  if (typeof record.mimeType !== 'string' || record.mimeType.length === 0) return false;
  if (typeof record.width !== 'number' || record.width < 0) return false;
  if (typeof record.height !== 'number' || record.height < 0) return false;
  if (typeof record.sizeBytes !== 'number' || record.sizeBytes < 0) return false;
  if (record.role !== 'original' && record.role !== 'processed' && record.role !== 'thumbnail') return false;
  return true;
}

async function parseNdjson(
  entry: ArchiveEntry,
  maxEntryBytes: number,
  maxLineBytes: number,
): Promise<{ records: unknown[]; malformed: boolean }> {
  if (entry.uncompressedSize > maxEntryBytes) {
    throw new Error(`Entry exceeds allowed size: ${entry.path}`);
  }

  const td = decoder();
  const records: unknown[] = [];
  let malformed = false;
  let buffer = '';
  let currentLineBytes = 0;

  for await (const chunk of entry.open()) {
    currentLineBytes += chunk.byteLength;
    if (currentLineBytes > maxEntryBytes) {
      throw new Error(`Entry exceeds allowed size while reading: ${entry.path}`);
    }

    buffer += td.decode(chunk, { stream: true });
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      if (line.length > 0) {
        if (line.length > maxLineBytes) {
          malformed = true;
        } else {
          try {
            records.push(JSON.parse(line));
          } catch {
            malformed = true;
          }
        }
      }
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf('\n');
    }
  }

  buffer += td.decode(new Uint8Array(0));
  const tail = buffer.trim();
  if (tail.length > 0) {
    if (tail.length > maxLineBytes) {
      malformed = true;
    } else {
      try {
        records.push(JSON.parse(tail));
      } catch {
        malformed = true;
      }
    }
  }

  return { records, malformed };
}

function addIssue(issues: PreflightIssue[], issue: PreflightIssue): void {
  issues.push(issue);
}

export async function preflightArchive(
  source: ArchiveEntrySource,
  options: PreflightOptions = {},
): Promise<PreflightReport> {
  const limits = mergeLimits(options.limits);
  const digest = options.digest ?? webCryptoDigest;
  const issues: PreflightIssue[] = [];

  let entryCount = 0;
  let totalUncompressedBytes = 0;
  const entriesByPath = new Map<string, ArchiveEntry>();

  for await (const rawEntry of source.entries()) {
    entryCount += 1;
    totalUncompressedBytes += rawEntry.uncompressedSize;

    if (entryCount > limits.maxEntries) {
      addIssue(issues, {
        severity: 'error',
        code: 'entry_limit_exceeded',
        path: rawEntry.path,
        message: `Archive exceeded max entries (${limits.maxEntries}).`,
      });
      continue;
    }

    if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
      addIssue(issues, {
        severity: 'error',
        code: 'total_size_exceeded',
        path: rawEntry.path,
        message: `Archive exceeded max uncompressed size (${limits.maxTotalUncompressedBytes} bytes).`,
      });
      continue;
    }

    if (rawEntry.uncompressedSize > limits.maxEntryBytes) {
      addIssue(issues, {
        severity: 'error',
        code: 'entry_too_large',
        path: rawEntry.path,
        message: `Entry exceeded max size (${limits.maxEntryBytes} bytes).`,
      });
      continue;
    }

    const validPath = validateArchivePath(rawEntry.path);
    if (!validPath) {
      addIssue(issues, {
        severity: 'error',
        code: 'invalid_path',
        path: rawEntry.path,
        message: 'Entry path is absolute, traversal, or otherwise invalid.',
      });
      continue;
    }

    if (entriesByPath.has(validPath)) {
      addIssue(issues, {
        severity: 'error',
        code: 'duplicate_path',
        path: validPath,
        message: 'Duplicate archive entry path found.',
      });
      continue;
    }

    entriesByPath.set(validPath, { ...rawEntry, path: validPath });
  }

  const manifestEntry = entriesByPath.get(MANIFEST_PATH);
  if (!manifestEntry) {
    addIssue(issues, {
      severity: 'error',
      code: 'missing_manifest',
      path: MANIFEST_PATH,
      message: 'manifest.json entry is required.',
    });

    return {
      ok: false,
      manifest: null,
      issues,
      entryCount,
      totalUncompressedBytes,
      entityCounts: {},
      blobCount: 0,
    };
  }

  let manifest: ParsedArchiveManifest | null = null;
  try {
    const manifestText = await readEntryText(manifestEntry, limits.maxEntryBytes);
    manifest = parseManifest(JSON.parse(manifestText));
  } catch {
    manifest = null;
  }

  if (!manifest) {
    addIssue(issues, {
      severity: 'error',
      code: 'invalid_manifest',
      path: MANIFEST_PATH,
      message: 'Manifest could not be parsed as a valid v1 manifest.',
    });

    return {
      ok: false,
      manifest: null,
      issues,
      entryCount,
      totalUncompressedBytes,
      entityCounts: {},
      blobCount: 0,
    };
  }

  if (manifest.version > KVITTO_ARCHIVE_VERSION) {
    addIssue(issues, {
      severity: 'error',
      code: 'future_version',
      path: MANIFEST_PATH,
      message: 'Archive version is not supported.',
    });
  }

  if (manifest.version !== KVITTO_ARCHIVE_VERSION) {
    addIssue(issues, {
      severity: 'error',
      code: 'invalid_manifest',
      path: MANIFEST_PATH,
      message: `Archive version must be ${KVITTO_ARCHIVE_VERSION}.`,
    });
  }

  const normalizedSettingsPath = validateArchivePath(manifest.settingsPath);
  if (!normalizedSettingsPath) {
    addIssue(issues, {
      severity: 'error',
      code: 'invalid_manifest',
      path: manifest.settingsPath,
      message: 'settingsPath in manifest is invalid.',
    });
  } else {
    const settingsEntry = entriesByPath.get(normalizedSettingsPath);
    if (settingsEntry) {
      try {
        const settingsText = await readEntryText(settingsEntry, limits.maxEntryBytes);
        const settings = JSON.parse(settingsText);
        const disallowed = findDisallowedSettingsPaths(settings);
        for (const path of disallowed) {
          addIssue(issues, {
            severity: 'error',
            code: 'settings_not_allowed',
            path: normalizedSettingsPath,
            message: `Disallowed setting path present: ${path}`,
          });
        }
      } catch {
        addIssue(issues, {
          severity: 'error',
          code: 'settings_malformed',
          path: normalizedSettingsPath,
          message: 'settings.json is malformed JSON.',
        });
      }
    }
  }

  const entityCounts: Partial<Record<ArchiveEntityKind, number>> = {};

  for (const kind of ARCHIVE_ENTITY_KINDS) {
    const streamPath = validateArchivePath(manifest.entityStreams[kind]);
    if (!streamPath) {
      addIssue(issues, {
        severity: 'error',
        code: 'invalid_manifest',
        path: manifest.entityStreams[kind],
        message: `Manifest entity stream path for ${kind} is invalid.`,
      });
      continue;
    }

    const entry = entriesByPath.get(streamPath);
    if (!entry) {
      addIssue(issues, {
        severity: 'error',
        code: 'missing_entity_stream',
        path: streamPath,
        message: `Missing entity stream for ${kind}.`,
      });
      continue;
    }

    const parsed = await parseNdjson(entry, limits.maxEntryBytes, limits.maxNdjsonLineBytes);
    if (parsed.malformed) {
      addIssue(issues, {
        severity: 'error',
        code: 'malformed_ndjson',
        path: streamPath,
        message: `Entity stream for ${kind} contains malformed NDJSON lines.`,
      });
    }

    entityCounts[kind] = parsed.records.length;

    if (parsed.records.length > limits.maxEntityRowsPerKind) {
      addIssue(issues, {
        severity: 'error',
        code: 'entity_limit_exceeded',
        path: streamPath,
        message: `Entity stream for ${kind} exceeded row limit (${limits.maxEntityRowsPerKind}).`,
      });
    }

    for (const record of parsed.records) {
      if (!validateSyncEntity(record)) {
        addIssue(issues, {
          severity: 'error',
          code: 'invalid_entity',
          path: streamPath,
          message: `Invalid sync entity record in ${kind}.`,
        });
      }
    }

    if (kind === 'secrets' && parsed.records.length > 0) {
      addIssue(issues, {
        severity: 'error',
        code: 'secret_entity_present',
        path: streamPath,
        message: 'Secrets stream must be omitted or empty in v1 archive export.',
      });
    }
  }

  const blobMetadataPath = validateArchivePath(manifest.blobMetadataPath);
  const blobMetas: BlobMetadataRecord[] = [];

  if (!blobMetadataPath) {
    addIssue(issues, {
      severity: 'error',
      code: 'invalid_manifest',
      path: manifest.blobMetadataPath,
      message: 'blobMetadataPath in manifest is invalid.',
    });
  } else {
    const metadataEntry = entriesByPath.get(blobMetadataPath);
    if (!metadataEntry) {
      addIssue(issues, {
        severity: 'error',
        code: 'missing_blob_metadata',
        path: BLOB_METADATA_PATH,
        message: 'Blob metadata entry is required.',
      });
    } else {
      const parsed = await parseNdjson(metadataEntry, limits.maxEntryBytes, limits.maxNdjsonLineBytes);
      if (parsed.malformed) {
        addIssue(issues, {
          severity: 'error',
          code: 'malformed_ndjson',
          path: blobMetadataPath,
          message: 'Blob metadata NDJSON contains malformed lines.',
        });
      }

      for (const record of parsed.records) {
        if (!validateBlobMetadata(record)) {
          addIssue(issues, {
            severity: 'error',
            code: 'invalid_blob_metadata',
            path: blobMetadataPath,
            message: 'Invalid blob metadata record.',
          });
          continue;
        }

        if (record.sizeBytes > limits.maxBlobBytes) {
          addIssue(issues, {
            severity: 'error',
            code: 'entry_too_large',
            path: canonicalBlobPath(record.sha256),
            message: `Blob metadata exceeds max blob bytes (${limits.maxBlobBytes}).`,
          });
        }

        blobMetas.push(record);
      }
    }
  }

  const metadataBySha = new Map<string, BlobMetadataRecord>();
  for (const meta of blobMetas) {
    metadataBySha.set(meta.sha256, meta);
    const path = canonicalBlobPath(meta.sha256);
    const blobEntry = entriesByPath.get(path);

    if (!blobEntry) {
      addIssue(issues, {
        severity: 'error',
        code: 'missing_blob',
        path,
        message: `Blob entry for ${meta.sha256} is missing.`,
      });
      continue;
    }

    if (blobEntry.uncompressedSize !== meta.sizeBytes) {
      addIssue(issues, {
        severity: 'error',
        code: 'blob_size_mismatch',
        path,
        message: `Blob size mismatch. expected=${meta.sizeBytes} actual=${blobEntry.uncompressedSize}`,
      });
    }

    const digestHex = await digest.sha256Hex(blobEntry.open());
    if (digestHex !== meta.sha256) {
      addIssue(issues, {
        severity: 'error',
        code: 'blob_sha_mismatch',
        path,
        message: `Blob SHA-256 mismatch. expected=${meta.sha256} actual=${digestHex}`,
      });
    }
  }

  for (const path of entriesByPath.keys()) {
    const normalized = normalizeArchivePath(path);
    if (!normalized.startsWith(`${BLOBS_DIR}/`)) continue;

    const sha = normalized.slice(`${BLOBS_DIR}/`.length);
    if (sha.includes('/')) {
      addIssue(issues, {
        severity: 'error',
        code: 'invalid_path',
        path,
        message: 'Blob path must be exactly blobs/<sha256>.',
      });
      continue;
    }

    if (!metadataBySha.has(sha)) {
      addIssue(issues, {
        severity: 'error',
        code: 'unexpected_blob',
        path,
        message: 'Blob is present without metadata.',
      });
    }
  }

  const ok = !issues.some((issue) => issue.severity === 'error');

  return {
    ok,
    manifest,
    issues,
    entryCount,
    totalUncompressedBytes,
    entityCounts,
    blobCount: blobMetas.length,
  };
}
