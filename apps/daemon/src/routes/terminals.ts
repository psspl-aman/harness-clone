import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';

const Id = z.object({ id: z.string().regex(/^term_[a-z0-9]{1,40}$/) });

export function registerTerminalRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/terminals', async (req) => {
    const q = z
      .object({
        projectId: z.string().optional(),
        kind: z.enum(['shell', 'run', 'login']).optional(),
      })
      .parse(req.query);
    return ctx.terminals.list(q);
  });
  app.get('/api/terminals/:id', async (req) => ctx.terminals.get(Id.parse(req.params).id));
  app.post('/api/terminals/:id/input', async (req, reply) => {
    const { data } = z.object({ data: z.string().max(64 * 1024) }).parse(req.body);
    ctx.terminals.write(Id.parse(req.params).id, data);
    return reply.status(204).send();
  });
  app.post('/api/terminals/:id/resize', async (req, reply) => {
    const { cols, rows } = z
      .object({ cols: z.number().int().min(10).max(500), rows: z.number().int().min(4).max(200) })
      .parse(req.body);
    ctx.terminals.resize(Id.parse(req.params).id, cols, rows);
    return reply.status(204).send();
  });
  app.post('/api/terminals/:id/kill', async (req, reply) => {
    ctx.terminals.kill(Id.parse(req.params).id);
    return reply.status(204).send();
  });
  app.delete('/api/terminals/:id', async (req, reply) => {
    ctx.terminals.remove(Id.parse(req.params).id);
    return reply.status(204).send();
  });
}
