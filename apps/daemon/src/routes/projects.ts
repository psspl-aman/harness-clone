import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { assertUsableEngines } from './engine-guard';

const IdParams = z.object({ id: z.string().min(1).max(64) });
const ListQuery = z.object({ archived: z.enum(['true', 'false']).optional() }).transform((q) => ({
  archived: q.archived === 'true',
}));

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  // `?archived=true` lists archived projects instead of the dashboard's active ones.
  app.get('/api/projects', async (req) =>
    ListQuery.parse(req.query).archived
      ? ctx.projects.listArchived()
      : ctx.projects.listSummaries(),
  );

  app.post('/api/projects', async (req, reply) => {
    assertUsableEngines(ctx, (req.body as { roleEngines?: unknown } | null)?.roleEngines);
    const project = await ctx.projects.create(req.body);
    return reply.status(201).send(project);
  });

  app.get('/api/projects/:id', async (req) => ctx.projects.get(IdParams.parse(req.params).id));

  // ── Env keys the project needs (values are write-only: written to .env, never returned) ──
  const KeyParams = z.object({ id: z.string().min(1).max(64), key: z.string().min(1).max(64) });
  app.get('/api/projects/:id/env-keys', async (req) =>
    ctx.envKeys.list(IdParams.parse(req.params).id),
  );
  app.put('/api/projects/:id/env-keys/:key/value', async (req) => {
    const { id, key } = KeyParams.parse(req.params);
    return ctx.envKeys.setValue(id, key, req.body);
  });
  app.post('/api/projects/:id/env-keys/:key/skip', async (req) => {
    const { id, key } = KeyParams.parse(req.params);
    return ctx.envKeys.skip(id, key);
  });

  app.patch('/api/projects/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = req.body as {
      roleEngines?: unknown;
      pipeline?: { engineFallback?: unknown };
    } | null;
    const current = ctx.projects.get(id);
    assertUsableEngines(ctx, body?.roleEngines, current.roleEngines);
    assertUsableEngines(
      ctx,
      body?.pipeline?.engineFallback,
      current.pipeline.engineFallback,
      () => 'the fallback',
    );
    return ctx.projects.update(id, req.body);
  });

  /** Hide from the dashboard and stop everything; all data is kept for a restore. */
  app.post('/api/projects/:id/archive', async (req) => {
    const { id } = IdParams.parse(req.params);
    // Mark it archived first so the scheduler starts nothing new while agents stop.
    ctx.projects.archive(id);
    await ctx.orchestrator.suspendProject(id);
    return ctx.projects.get(id);
  });

  app.post('/api/projects/:id/restore', async (req) =>
    ctx.projects.restore(IdParams.parse(req.params).id),
  );

  /** Deletes the project and its data for good (files on disk are untouched). */
  app.delete('/api/projects/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    ctx.projects.get(id); // 404 if missing
    await ctx.orchestrator.suspendProject(id);
    ctx.projects.delete(id);
    return reply.status(204).send();
  });

  app.post('/api/projects/:id/analyze', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    ctx.projects.get(id); // 404 if missing
    void ctx.projects.runOnboarding(id);
    return reply.status(202).send({ ok: true });
  });

  // ── Commands suggested by an agent ──
  app.get('/api/projects/:id/commands/suggestion', async (req) => {
    const { id } = IdParams.parse(req.params);
    ctx.projects.get(id);
    return { suggestion: ctx.commandAdvisor.get(id) };
  });
  app.post('/api/projects/:id/commands/suggest', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    ctx.projects.get(id);
    return reply.status(202).send(ctx.commandAdvisor.suggest(id));
  });
  app.delete('/api/projects/:id/commands/suggestion', async (req, reply) => {
    ctx.commandAdvisor.dismiss(IdParams.parse(req.params).id);
    return reply.status(204).send();
  });

  app.get('/api/projects/:id/cost', async (req) => {
    const { id } = IdParams.parse(req.params);
    ctx.projects.get(id);
    return ctx.usage.projectCost(id);
  });

  app.get('/api/projects/:id/requirements', async (req) =>
    ctx.projects.listRequirements(IdParams.parse(req.params).id),
  );
}
