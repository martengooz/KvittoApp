import type { FastifyInstance } from 'fastify';

import { SECRET_NAMES, type SecretName, type SyncedSecret } from '@kvitto/shared';

import { device, requireDevice } from '../auth.ts';
import { readRecord, writeServerRecords } from '../db/sync.ts';

export function registerSecretRoutes(app: FastifyInstance): void {
  app.get('/secrets', { preHandler: requireDevice }, async (request) => {
    const accountId = device(request).accountId;
    return {
      secrets: SECRET_NAMES.map((id) => metadata(id, readRecord(accountId, 'secrets', id))),
    };
  });

  app.put<{ Params: { id: string }; Body: { value: string } }>(
    '/secrets/:id',
    {
      preHandler: requireDevice,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', enum: [...SECRET_NAMES] } },
        },
        body: {
          type: 'object',
          required: ['value'],
          additionalProperties: false,
          properties: { value: { type: 'string', maxLength: 16_384 } },
        },
      },
    },
    async (request) => {
      // No further validation needed: the schema's `enum: [...SECRET_NAMES]`
      // above already rejects anything else before this handler runs.
      const accountId = device(request).accountId;
      const id = request.params.id as SecretName;
      const existing = readRecord(accountId, 'secrets', id);
      const record: SyncedSecret = {
        id,
        value: request.body.value.trim(),
        updatedAt: Date.now(),
        deletedAt: 0,
        rev: existing?.rev ?? 0,
        dirty: 0,
      };
      writeServerRecords(accountId, [{ kind: 'secrets', record }]);
      return metadata(id, record);
    },
  );
}

function metadata(id: SecretName, secret: SyncedSecret | null) {
  return {
    id,
    configured: Boolean(secret?.value),
    updatedAt: secret?.updatedAt ?? null,
  };
}