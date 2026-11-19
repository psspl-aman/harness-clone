import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';

const Id = z.object({ id: z.string().min(1).max(64) });
const id = (req: { params: unknown }) => Id.parse(req.params).id;

/** Phase 8: MCP servers, PMS connections, project ↔ tracker links, sync and conflicts. */
export function registerIntegrationRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ── MCP servers ──
  app.get('/api/mcp/servers', async () => ctx.mcp.list());
  app.post('/api/mcp/servers', async (req, reply) =>
    reply.status(201).send(ctx.mcp.create(req.body)),
  );
  app.get('/api/mcp/servers/:id', async (req) => ctx.mcp.get(id(req)));
  app.put('/api/mcp/servers/:id', async (req) => ctx.mcp.update(id(req), req.body));
  app.delete('/api/mcp/servers/:id', async (req, reply) => {
    await ctx.mcp.remove(id(req));
    return reply.status(204).send();
  });
  app.post('/api/mcp/servers/:id/test', async (req) => ctx.mcp.test(id(req)));

  // ── PMS connections ──
  app.get('/api/pms/providers', async () => ctx.pms.presets());
  app.get('/api/pms/connections', async () => ctx.pms.listConnections());
  app.post('/api/pms/connections', async (req, reply) =>
    reply.status(201).send(ctx.pms.createConnection(req.body)),
  );
  app.put('/api/pms/connections/:id', async (req) => ctx.pms.updateConnection(id(req), req.body));
  app.delete('/api/pms/connections/:id', async (req, reply) => {
    ctx.pms.removeConnection(id(req));
    return reply.status(204).send();
  });
  app.post('/api/pms/detect', async (req) => ctx.pms.detect(req.body));
  app.post('/api/pms/preview', async (req) => ctx.pms.preview(req.body));

  // ── Project links ──
  app.get('/api/projects/:id/pms', async (req) => {
    ctx.projects.get(id(req));
    return ctx.pms.listMappings(id(req));
  });
  app.post('/api/projects/:id/pms', async (req, reply) => {
    ctx.projects.get(id(req));
    return reply.status(201).send(ctx.pms.createMapping(id(req), req.body));
  });
  app.patch('/api/pms/mappings/:id', async (req) => ctx.pms.updateMapping(id(req), req.body));
  app.delete('/api/pms/mappings/:id', async (req, reply) => {
    ctx.pms.removeMapping(id(req));
    return reply.status(204).send();
  });
  app.post('/api/pms/mappings/:id/sync', async (req) => ctx.pms.sync(id(req)));
  app.post('/api/tasks/:id/pms-conflict', async (req) =>
    ctx.pms.resolveConflict(id(req), req.body),
  );
}
