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

export interface CompanySettingsState {
  /**
   * Whether a scan may reach the registry. Off still allows a cache hit: a
   * company already stored costs nothing, so this gates the call, not the
   * link.
   */
  autoLookup: boolean;
  /**
   * Whether the scarce name-search endpoint may be used when the organisation
   * number is unreadable. Its daily quota is an order of magnitude smaller
   * than the rest of the API, which is why it is separately switchable.
   */
  nameSearch: boolean;
  /** Name searches allowed per local day. */
  searchBudget: number;
  /** Overridable so a proxy can stand in front of the registry. */
  baseUrl: string;
}

/**
 * Defaults for a device that has never been configured.
 *
 * `autoLookup` is on because a lookup only happens after a scan has produced a
 * checksummed organisation number, and the result is what turns a receipt from
 * a picture into a filed purchase. `nameSearch` is off because its quota is
 * twenty calls a day on a free key - spending it without being asked would
 * exhaust it on a single batch import.
 */
export const DEFAULT_COMPANY_SETTINGS: CompanySettingsState = {
  autoLookup: true,
  nameSearch: false,
  searchBudget: 20,
  baseUrl: '',
};

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
  company: CompanySettingsState;
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
  company: CompanySettingsState;
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
