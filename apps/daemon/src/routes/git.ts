import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';

const IdParams = z.object({ id: z.string().min(1).max(64) });
const BranchQuery = z.object({
  name: z.string().min(1).max(200),
  /** Compare with this branch; "" shows plain history. */
  base: z.string().max(200).optional(),
});

/** The Git tab: branches, the work on each, and everyday git actions. */
export function registerGitRoutes(app: FastifyInstance, ctx: AppContext): void {
  const id = (req: { params: unknown }) => IdParams.parse(req.params).id;

  app.get('/api/projects/:id/git', async (req) => ctx.git.overview(id(req)));
  app.get('/api/projects/:id/git/branch', async (req) => {
    const q = BranchQuery.parse(req.query);
    return ctx.git.branch(id(req), q.name, q.base === undefined ? undefined : q.base || null);
  });

  app.post('/api/projects/:id/git/init', async (req) => ctx.git.init(id(req)));
  app.post('/api/projects/:id/git/branches', async (req) =>
    ctx.git.createBranch(id(req), req.body),
  );
  app.post('/api/projects/:id/git/branches/delete', async (req) =>
    ctx.git.deleteBranch(id(req), req.body),
  );
  app.post('/api/projects/:id/git/checkout', async (req) => ctx.git.checkout(id(req), req.body));
  app.post('/api/projects/:id/git/merge', async (req) => ctx.git.merge(id(req), req.body));
  app.post('/api/projects/:id/git/working-branch', async (req) =>
    ctx.git.setWorkingBranch(id(req), req.body),
  );
  app.post('/api/projects/:id/git/commit', async (req) => ctx.git.commit(id(req), req.body));
  app.post('/api/projects/:id/git/abort', async (req) => ctx.git.abort(id(req)));
  app.post('/api/projects/:id/git/fetch', async (req) => ctx.git.fetch(id(req)));
  app.post('/api/projects/:id/git/pull', async (req) => ctx.git.pull(id(req)));
  app.post('/api/projects/:id/git/push', async (req) => ctx.git.push(id(req), req.body));
  app.post('/api/projects/:id/git/pull-request', async (req) =>
    ctx.git.pullRequest(id(req), req.body),
  );
}
