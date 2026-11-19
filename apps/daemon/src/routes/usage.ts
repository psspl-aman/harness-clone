import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';

export function registerUsageRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/usage/summary', async (req) => {
    const q = z
      .object({
        days: z.coerce.number().int().min(1).max(366).default(30),
        projectId: z.string().max(64).optional(),
        engineId: z.string().max(80).optional(),
      })
      .parse(req.query);
    const to = Date.now();
    return ctx.usage.summary({
      from: to - q.days * 86_400_000,
      to,
      projectId: q.projectId,
      engineId: q.engineId,
    });
  });
  app.get('/api/usage/windows', async () => ctx.usage.windows());
  app.get('/api/tasks/:id/checkpoints', async (req) =>
    ctx.orchestrator.checkpointsOf(z.object({ id: z.string().max(64) }).parse(req.params).id),
  );
}
