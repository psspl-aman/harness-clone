import { GithubConnectInputSchema } from '@agentforge/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';

export function registerGithubRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/github/status', async () => ctx.github.status());
  app.post('/api/github/connect', async (req) =>
    ctx.github.connect(GithubConnectInputSchema.parse(req.body).token),
  );
  app.post('/api/github/import-cli', async () => ctx.github.importFromGhCli());
  app.delete('/api/github/connection', async () => ctx.github.disconnect());
  app.get('/api/github/repos', async (req) => {
    const q = z.object({ q: z.string().max(100).optional() }).parse(req.query);
    return ctx.github.listRepos(q.q);
  });
  app.get('/api/github/owners', async () => ctx.github.listOwners());
}
