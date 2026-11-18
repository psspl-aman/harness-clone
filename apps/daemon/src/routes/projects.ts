import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';

const IdParams = z.object({ id: z.string().min(1).max(64) });

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/projects', async () => ctx.projects.listSummaries());

  app.post('/api/projects', async (req, reply) => {
    const project = await ctx.projects.create(req.body);
    return reply.status(201).send(project);
  });

  app.get('/api/projects/:id', async (req) => ctx.projects.get(IdParams.parse(req.params).id));

  app.patch('/api/projects/:id', async (req) =>
    ctx.projects.update(IdParams.parse(req.params).id, req.body),
  );

  app.delete('/api/projects/:id', async (req, reply) => {
    ctx.projects.delete(IdParams.parse(req.params).id);
    return reply.status(204).send();
  });

  app.post('/api/projects/:id/analyze', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    ctx.projects.get(id); // 404 if missing
    void ctx.projects.runOnboarding(id);
    return reply.status(202).send({ ok: true });
  });

  app.get('/api/projects/:id/requirements', async (req) =>
    ctx.projects.listRequirements(IdParams.parse(req.params).id),
  );
}
