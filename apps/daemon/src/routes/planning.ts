import { ApprovePlanInputSchema } from '@agentforge/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { badRequest } from '../http/errors';
import type { UploadedFile } from '../services/attachments';
import { assertUsableEngines } from './engine-guard';

const Id = z.object({ id: z.string().min(1).max(64) });
const id = (req: FastifyRequest) => Id.parse(req.params).id;

export function registerPlanningRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ── Chat & planner
  app.get('/api/projects/:id/chat', async (req) => ctx.planner.messages(id(req)));
  app.post('/api/projects/:id/chat', async (req, reply) =>
    reply.status(201).send(await ctx.planner.send(id(req), req.body)),
  );
  app.get('/api/projects/:id/planner', async (req) => ctx.planner.state(id(req)));
  app.post('/api/projects/:id/planner/cancel', async (req, reply) => {
    ctx.planner.cancel(id(req));
    return reply.status(202).send({ ok: true });
  });
  app.get('/api/projects/:id/references', async (req) => {
    const { q } = z.object({ q: z.string().max(200).default('') }).parse(req.query);
    return ctx.planner.suggestions(id(req), q);
  });
  app.post('/api/projects/:id/attachments', async (req, reply) => {
    const { localPath } = ctx.projects.get(id(req));
    const saved = [];
    for (const file of await uploadedFiles(req))
      saved.push(await ctx.attachments.saveToProject(localPath, file));
    return reply.status(201).send(saved);
  });
  // Uploads from the new-project wizard, kept until the project is created (24 h at most).
  app.post('/api/attachments/staged', async (req, reply) =>
    reply.status(201).send((await uploadedFiles(req)).map((f) => ctx.attachments.stage(f))),
  );

  // ── Board, plans
  app.get('/api/projects/:id/board', async (req) => ctx.tasks.board(id(req)));
  app.post('/api/projects/:id/tasks/reorder', async (req) => ctx.tasks.reorder(id(req), req.body));
  app.patch('/api/plans/:id', async (req) => ctx.tasks.updatePlan(id(req), req.body));
  app.post('/api/plans/:id/approve', async (req) =>
    ctx.tasks.approvePlan(id(req), ApprovePlanInputSchema.parse(req.body ?? {}).taskIds),
  );
  app.post('/api/plans/:id/regenerate', async (req, reply) =>
    reply.status(202).send(ctx.planner.regeneratePlan(id(req), req.body)),
  );
  app.post('/api/plans/:id/tasks', async (req, reply) => {
    const plan = ctx.tasks.plan(id(req));
    return reply.status(201).send(ctx.tasks.create(plan.projectId, plan.id, req.body));
  });

  // ── Tasks
  app.get('/api/tasks/:id', async (req) => ctx.tasks.get(id(req)));
  app.patch('/api/tasks/:id', async (req) => {
    const body = req.body as { roleEngines?: unknown } | null;
    assertUsableEngines(ctx, body?.roleEngines, ctx.tasks.get(id(req)).roleEngines);
    return ctx.tasks.update(id(req), req.body);
  });
  app.delete('/api/tasks/:id', async (req, reply) => {
    ctx.tasks.delete(id(req));
    return reply.status(204).send();
  });
  app.get('/api/tasks/:id/history', async (req) => ctx.tasks.history(id(req)));
  app.put('/api/tasks/:id/dependencies', async (req) =>
    ctx.tasks.setDependencies(id(req), req.body),
  );
  app.post('/api/tasks/:id/split', async (req) => ctx.tasks.split(id(req), req.body));
  app.post('/api/tasks/merge', async (req) => ctx.tasks.merge(req.body));
  app.post('/api/tasks/:id/approve', async (req) => ctx.tasks.approve(id(req)));
  app.post('/api/tasks/:id/unapprove', async (req) => ctx.tasks.unapprove(id(req)));
  app.post('/api/tasks/:id/regenerate', async (req, reply) =>
    reply.status(202).send(ctx.planner.regenerateTask(id(req), req.body)),
  );
  app.post('/api/tasks/:id/subtasks', async (req) => ctx.tasks.addSubtask(id(req), req.body));
  app.patch('/api/subtasks/:id', async (req) => ctx.tasks.updateSubtask(id(req), req.body));
  app.delete('/api/subtasks/:id', async (req) => ctx.tasks.deleteSubtask(id(req)));

  // ── Runs
  app.get('/api/runs/:id', async (req) => ctx.runs.get(id(req)));
}

/** Read every file of a multipart upload, enforcing the 20 MB per-file limit. */
async function uploadedFiles(req: FastifyRequest): Promise<UploadedFile[]> {
  const files: UploadedFile[] = [];
  for await (const part of req.files()) {
    const data = await part.toBuffer();
    if (part.file.truncated) throw badRequest(`${part.filename} is larger than 20 MB`);
    files.push({ filename: part.filename, mimetype: part.mimetype, data });
  }
  if (!files.length) throw badRequest('No files uploaded');
  return files;
}
