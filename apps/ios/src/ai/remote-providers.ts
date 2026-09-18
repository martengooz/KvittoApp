import { callAnthropic, callOllama, callOpenAi, ProviderError } from '@kvitto/shared';

import {
  VisibleExtractionError,
  type ProviderCapabilities,
  type ProviderRequest,
  type ProviderResponse,
  type RemoteExtractionProvider,
} from './types';

type CallResult = Awaited<ReturnType<typeof callAnthropic>>;

/**
 * Turns a `ProviderError` from the shared client into the app's own error type.
 *
 * `retryable` matters: the durable job runner uses it to decide between backing
 * off and giving up, and extraction has a deliberately small attempt budget
 * because each attempt may cost money. A bad API key must not be retried; a
 * rate limit or a dropped connection must be.
 */
function toVisible(error: unknown, providerLabel: string): never {
  if (error instanceof ProviderError) {
    const kind: string = error.kind;
    const retryable = kind === 'network' || kind === 'rate-limit' || kind === 'server';
    throw new VisibleExtractionError(error.message, { code: kind, retryable });
  }
  if (error instanceof Error) {
    throw new VisibleExtractionError(error.message, { code: 'provider-failed', retryable: false });
  }
  throw new VisibleExtractionError(`${providerLabel} misslyckades.`, {
    code: 'provider-failed',
    retryable: false,
  });
}

function toResponse(result: CallResult, providerId: string): ProviderResponse {
  return {
    raw: result.raw,
    model: result.model,
    provider: providerId,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: result.durationMs,
    structuredOutputFallback: result.structuredOutputFallback,
  };
}

function requireApiKey(request: ProviderRequest, label: string): string {
  const key = request.apiKey?.trim();
  if (!key) {
    // Not retryable: nothing about waiting makes a missing key appear.
    throw new VisibleExtractionError(`${label} kräver en API-nyckel.`, {
      code: 'missing-api-key',
      retryable: false,
    });
  }
  return key;
}

export class AnthropicExtractionProvider implements RemoteExtractionProvider {
  readonly id = 'anthropic' as const;

  async getAvailability(): Promise<boolean> {
    return true;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      providerId: this.id,
      label: 'Anthropic',
      kind: 'cloud',
      available: true,
      supportsExtractionV1: true,
      supportsStructuredOutput: true,
      supportsCorrection: true,
      requiresApiKey: true,
      requiresBaseUrl: false,
    };
  }

  async extractV1(request: ProviderRequest): Promise<ProviderResponse> {
    try {
      const result = await callAnthropic({
        apiKey: requireApiKey(request, 'Anthropic'),
        baseUrl: request.baseUrl,
        model: request.model,
        image: { base64: request.imageBase64, mediaType: request.mimeType },
        maxOutputTokens: request.maxOutputTokens,
        effort: request.effort,
        structuredOutput: request.structuredOutput,
        extraInstructions: request.extraInstructions,
        correction: request.correction ?? null,
        signal: request.signal,
      });
      return toResponse(result, this.id);
    } catch (error) {
      toVisible(error, 'Anthropic');
    }
  }
}

export class OpenAiExtractionProvider implements RemoteExtractionProvider {
  readonly id = 'openai' as const;

  async getAvailability(): Promise<boolean> {
    return true;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      providerId: this.id,
      label: 'OpenAI',
      kind: 'cloud',
      available: true,
      supportsExtractionV1: true,
      supportsStructuredOutput: true,
      supportsCorrection: true,
      requiresApiKey: true,
      requiresBaseUrl: false,
    };
  }

  async extractV1(request: ProviderRequest): Promise<ProviderResponse> {
    try {
      const result = await callOpenAi({
        apiKey: requireApiKey(request, 'OpenAI'),
        // The shared client takes no default here, because it cannot know
        // whether the caller means OpenAI or a compatible endpoint.
        baseUrl: request.baseUrl?.trim() || 'https://api.openai.com',
        model: request.model,
        image: { base64: request.imageBase64, mediaType: request.mimeType },
        maxOutputTokens: request.maxOutputTokens,
        effort: request.effort,
        structuredOutput: request.structuredOutput,
        extraInstructions: request.extraInstructions,
        correction: request.correction ?? null,
        signal: request.signal,
      });
      return toResponse(result, this.id);
    } catch (error) {
      toVisible(error, 'OpenAI');
    }
  }
}

export class OllamaExtractionProvider implements RemoteExtractionProvider {
  readonly id = 'ollama' as const;

  async getAvailability(): Promise<boolean> {
    return true;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      providerId: this.id,
      label: 'Ollama',
      kind: 'self-hosted',
      available: true,
      supportsExtractionV1: true,
      supportsStructuredOutput: true,
      supportsCorrection: true,
      // A self-hosted server on the local network, addressed rather than
      // authenticated.
      requiresApiKey: false,
      requiresBaseUrl: true,
    };
  }

  async extractV1(request: ProviderRequest): Promise<ProviderResponse> {
    const baseUrl = request.baseUrl?.trim();
    if (!baseUrl) {
      throw new VisibleExtractionError('Ollama kräver en serveradress.', {
        code: 'missing-base-url',
        retryable: false,
      });
    }

    try {
      const result = await callOllama({
        baseUrl,
        model: request.model,
        images: [request.imageBase64],
        maxOutputTokens: request.maxOutputTokens,
        structuredOutput: request.structuredOutput,
        extraInstructions: request.extraInstructions,
        correction: request.correction ?? null,
        signal: request.signal,
      });
      return toResponse(result, this.id);
    } catch (error) {
      toVisible(error, 'Ollama');
    }
  }
}
