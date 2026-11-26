import type { SystemInfo } from '@ai-harness/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { PRODUCT_SLUG } from '../lib/product';

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/health', async () => ({ ok: true, epoch: ctx.bus.epoch }));

  app.get('/api/system', async (): Promise<SystemInfo> => {
    return {
      name: PRODUCT_SLUG,
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
