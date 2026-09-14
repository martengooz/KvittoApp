/** Delta sync endpoints. */

import type { FastifyInstance } from 'fastify';

import { SYNC_PROTOCOL_VERSION, changeSetSize, type PushRequest } from '@kvitto/shared';

import { device, requireDevice } from '../auth.ts';
import { accountEpoch } from '../db/accounts.ts';
import { applyPush, currentRev, pendingCounts, pull, stats } from '../db/sync.ts';
import { config } from '../env.ts';

export function registerSyncRoutes(app: FastifyInstance): void {
  app.post<{ Body: PushRequest }>(
    '/sync/push',
    {
      preHandler: requireDevice,
      schema: {
        body: {
          type: 'object',
          required: ['deviceId', 'changes'],
          properties: {
            deviceId: { type: 'string' },
            protocolVersion: { type: 'integer' },
            changes: { type: 'object' },
          },
        },
      },
    },
    async (request, reply) => {
      const context = device(request);
      const { protocolVersion, changes } = request.body;

      if (protocolVersion !== undefined && protocolVersion !== SYNC_PROTOCOL_VERSION) {
        return reply.code(409).send({
          error: 'protocol_mismatch',
          message: `Servern talar protokollversion ${SYNC_PROTOCOL_VERSION}, klienten ${protocolVersion}.`,
          protocolVersion: SYNC_PROTOCOL_VERSION,
        });
      }

      const size = changeSetSize(changes);
      if (size === 0) {
        return reply.send({
          results: [],
          cursor: currentRev(context.accountId),
          epoch: accountEpoch(context.accountId),
          serverTime: Date.now(),
        });
      }
      if (size > 2000) {
        return reply.code(413).send({
          error: 'too_many_records',
          message: 'Skicka högst 2000 poster per anrop.',
        });
      }

      const { results, cursor } = applyPush(context.accountId, context.deviceId, changes);
      request.log.info(
        {
          device: context.deviceId,
          applied: results.filter((result) => result.outcome === 'applied').length,
          stale: results.filter((result) => result.outcome === 'stale').length,
          rejected: results.filter((result) => result.outcome === 'rejected').length,
        },
        'sync push',
      );
      return reply.send({
        results,
        cursor,
        epoch: accountEpoch(context.accountId),
        serverTime: Date.now(),
      });
    },
  );

  app.get<{ Querystring: { since?: string; limit?: string } }>(
    '/sync/pull',
    { preHandler: requireDevice },
    async (request, reply) => {
      const context = device(request);
      const since = Math.max(0, Number.parseInt(request.query.since ?? '0', 10) || 0);
      const requested = Number.parseInt(request.query.limit ?? '', 10);
      const limit = Math.min(
        config.pullPageSize,
        Number.isFinite(requested) && requested > 0 ? requested : config.pullPageSize,
      );

      const result = pull(context.accountId, since, limit);
      return reply.send({ ...result, epoch: accountEpoch(context.accountId), serverTime: Date.now() });
    },
  );

  /**
   * The pre-flight probe.
   *
   * Answers "is there anything new for me?" without sending any records, so an
   * idle device's heartbeat costs a few hundred bytes rather than a page of
   * data it already holds. Also the place a client finds out its cursor belongs
   * to a database that no longer exists.
   */
  app.get<{ Querystring: { since?: string; counts?: string } }>(
    '/sync/status',
    { preHandler: requireDevice },
    async (request) => {
      const context = device(request);
      const cursor = currentRev(context.accountId);
      const epoch = accountEpoch(context.accountId);

      const raw = request.query.since;
      const since = raw === undefined ? null : Math.max(0, Number.parseInt(raw, 10) || 0);

      const response: Record<string, unknown> = {
        cursor,
        epoch,
        hasChanges: since === null ? cursor > 0 : since < cursor,
        serverTime: Date.now(),
      };

      if (since !== null) {
        // A cursor above the server's counter cannot be explained by anything
        // but a different history — a restored backup, a fresh volume, a
        // different server behind the same name.
        if (since > cursor) {
          response['diverged'] = true;
          response['hasChanges'] = true;
        } else {
          const pending = pendingCounts(context.accountId, since);
          response['pending'] = pending.perKind;
          response['pendingTotal'] = pending.total;
        }
      }

      // The full per-kind row counts are a separate, heavier question.
      if (request.query.counts === '1') response['counts'] = stats(context.accountId);

      return response;
    },
  );
}
