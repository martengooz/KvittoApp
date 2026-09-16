import type { AiProviderId, CapabilityPolicy, ProviderCapabilities, RemoteExtractionProvider } from './types';

const PROVIDER_LABELS: Record<AiProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI-compatible',
  ollama: 'Ollama',
  server: 'Server proxy',
  manual: 'Manual',
  'foundation-models': 'Foundation Models',
};

function staticCaps(providerId: AiProviderId): Omit<ProviderCapabilities, 'available'> {
  switch (providerId) {
    case 'anthropic':
      return {
        providerId,
        label: PROVIDER_LABELS[providerId],
        kind: 'cloud',
        supportsExtractionV1: true,
        supportsStructuredOutput: true,
        supportsCorrection: true,
        requiresApiKey: true,
        requiresBaseUrl: false,
      };
    case 'openai':
      return {
        providerId,
        label: PROVIDER_LABELS[providerId],
        kind: 'cloud',
        supportsExtractionV1: true,
        supportsStructuredOutput: true,
        supportsCorrection: true,
        requiresApiKey: true,
        requiresBaseUrl: false,
      };
    case 'openai-compatible':
      return {
        providerId,
        label: PROVIDER_LABELS[providerId],
        kind: 'self-hosted',
        supportsExtractionV1: true,
        supportsStructuredOutput: true,
        supportsCorrection: true,
        requiresApiKey: true,
        requiresBaseUrl: true,
      };
    case 'ollama':
      return {
        providerId,
        label: PROVIDER_LABELS[providerId],
        kind: 'self-hosted',
        supportsExtractionV1: true,
        supportsStructuredOutput: true,
        supportsCorrection: true,
        requiresApiKey: false,
        requiresBaseUrl: true,
      };
    case 'server':
      return {
        providerId,
        label: PROVIDER_LABELS[providerId],
        kind: 'proxy',
        supportsExtractionV1: true,
        supportsStructuredOutput: true,
        supportsCorrection: true,
        requiresApiKey: false,
        requiresBaseUrl: true,
      };
    case 'manual':
      return {
        providerId,
        label: PROVIDER_LABELS[providerId],
        kind: 'manual',
        supportsExtractionV1: false,
        supportsStructuredOutput: false,
        supportsCorrection: false,
        requiresApiKey: false,
        requiresBaseUrl: false,
      };
    case 'foundation-models':
      return {
        providerId,
        label: PROVIDER_LABELS[providerId],
        kind: 'on-device',
        supportsExtractionV1: false,
        supportsStructuredOutput: true,
        supportsCorrection: false,
        requiresApiKey: false,
        requiresBaseUrl: false,
      };
    default: {
      const exhaustive: never = providerId;
      return exhaustive;
    }
  }
}

export class ProviderCapabilityRegistry {
  private readonly providers = new Map<AiProviderId, RemoteExtractionProvider>();

  register(provider: RemoteExtractionProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(providerId: AiProviderId): RemoteExtractionProvider | null {
    return this.providers.get(providerId) ?? null;
  }

  async describe(providerId: AiProviderId): Promise<ProviderCapabilities> {
    const provider = this.providers.get(providerId);
    if (provider) {
      return provider.getCapabilities();
    }

    return {
      ...staticCaps(providerId),
      available: providerId === 'manual',
    };
  }

  async policyForExtractionV1(providerId: AiProviderId): Promise<CapabilityPolicy> {
    const caps = await this.describe(providerId);
    if (!caps.available) {
      return { allowed: false, reason: `${caps.label} är inte tillgänglig på den här enheten.` };
    }
    if (!caps.supportsExtractionV1) {
      return { allowed: false, reason: `${caps.label} stöder inte kvittoutläsning i v1.` };
    }
    return { allowed: true, reason: null };
  }

  async supportsCorrection(providerId: AiProviderId): Promise<boolean> {
    const caps = await this.describe(providerId);
    return caps.available && caps.supportsCorrection;
  }
}

export function createDefaultCapabilityRegistry(
  providers: readonly RemoteExtractionProvider[],
): ProviderCapabilityRegistry {
  const registry = new ProviderCapabilityRegistry();
  for (const provider of providers) registry.register(provider);
  return registry;
}
