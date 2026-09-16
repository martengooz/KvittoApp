export interface PairingSettingsState {
  serverUrl: string;
  paired: boolean;
  deviceName: string;
  accountHint: string | null;
}

export interface ImageSettingsState {
  autoCapture: boolean;
  jpegQuality: number;
  colorMode: 'color' | 'grayscale' | 'binarize' | 'none';
}

export interface OcrSettingsState {
  languages: string[];
  languageCorrection: boolean;
}

export interface AiSettingsState {
  mode: 'none' | 'local' | 'remote';
  provider: string;
  model: string;
}

export interface SyncSettingsState {
  autoSync: boolean;
  wifiOnly: boolean;
}

export interface MigrationSettingsState {
  lastImportAt: number | null;
  lastExportAt: number | null;
  lastPreflightSummary: string | null;
}

export interface StorageSettingsState {
  blobCount: number;
  blobBytes: number;
  hasPersistentStorage: boolean;
}

export interface DebugSettingsState {
  redactedDiagnostics: Record<string, unknown>;
}

export interface AboutSettingsState {
  appName: string;
  appVersion: string;
  nativeVersion: string;
}

export interface SecureCredentialSnapshot {
  pairingToken: string | null;
  aiApiKey: string | null;
  companyApiKey: string | null;
}

export interface SecureCredentialsPort {
  get(): Promise<SecureCredentialSnapshot>;
  set(next: SecureCredentialSnapshot): Promise<void>;
  clear(): Promise<void>;
}

export interface PairingCredentialsSnapshot {
  token: string | null;
  accountId: string | null;
}

export interface PairingCredentialsPort {
  get(): Promise<PairingCredentialsSnapshot>;
}

export interface SettingsDiagnosticsPort {
  read(): Promise<Record<string, unknown>>;
}

export interface MigrationMetadataPort {
  read(): Promise<MigrationSettingsState>;
  write(next: MigrationSettingsState): Promise<void>;
}

export interface SettingsControllerInput {
  pairing: PairingSettingsState;
  image: ImageSettingsState;
  ocr: OcrSettingsState;
  ai: AiSettingsState;
  sync: SyncSettingsState;
  migration: MigrationSettingsState;
  storage: StorageSettingsState;
  about: AboutSettingsState;
  secureCredentials: SecureCredentialsPort;
  pairingCredentials?: PairingCredentialsPort;
  persistence?: {
    onSyncChanged?(next: SyncSettingsState): Promise<void>;
    onPairingChanged?(next: PairingSettingsState): Promise<void>;
  };
  diagnostics: SettingsDiagnosticsPort;
}

export interface SettingsControllerSnapshot {
  pairing: PairingSettingsState;
  image: ImageSettingsState;
  ocr: OcrSettingsState;
  ai: AiSettingsState;
  sync: SyncSettingsState;
  migration: MigrationSettingsState;
  storage: StorageSettingsState;
  debug: DebugSettingsState;
  about: AboutSettingsState;
  credentialPresence: {
    pairingToken: boolean;
    aiApiKey: boolean;
    companyApiKey: boolean;
  };
}
