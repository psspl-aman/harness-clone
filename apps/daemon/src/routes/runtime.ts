import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';

const ProjectId = z.object({ id: z.string().max(64) });
const ErrorId = z.object({ id: z.string().regex(/^err_[a-z0-9]{1,40}$/) });

/** Phase 7: running the project, shell terminals, detected errors and the read-only file browser. */
export function registerRuntimeRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ── Run controls ──
  app.get('/api/projects/:id/run', async (req) =>
    ctx.runner.status(ProjectId.parse(req.params).id),
  );
  app.post('/api/projects/:id/run/start', async (req) =>
    ctx.runner.start(ProjectId.parse(req.params).id),
  );
  app.post('/api/projects/:id/run/stop', async (req) =>
    ctx.runner.stop(ProjectId.parse(req.params).id),
  );
  app.post('/api/projects/:id/run/restart', async (req) =>
    ctx.runner.restart(ProjectId.parse(req.params).id),
  );
  app.post('/api/projects/:id/run/:kind', async (req) => {
    const { id, kind } = z
      .object({ id: z.string().max(64), kind: z.enum(['build', 'test', 'install']) })
      .parse(req.params);
    return ctx.runner.oneShot(id, kind);
  });

  // ── Shell terminals ──
  app.post('/api/projects/:id/terminals', async (req) => {
    const { title } = z.object({ title: z.string().max(80).optional() }).parse(req.body ?? {});
    return ctx.runner.shell(ProjectId.parse(req.params).id, title);
  });

  // ── Errors ──
  app.get('/api/projects/:id/errors', async (req) => {
    const { status } = z.object({ status: z.string().max(60).optional() }).parse(req.query);
    const statuses = status
      ? z.array(z.enum(['open', 'fixing', 'resolved', 'ignored'])).parse(status.split(','))
      : undefined;
    ctx.projects.get(ProjectId.parse(req.params).id);
    return ctx.errors.list(ProjectId.parse(req.params).id, statuses);
  });
  app.post('/api/errors/:id/fix', async (req) => ctx.errors.fix(ErrorId.parse(req.params).id));
  app.post('/api/errors/:id/ignore', async (req) =>
    ctx.errors.setStatus(ErrorId.parse(req.params).id, 'ignored'),
  );
  app.post('/api/errors/:id/reopen', async (req) =>
    ctx.errors.setStatus(ErrorId.parse(req.params).id, 'open'),
  );
  app.post('/api/errors/:id/resolve', async (req) =>
    ctx.errors.setStatus(ErrorId.parse(req.params).id, 'resolved'),
  );

  app.get('/api/projects/:id/activity', async (req) => {
    const { id } = ProjectId.parse(req.params);
    ctx.projects.get(id);
    return ctx.tasks.activity(id);
  });

  // ── Files ──
  app.get('/api/projects/:id/files', async (req) => ctx.files.tree(ProjectId.parse(req.params).id));
  app.get('/api/projects/:id/file', async (req) => {
    const { path } = z.object({ path: z.string().min(1).max(1024) }).parse(req.query);
    return ctx.files.read(ProjectId.parse(req.params).id, path);
  });
}
