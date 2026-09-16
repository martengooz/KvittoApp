import type { ProviderCapabilities, ProviderRequest, ProviderResponse, RemoteExtractionProvider } from './types';
import { VisibleExtractionError } from './types';

export interface FoundationModelsProviderOptions {
  isRuntimeAvailable?: () => boolean | Promise<boolean>;
}

export class FoundationModelsProvider implements RemoteExtractionProvider {
  readonly id = 'foundation-models' as const;

  private readonly isRuntimeAvailable: () => Promise<boolean>;

  constructor(options: FoundationModelsProviderOptions = {}) {
    this.isRuntimeAvailable = async () => {
      if (!options.isRuntimeAvailable) return false;
      return Boolean(await options.isRuntimeAvailable());
    };
  }

  async getAvailability(): Promise<boolean> {
    return this.isRuntimeAvailable();
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      providerId: this.id,
      label: 'Foundation Models',
      kind: 'on-device',
      available: await this.getAvailability(),
      supportsExtractionV1: false,
      supportsStructuredOutput: true,
      supportsCorrection: false,
      requiresApiKey: false,
      requiresBaseUrl: false,
    };
  }

  async extractV1(_request: ProviderRequest): Promise<ProviderResponse> {
    throw new VisibleExtractionError(
      'Foundation Models finns, men kvittoutläsning i v1 är inte aktiverad än.',
      { code: 'foundation-v1-not-supported', retryable: false },
    );
  }
}
