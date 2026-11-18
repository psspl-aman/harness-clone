import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/projects', async () => ctx.projects.listSummaries());
}
