/**
 * Control and status for the local model.
 *
 * Everything the model *produces* leaves through the ordinary sync endpoints —
 * these exist only so an operator can see what the thing is doing and tell it
 * to get on with it.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import { device, requireDevice } from '../auth.ts';
import { readRecord } from '../db/sync.ts';
import { config } from '../env.ts';
import { fail, withServerTime } from '../http/reply.ts';
import * as jobs from '../llm/jobs.ts';
import { ensureReady, fetchModel, installedModels, status } from '../llm/runtime.ts';
import { lastPass, runPass } from '../llm/worker.ts';

export function registerLlmRoutes(app: FastifyInstance): void {
  app.get('/llm/status', { preHandler: requireDevice }, async (request) => {
    const context = device(request);
    return withServerTime({
      enabled: config.llm.enabled,
      runtime: status(),
      models: config.llm.enabled ? await installedModels() : [],
      queue: jobs.counts(context.accountId),
      lastPass: lastPass(),
      failures: jobs.recentFailures(context.accountId).map((job) => ({
        receiptId: job.receiptId,
        attempts: job.attempts,
        nextAttemptAt: job.nextAttemptAt,
        error: job.lastError,
      })),
    });
  });

  /** Brings the runtime up without waiting for the next scheduled pass. */
  app.post('/llm/start', { preHandler: requireDevice }, async (_request, reply) => {
    if (!config.llm.enabled) return llmDisabled(reply);
    const ready = await ensureReady();
    return reply.send({ ready, runtime: status() });
  });

  /**
   * Downloads the model. Answers immediately and reports progress through
   * `/llm/status`, because a 3 GB pull outlives any sensible request timeout.
   */
  app.post(
    '/llm/pull',
    { preHandler: requireDevice, config: { rateLimit: { max: 3, timeWindow: '10 minutes' } } },
    async (_request, reply) => {
      if (!config.llm.enabled) return llmDisabled(reply);
      const current = status();
      if (current.state === 'pulling') {
        return fail(reply, 409, 'already_pulling', 'Nedladdningen pågår redan.');
      }
      void fetchModel();
      return reply.code(202).send({ started: true, model: config.llm.model });
    },
  );

  /** Runs a pass now. Bounded, so a device cannot ask for unbounded work. */
  app.post<{ Body?: { size?: number } }>(
    '/llm/scan',
    { preHandler: requireDevice, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!config.llm.enabled) return llmDisabled(reply);
      const context = device(request);
      const requested = Number(request.body?.size);
      const size = Number.isFinite(requested)
        ? Math.min(Math.max(1, Math.trunc(requested)), 25)
        : config.llm.batchSize;

      const report = await runPass(context.accountId, { size });
      return reply.send(report);
    },
  );

  /** Puts one receipt back in the queue, or every failed one. */
  app.post<{ Body?: { receiptId?: string } }>(
    '/llm/requeue',
    { preHandler: requireDevice },
    async (request, reply) => {
      if (!config.llm.enabled) return llmDisabled(reply);
      const context = device(request);
      const receiptId = request.body?.receiptId;

      if (!receiptId) {
        const requeued = jobs.retryFailed(context.accountId);
        return reply.send({ requeued });
      }

      const receipt = readRecord(context.accountId, 'receipts', receiptId);
      if (!receipt) {
        return fail(reply, 404, 'not_found', 'Kvittot finns inte.');
      }
      jobs.requeue(context.accountId, receipt);
      return reply.send({ requeued: 1 });
    },
  );
}

function llmDisabled(reply: FastifyReply): FastifyReply {
  return fail(reply, 501, 'llm_disabled', 'Den lokala modellen är avstängd. Sätt KVITTO_LLM_ENABLED=1.');
}
