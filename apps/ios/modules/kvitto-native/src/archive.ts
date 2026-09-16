import { requireNativeModule } from 'expo-modules-core';

export interface NativeArchiveEntryIndexRow {
  path: string;
  uncompressedSize: number;
}

export interface NativeArchiveBinding {
  openZipIndex?(fileUri: string): Promise<NativeArchiveEntryIndexRow[]>;
  shareArchiveFile?(fileUri: string, mimeType: string, filename: string): Promise<void>;
}

export class NativeArchiveZipWiringGapError extends Error {
  constructor(methodName: keyof NativeArchiveBinding) {
    super(
      `Native archive ZIP wiring gap: ${String(methodName)} is unavailable. ` +
        'Implement bridge wiring in KvittoNative module definition before calling this API.',
    );
    this.name = 'NativeArchiveZipWiringGapError';
  }
}

function defaultBinding(): NativeArchiveBinding {
  return requireNativeModule<NativeArchiveBinding>('KvittoNative');
}

function requireMethod<K extends keyof NativeArchiveBinding>(
  binding: NativeArchiveBinding,
  method: K,
): NonNullable<NativeArchiveBinding[K]> {
  const resolved = binding[method];
  if (!resolved) throw new NativeArchiveZipWiringGapError(method);
  return resolved;
}

export function createNativeArchiveFacade(binding: NativeArchiveBinding = defaultBinding()) {
  return {
    capability(): { supported: boolean; reason: string | null } {
      const open = typeof binding.openZipIndex === 'function';
      const share = typeof binding.shareArchiveFile === 'function';
      if (open && share) {
        return { supported: true, reason: null };
      }
      return {
        supported: false,
        reason: 'Native ZIP or share bridge is not wired into KvittoNative module entry.',
      };
    },
    async openZipIndex(fileUri: string): Promise<NativeArchiveEntryIndexRow[]> {
      const fn = requireMethod(binding, 'openZipIndex');
      return fn(fileUri);
    },
    async shareArchiveFile(fileUri: string, mimeType: string, filename: string): Promise<void> {
      const fn = requireMethod(binding, 'shareArchiveFile');
      await fn(fileUri, mimeType, filename);
    },
  };
}
