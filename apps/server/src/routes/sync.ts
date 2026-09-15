/** Delta sync endpoints. */

import type { FastifyInstance } from 'fastify';

import { SYNC_PROTOCOL_VERSION, changeSetSize, type PushRequest } from '@kvitto/shared';

import { device, requireDevice } from '../auth.ts';
import { accountEpoch } from '../db/accounts.ts';
import { applyPush, currentRev, pendingCounts, pull, stats } from '../db/sync.ts';
import { config } from '../env.ts';
import { fail, intQuery, withServerTime } from '../http/reply.ts';

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
        // The mismatch reply carries its own `protocolVersion`, ahead of and
        // independent from the sync envelope every other response gets.
        return reply.code(409).send({
          error: 'protocol_mismatch',
          message: `Servern talar protokollversion ${SYNC_PROTOCOL_VERSION}, klienten ${protocolVersion}.`,
          protocolVersion: SYNC_PROTOCOL_VERSION,
        });
      }

      const size = changeSetSize(changes);
      if (size === 0) {
        return reply.send(
          withServerTime({
            results: [],
            cursor: currentRev(context.accountId),
            epoch: accountEpoch(context.accountId),
          }),
        );
      }
      if (size > 2000) {
        return fail(reply, 413, 'too_many_records', 'Skicka högst 2000 poster per anrop.');
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
      return reply.send(withServerTime({ results, cursor, epoch: accountEpoch(context.accountId) }));
    },
  );

  app.get<{ Querystring: { since?: string; limit?: string } }>(
    '/sync/pull',
    { preHandler: requireDevice },
    async (request, reply) => {
      const context = device(request);
      const since = intQuery(request.query, 'since', { min: 0, default: 0 });
      const limit = intQuery(request.query, 'limit', { min: 1, max: config.pullPageSize, default: config.pullPageSize });

      const result = pull(context.accountId, since, limit);
      return reply.send(withServerTime({ ...result, epoch: accountEpoch(context.accountId) }));
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
      const since = raw === undefined ? null : intQuery(request.query, 'since', { min: 0, default: 0 });

      const response: Record<string, unknown> = withServerTime({
        cursor,
        epoch,
        hasChanges: since === null ? cursor > 0 : since < cursor,
      });

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
