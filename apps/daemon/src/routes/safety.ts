import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { readGuardToken } from '../lib/guard-header';

/** Phase 10: the agent guard hook endpoints and your approvals. */
export function registerSafetyRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Called by the guard hook (authenticated by its per-run token).
  app.post('/api/safety/check', async (req) => ctx.safety.check(readGuardToken(req.headers), req.body));
  app.post('/api/safety/wait', async (req) => ctx.safety.wait(readGuardToken(req.headers), req.body));
  // The UI.
  app.get('/api/safety/approvals', async () => ctx.safety.approvals());
  app.post('/api/safety/approvals/:id', async (req, reply) => {
    // Only the AI Harness web app may answer (the local guard already checked the Origin
    // is allowed); scripts — including agents — calling the API directly have no Origin.
    if (!req.headers.origin)
      return reply.status(403).send({
        error: { code: 'APPROVE_IN_APP', message: 'Approve or deny this in the AI Harness app' },
      });
    return ctx.safety.decide(z.object({ id: z.string().max(64) }).parse(req.params).id, req.body);
  });
}
