/** Pairing and identity endpoints. */

import type { FastifyInstance } from 'fastify';

import { SYNC_PROTOCOL_VERSION, type PairRequest } from '@kvitto/shared';

import { device, requireDevice } from '../auth.ts';
import { listDevices, redeemPairingCode, revokeDevice } from '../db/accounts.ts';
import { aiProxyEnabled, allowedModels } from '../env.ts';

export function registerAuthRoutes(app: FastifyInstance): void {
  /**
   * Exchanges a pairing code for a device token.
   *
   * Rate-limited hard: the pairing code is short enough to be typed by hand,
   * which also makes it short enough to guess without a limit in place.
   */
  app.post<{ Body: PairRequest }>(
    '/auth/pair',
    {
      config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['code', 'deviceId', 'deviceName'],
          properties: {
            code: { type: 'string', minLength: 4, maxLength: 32 },
            deviceId: { type: 'string', minLength: 8, maxLength: 128 },
            deviceName: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      const { code, deviceId, deviceName } = request.body;
      const result = redeemPairingCode(code, deviceId, deviceName);

      if (!result.ok) {
        const message =
          result.reason === 'expired'
            ? 'Koden har gått ut. Skapa en ny på servern.'
            : result.reason === 'used'
              ? 'Koden är redan använd.'
              : 'Okänd kod.';
        // A single status for all three: distinguishing them would tell a
        // guesser which codes exist.
        return reply.code(400).send({ error: 'pairing_failed', message });
      }

      return reply.send({
        token: result.token,
        deviceId: result.deviceId,
        deviceName: result.deviceName,
        accountId: result.accountId,
        serverTime: Date.now(),
        protocolVersion: SYNC_PROTOCOL_VERSION,
      });
    },
  );

  app.get('/auth/me', { preHandler: requireDevice }, async (request) => {
    const context = device(request);
    return {
      deviceId: context.deviceId,
      deviceName: context.deviceName,
      accountId: context.accountId,
      serverTime: Date.now(),
      protocolVersion: SYNC_PROTOCOL_VERSION,
      aiProxyEnabled: aiProxyEnabled(),
      aiProxyModels: allowedModels(),
    };
  });

  app.get('/auth/devices', { preHandler: requireDevice }, async (request) => {
    return { devices: listDevices(device(request).accountId) };
  });

  app.delete<{ Params: { id: string } }>(
    '/auth/devices/:id',
    { preHandler: requireDevice },
    async (request, reply) => {
      const context = device(request);
      if (request.params.id === context.deviceId) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', message: 'Använd "Koppla från" i appen för den här enheten.' });
      }
      const revoked = revokeDevice(context.accountId, request.params.id);
      if (!revoked) return reply.code(404).send({ error: 'not_found', message: 'Enheten finns inte.' });
      return reply.code(204).send();
    },
  );
}
