import { ApiKeyInputSchema, TestRunInputSchema } from '@agentforge/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';

// Engine ids contain a colon for custom engines ("custom:my-cli").
const Id = z.object({ id: z.string().regex(/^[a-z0-9:-]{1,80}$/) });

export function registerEngineRoutes(app: FastifyInstance, ctx: AppContext): void {
  const id = (req: { params: unknown }) => Id.parse(req.params).id;

  app.get('/api/engines', async () => ctx.engines.list());
  app.post('/api/engines/refresh', async () => ctx.engines.refreshAll());
  app.post('/api/engines/custom', async (req, reply) =>
    reply.status(201).send(await ctx.engines.createCustom(req.body)),
  );

  app.get('/api/engines/:id', async (req) => ctx.engines.get(id(req)));
  app.patch('/api/engines/:id', async (req) => ctx.engines.update(id(req), req.body));
  app.put('/api/engines/:id/custom', async (req) => ctx.engines.updateCustom(id(req), req.body));
  app.delete('/api/engines/:id', async (req, reply) => {
    ctx.engines.removeCustom(id(req));
    return reply.status(204).send();
  });
  app.post('/api/engines/:id/refresh', async (req) => ctx.engines.refresh(id(req)));
  app.put('/api/engines/:id/api-key', async (req) =>
    ctx.engines.setApiKey(id(req), ApiKeyInputSchema.parse(req.body).apiKey),
  );
  app.delete('/api/engines/:id/api-key', async (req) => ctx.engines.clearApiKey(id(req)));
  app.post('/api/engines/:id/login', async (req, reply) =>
    reply.status(201).send(await ctx.engines.startLogin(id(req))),
  );
  app.post('/api/engines/:id/logout', async (req) => ctx.engines.logout(id(req)));
  app.post('/api/engines/:id/test', async (req, reply) => {
    const body = TestRunInputSchema.parse(req.body ?? {});
    return reply.status(202).send(ctx.engines.startTestRun(id(req), body));
  });
  app.get('/api/engines/test-runs/:runId', async (req) =>
    ctx.engines.testRunResult(z.object({ runId: z.string().max(64) }).parse(req.params).runId),
  );
  app.post('/api/runs/:runId/cancel', async (req, reply) => {
    ctx.engines.cancelTestRun(z.object({ runId: z.string().max(64) }).parse(req.params).runId);
    return reply.status(202).send({ ok: true });
  });
}
