import { MEMORY_KINDS, MEMORY_SCOPES } from '@ai-harness/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';

const Id = z.object({ id: z.string().min(1).max(64) });
const ListQuery = z.object({
  search: z.string().max(200).optional(),
  kind: z.enum(MEMORY_KINDS).optional(),
  scope: z.enum(MEMORY_SCOPES).optional(),
});
const attachment = (name: string) => `attachment; filename="${name.replace(/[^\w.-]+/g, '_')}"`;

/** Phase 9: project / global memory and the Docs tab. */
export function registerMemoryDocsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/projects/:id/memory', async (req) => {
    const { id } = Id.parse(req.params);
    ctx.projects.get(id);
    return ctx.memory.list({ projectId: id, ...ListQuery.parse(req.query) });
  });
  app.post('/api/projects/:id/memory', async (req, reply) =>
    reply.status(201).send(ctx.memory.create(Id.parse(req.params).id, req.body)),
  );
  app.get('/api/memory', async (req) =>
    ctx.memory.list({ projectId: null, ...ListQuery.parse(req.query) }),
  );
  app.post('/api/memory', async (req, reply) =>
    reply.status(201).send(ctx.memory.create(null, req.body)),
  );
  app.patch('/api/memory/:id', async (req) => ctx.memory.update(Id.parse(req.params).id, req.body));
  app.delete('/api/memory/:id', async (req, reply) => {
    ctx.memory.remove(Id.parse(req.params).id);
    return reply.status(204).send();
  });

  app.get('/api/projects/:id/docs', async (req) => {
    const { id } = Id.parse(req.params);
    ctx.projects.get(id);
    return ctx.docs.list(id);
  });
  app.get('/api/projects/:id/docs/item', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const q = z
      .object({ doc: z.string().min(1).max(1100), download: z.string().optional() })
      .parse(req.query);
    const doc = await ctx.docs.get(id, q.doc);
    if (!q.download) return doc;
    const name = doc.path ? doc.path.split('/').pop()! : `${doc.taskKey ?? 'report'}-report.md`;
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header('content-disposition', attachment(name))
      .send(doc.content);
  });
  app.get('/api/projects/:id/docs/export', async (req, reply) => {
    const { id } = Id.parse(req.params);
    ctx.projects.get(id);
    const { filename, content } = await ctx.docs.exportAll(id);
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header('content-disposition', attachment(filename))
      .send(content);
  });
}
