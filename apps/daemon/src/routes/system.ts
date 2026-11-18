import type { SystemInfo } from '@agentforge/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/health', async () => ({ ok: true, epoch: ctx.bus.epoch }));

  app.get('/api/system', async (): Promise<SystemInfo> => {
    return {
      name: 'agentforge',
      version: ctx.config.version,
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      homeDir: ctx.config.home,
      dbPath: ctx.config.dbPath,
      workspaceRoot: ctx.workspaceRoot(),
      startedAt: ctx.startedAt,
      uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
      wsClients: ctx.gateway.clientCount,
    };
  });
}
