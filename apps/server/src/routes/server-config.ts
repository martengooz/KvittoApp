import type { FastifyInstance } from 'fastify';

import { device, requireDevice } from '../auth.ts';
import {
  AI_EFFORTS,
  SERVER_AI_PROVIDERS,
  publicServerSettings,
  saveServerSettings,
  type ServerSettings,
} from '../db/server-settings.ts';

export function registerServerConfigRoutes(app: FastifyInstance): void {
  app.get('/server/config', { preHandler: requireDevice }, async (request) => {
    return publicServerSettings(device(request).accountId);
  });

  app.put<{ Body: ServerSettings }>(
    '/server/config',
    {
      preHandler: requireDevice,
      schema: {
        body: {
          type: 'object',
          required: ['ai'],
          additionalProperties: false,
          properties: {
            ai: {
              type: 'object',
              required: [
                'provider',
                'model',
                'baseUrl',
                'maxOutputTokens',
                'effort',
                'structuredOutput',
                'extraInstructions',
              ],
              additionalProperties: false,
              properties: {
                provider: { type: 'string', enum: [...SERVER_AI_PROVIDERS] },
                model: { type: 'string', minLength: 1, maxLength: 128 },
                baseUrl: { type: 'string', maxLength: 2_048 },
                maxOutputTokens: { type: 'integer', minimum: 1_000, maximum: 128_000 },
                effort: { type: 'string', enum: [...AI_EFFORTS] },
                structuredOutput: { type: 'boolean' },
                extraInstructions: { type: 'string', maxLength: 2_000 },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const accountId = device(request).accountId;
      saveServerSettings(accountId, request.body);
      return publicServerSettings(accountId);
    },
  );
}