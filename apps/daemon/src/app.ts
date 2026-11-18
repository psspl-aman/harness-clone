import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { ensureHome, type DaemonConfig } from './config';
import type { AppContext } from './context';
import { openDb, type DbHandle } from './db/client';
import { EventBus } from './events/bus';
import { registerErrorHandler } from './http/errors';
import { originChecker, registerLocalOnlyGuard } from './http/security';
import { registerProjectRoutes } from './routes/projects';
import { registerSettingsRoutes } from './routes/settings';
import { registerSystemRoutes } from './routes/system';
import { ProjectService } from './services/projects';
import { SettingsService } from './services/settings';
import { WsGateway } from './ws/gateway';

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  dbHandle: DbHandle;
}

export async function buildApp(config: DaemonConfig): Promise<BuiltApp> {
  ensureHome(config);
  const app = Fastify({
    logger:
      config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            redact: ['req.headers.authorization', 'req.headers.cookie'],
            transport:
              process.env.NODE_ENV === 'production'
                ? undefined
                : {
                    target: 'pino-pretty',
                    options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
                  },
          },
    bodyLimit: 25 * 1024 * 1024,
  });

  const dbHandle = openDb(config.dbPath);
  const bus = new EventBus({
    onListenerError: (err, e) => app.log.error({ err, type: e.type }, 'event listener failed'),
  });
  const isOriginAllowed = originChecker(config.allowedOrigins);
  const gateway = new WsGateway(bus, { isOriginAllowed, version: config.version });

  const ctx: AppContext = {
    config,
    db: dbHandle.db,
    bus,
    gateway,
    settings: new SettingsService(dbHandle.db, bus, app.log),
    projects: new ProjectService(dbHandle.db),
    startedAt: Date.now(),
  };

  registerErrorHandler(app);
  await app.register(cors, {
    origin: config.allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  // Must come after the websocket plugin: its onRequest hook marks upgrade
  // requests so rejected upgrades get their raw socket destroyed.
  registerLocalOnlyGuard(app, { bindHost: config.host, isOriginAllowed });

  gateway.register(app);
  registerSystemRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerProjectRoutes(app, ctx);

  app.addHook('onClose', async () => dbHandle.close());
  return { app, ctx, dbHandle };
}
