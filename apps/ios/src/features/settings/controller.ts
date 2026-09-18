import { redactDiagnostics } from './redaction';
import type {
  SecureCredentialSnapshot,
  SettingsControllerInput,
  SettingsControllerSnapshot,
} from './types';

function hasSecret(value: string | null): boolean {
  return Boolean(value && value.trim().length > 0);
}

export class SettingsFeatureController {
  private readonly state: SettingsControllerInput;

  constructor(input: SettingsControllerInput) {
    this.state = {
      ...input,
      pairing: { ...input.pairing },
      image: { ...input.image },
      ocr: { ...input.ocr },
      ai: { ...input.ai },
      company: { ...input.company },
      sync: { ...input.sync },
      migration: { ...input.migration },
      storage: { ...input.storage },
      about: { ...input.about },
    };
  }

  updateImage(patch: Partial<SettingsControllerInput['image']>): void {
    this.state.image = { ...this.state.image, ...patch };
  }

  updateOcr(patch: Partial<SettingsControllerInput['ocr']>): void {
    this.state.ocr = { ...this.state.ocr, ...patch };
  }

  updateAi(patch: Partial<SettingsControllerInput['ai']>): void {
    this.state.ai = { ...this.state.ai, ...patch };
  }

  updateCompany(patch: Partial<SettingsControllerInput['company']>): void {
    this.state.company = { ...this.state.company, ...patch };
  }

  async updateSync(patch: Partial<SettingsControllerInput['sync']>): Promise<void> {
    this.state.sync = { ...this.state.sync, ...patch };
    await this.state.persistence?.onSyncChanged?.({ ...this.state.sync });
  }

  async updatePairing(patch: Partial<SettingsControllerInput['pairing']>): Promise<void> {
    this.state.pairing = { ...this.state.pairing, ...patch };
    await this.state.persistence?.onPairingChanged?.({ ...this.state.pairing });
  }

  async setSecureCredentials(patch: Partial<SecureCredentialSnapshot>): Promise<void> {
    const current = await this.state.secureCredentials.get();
    await this.state.secureCredentials.set({
      pairingToken: patch.pairingToken ?? current.pairingToken,
      aiApiKey: patch.aiApiKey ?? current.aiApiKey,
      companyApiKey: patch.companyApiKey ?? current.companyApiKey,
    });
  }

  async clearSecureCredentials(): Promise<void> {
    await this.state.secureCredentials.clear();
  }

  async getSnapshot(): Promise<SettingsControllerSnapshot> {
    const [credentials, diagnostics, pairingCredentials] = await Promise.all([
      this.state.secureCredentials.get(),
      this.state.diagnostics.read(),
      this.state.pairingCredentials?.get() ?? Promise.resolve(null),
    ]);

    const pairingState = {
      ...this.state.pairing,
      paired: pairingCredentials ? Boolean(pairingCredentials.token) : this.state.pairing.paired,
      accountHint: pairingCredentials?.accountId ?? this.state.pairing.accountHint,
    };

    return {
      pairing: pairingState,
      image: { ...this.state.image },
      ocr: { ...this.state.ocr, languages: [...this.state.ocr.languages] },
      ai: { ...this.state.ai },
      company: { ...this.state.company },
      sync: { ...this.state.sync },
      migration: { ...this.state.migration },
      storage: { ...this.state.storage },
      debug: {
        redactedDiagnostics: redactDiagnostics(diagnostics),
      },
      about: { ...this.state.about },
      credentialPresence: {
        pairingToken: hasSecret(credentials.pairingToken),
        aiApiKey: hasSecret(credentials.aiApiKey),
        companyApiKey: hasSecret(credentials.companyApiKey),
      },
    };
  }
}
