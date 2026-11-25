import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { assertUsableEngines } from './engine-guard';

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/settings', async () => ctx.settings.get());
  app.patch('/api/settings', async (req) => {
    const body = req.body as { defaultEngines?: unknown } | null;
    assertUsableEngines(ctx, body?.defaultEngines, ctx.settings.get().defaultEngines);
    return ctx.settings.update(req.body);
  });
}
