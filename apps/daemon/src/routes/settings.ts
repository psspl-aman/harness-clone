import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/settings', async () => ctx.settings.get());
  app.patch('/api/settings', async (req) => ctx.settings.update(req.body));
}
