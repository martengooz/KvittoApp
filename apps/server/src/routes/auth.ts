/** Pairing and identity endpoints. */

import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';

import type { PairRequest } from '@kvitto/shared';

import { device, isLoopback, requireDevice } from '../auth.ts';
import {
  createDeviceSession,
  createPairingCode,
  ensureDefaultAccount,
  listDevices,
  redeemPairingCode,
  revokeDevice,
} from '../db/accounts.ts';
import { effectiveAiSettings } from '../db/server-settings.ts';
import { fail, withSyncEnvelope } from '../http/reply.ts';

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post<{ Body: { deviceId: string; deviceName: string } }>(
    '/auth/dashboard',
    {
      config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['deviceId', 'deviceName'],
          properties: {
            deviceId: { type: 'string', minLength: 8, maxLength: 128 },
            deviceName: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!isLoopback(request)) {
        return fail(reply, 403, 'forbidden', 'Serverdashboarden kan bara aktiveras lokalt.');
      }

      const session = createDeviceSession(
        ensureDefaultAccount(),
        request.body.deviceId,
        request.body.deviceName,
      );
      return reply.send(withSyncEnvelope(session));
    },
  );

  app.post<{ Body: { serverUrl?: string } }>(
    '/auth/pairing-code',
    {
      preHandler: requireDevice,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { serverUrl: { type: 'string', maxLength: 2_048 } },
        },
      },
    },
    async (request, reply) => {
      const supplied = request.body?.serverUrl?.trim();
      const serverUrl = supplied || `${request.protocol}://${request.host}`;
      let parsed: URL;
      try {
        parsed = new URL(serverUrl);
      } catch {
        return fail(reply, 400, 'invalid_server_url', 'Ogiltig serveradress.');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return fail(reply, 400, 'invalid_server_url', 'Serveradressen måste använda HTTP eller HTTPS.');
      }

      const pairingCode = createPairingCode(device(request).accountId);
      const pairingPayload = JSON.stringify({
        type: 'kvitto-pair',
        version: 1,
        serverUrl: parsed.href.replace(/\/$/, ''),
        code: pairingCode.code,
      });
      const qrImage = await QRCode.toDataURL(pairingPayload, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 320,
        color: { dark: '#000000', light: '#ffffff' },
      });
      return { ...pairingCode, pairingPayload, qrImage };
    },
  );

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
        return fail(reply, 400, 'pairing_failed', message);
      }

      return reply.send(
        withSyncEnvelope({
          token: result.token,
          deviceId: result.deviceId,
          deviceName: result.deviceName,
          accountId: result.accountId,
        }),
      );
    },
  );

  app.get('/auth/me', { preHandler: requireDevice }, async (request) => {
    const context = device(request);
    const ai = effectiveAiSettings(context.accountId);
    return withSyncEnvelope({
      deviceId: context.deviceId,
      deviceName: context.deviceName,
      accountId: context.accountId,
      aiProxyEnabled: ai.enabled,
      aiProxyModels: ai.enabled ? ai.allowedModels : [],
    });
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
        return fail(reply, 400, 'invalid_request', 'Använd "Koppla från" i appen för den här enheten.');
      }
      const revoked = revokeDevice(context.accountId, request.params.id);
      if (!revoked) return fail(reply, 404, 'not_found', 'Enheten finns inte.');
      return reply.code(204).send();
    },
  );
}
