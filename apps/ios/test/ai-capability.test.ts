import { describe, expect, test } from '@jest/globals';

import { ProviderCapabilityRegistry } from '../src/ai/capability-registry';
import type { ProviderRequest, ProviderResponse, RemoteExtractionProvider } from '../src/ai/types';

class AvailableProvider implements RemoteExtractionProvider {
  readonly id = 'openai' as const;

  async getAvailability(): Promise<boolean> {
    return true;
  }

  async getCapabilities() {
    return {
      providerId: this.id,
      label: 'OpenAI',
      kind: 'cloud' as const,
      available: true,
      supportsExtractionV1: true,
      supportsStructuredOutput: true,
      supportsCorrection: true,
      requiresApiKey: true,
      requiresBaseUrl: false,
    };
  }

  async extractV1(_request: ProviderRequest): Promise<ProviderResponse> {
    return {
      raw: { merchant: { name: 'ICA' }, currency: 'SEK', items: [], vatLines: [], total: '10,00', confidence: 0.9 },
      model: 'gpt-test',
      provider: 'openai',
      inputTokens: 10,
      outputTokens: 20,
      durationMs: 30,
    };
  }
}

describe('ai capability registry', () => {
  test('covers manual and foundation policies without adapters', async () => {
    const registry = new ProviderCapabilityRegistry();

    const manualPolicy = await registry.policyForExtractionV1('manual');
    expect(manualPolicy.allowed).toBe(false);
    expect(manualPolicy.reason).toContain('Manual');

    const foundationPolicy = await registry.policyForExtractionV1('foundation-models');
    expect(foundationPolicy.allowed).toBe(false);
    expect(foundationPolicy.reason).toContain('Foundation Models');
  });

  test('uses registered provider capability and permits extraction', async () => {
    const registry = new ProviderCapabilityRegistry();
    registry.register(new AvailableProvider());

    const policy = await registry.policyForExtractionV1('openai');
    expect(policy.allowed).toBe(true);
    expect(policy.reason).toBeNull();

    const caps = await registry.describe('openai');
    expect(caps.available).toBe(true);
    expect(caps.supportsStructuredOutput).toBe(true);
  });
});
