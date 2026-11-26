import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { buildAgentTools } from '../services/agent-tools';

/**
 * `/mcp`: the AgentForge MCP server agents use during a run (Streamable HTTP,
 * stateless). Authenticated by the run's guard token, which also scopes the
 * tools to that run's project and task.
 */
export function registerAgentMcpRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/mcp', async (req, reply) => {
    const token = req.headers['x-agentforge-guard'];
    const session = ctx.safety.sessionFor(typeof token === 'string' ? token : undefined);
    if (!session)
      return reply.status(401).send({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unknown or expired run token' },
        id: null,
      });
    const server = buildAgentTools(
      { db: ctx.db, memory: ctx.memory, tasks: ctx.tasks, envKeys: ctx.envKeys },
      session,
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  // Stateless server: no SSE stream or session to delete.
  const notAllowed = {
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed' },
    id: null,
  };
  app.get('/mcp', async (_req, reply) => reply.status(405).send(notAllowed));
  app.delete('/mcp', async (_req, reply) => reply.status(405).send(notAllowed));
}
