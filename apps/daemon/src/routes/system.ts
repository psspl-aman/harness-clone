import type { SystemInfo } from '@agentforge/shared';
import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import type { AppContext } from '../context';

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/health', async () => ({ ok: true, epoch: ctx.bus.epoch }));

  app.get('/api/system', async (): Promise<SystemInfo> => {
    const s = ctx.settings.get();
    return {
      name: 'agentforge',
      version: ctx.config.version,
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      homeDir: ctx.config.home,
      dbPath: ctx.config.dbPath,
      workspaceRoot: s.workspaceRoot ?? join(ctx.config.home, 'workspaces'),
      startedAt: ctx.startedAt,
      uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
      wsClients: ctx.gateway.clientCount,
    };
  });
}
