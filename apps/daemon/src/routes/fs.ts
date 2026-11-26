import { PATH_CHECK_MODES } from '@ai-harness/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';

export function registerFsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/fs/browse', async (req) => {
    const q = z
      .object({ path: z.string().optional(), hidden: z.enum(['0', '1']).optional() })
      .parse(req.query);
    return ctx.fs.browse(q.path, q.hidden === '1');
  });

  app.post('/api/fs/mkdir', async (req, reply) => {
    const body = z
      .object({ parent: z.string().min(1), name: z.string().min(1).max(100) })
      .parse(req.body);
    return reply.status(201).send(await ctx.fs.mkdir(body.parent, body.name));
  });

  app.get('/api/fs/check', async (req) => {
    const q = z
      .object({ path: z.string().min(1), mode: z.enum(PATH_CHECK_MODES) })
      .parse(req.query);
    return ctx.fs.check(q.path, q.mode);
  });
}
