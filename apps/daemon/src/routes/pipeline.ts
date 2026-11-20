import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';

const Id = z.object({ id: z.string().min(1).max(64) });
const id = (req: FastifyRequest) => Id.parse(req.params).id;

export function registerPipelineRoutes(app: FastifyInstance, ctx: AppContext): void {
  const o = ctx.orchestrator;
  app.get('/api/projects/:id/pipeline', async (req) => o.status(id(req)));
  app.post('/api/projects/:id/pipeline/pause', async (req) => o.setProjectPaused(id(req), true));
  app.post('/api/projects/:id/pipeline/resume', async (req) => o.setProjectPaused(id(req), false));

  const action = (path: string, fn: (taskId: string, body: unknown) => unknown) =>
    app.post(`/api/tasks/:id/${path}`, async (req) => {
      await fn(id(req), req.body);
      return ctx.tasks.get(id(req));
    });
  action('pause', (t) => o.pause(t));
  action('resume', (t) => o.resume(t));
  action('cancel', (t) => o.cancel(t));
  action('restart', (t) => o.restart(t));
  action('retry', (t) => o.retry(t));
  action('fix', (t) => o.fixFailed(t));
  action('steer', (t, b) => o.steer(t, b));
  action('approve-merge', (t) => o.approveMerge(t));
  action('request-changes', (t, b) => o.requestChanges(t, b));

  app.get('/api/tasks/:id/runs', async (req) => o.runsOf(id(req)));
  app.get('/api/tasks/:id/reviews', async (req) => o.reviewsOf(id(req)));
  app.get('/api/tasks/:id/tests', async (req) => o.testsOf(id(req)));
  app.get('/api/tasks/:id/diff', async (req) => o.diffOf(id(req)));
  app.get('/api/tasks/:id/report', async (req) => o.report(id(req)));
}
