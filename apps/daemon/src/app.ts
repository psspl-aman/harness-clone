import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { registerPlanningRoutes } from './routes/planning';
import { registerPipelineRoutes } from './routes/pipeline';
import { registerUsageRoutes } from './routes/usage';
import { registerRuntimeRoutes } from './routes/runtime';
import { ErrorService } from './services/errors/error-service';
import { RunService } from './services/run-service';
import { FileService } from './services/files';
import { registerIntegrationRoutes } from './routes/integrations';
import { McpService } from './services/mcp/mcp-service';
import { PmsService } from './services/pms/pms-service';
import { UsageService } from './services/usage';
import { Orchestrator } from './services/orchestrator/orchestrator';
import { PlannerService } from './services/planner/service';
import { RunRecorder } from './services/runs';
import { TaskService } from './services/tasks';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { join } from 'node:path';
import { ensureHome, type DaemonConfig } from './config';
import type { AppContext } from './context';
import { openDb, type DbHandle } from './db/client';
import { projects as projectsTable } from './db/schema';
import { EventBus } from './events/bus';
import { registerErrorHandler } from './http/errors';
import { originChecker, registerLocalOnlyGuard } from './http/security';
import { registerFsRoutes } from './routes/fs';
import { registerEngineRoutes } from './routes/engines';
import { registerTerminalRoutes } from './routes/terminals';
import { EngineRegistry } from './engines/registry';
import { TerminalService } from './services/terminals';
import { registerGithubRoutes } from './routes/github';
import { registerProjectRoutes } from './routes/projects';
import { registerSettingsRoutes } from './routes/settings';
import { registerSystemRoutes } from './routes/system';
import { FsService } from './services/fs';
import { GithubService, type GithubServiceOptions } from './services/github';
import { ProjectService } from './services/projects';
import { SecretStore } from './services/secrets';
import { SettingsService } from './services/settings';
import { WsGateway } from './ws/gateway';

export interface BuildOptions {
  github?: GithubServiceOptions;
  engines?: { autoRefresh?: boolean; extraPath?: string[] };
  orchestrator?: { autoStart?: boolean };
  pms?: { autoPoll?: boolean };
}

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  dbHandle: DbHandle;
}

export async function buildApp(config: DaemonConfig, opts: BuildOptions = {}): Promise<BuiltApp> {
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

  const settings = new SettingsService(dbHandle.db, bus, app.log);
  const secrets = new SecretStore(dbHandle.db, config.home);
  const workspaceRoot = () => settings.get().workspaceRoot ?? join(config.home, 'workspaces');
  const github = new GithubService(dbHandle.db, secrets, bus, opts.github);
  const fs = new FsService({
    agentforgeHome: config.home,
    workspaceRoot,
    projectAtPath: (p) =>
      dbHandle.db
        .select({ id: projectsTable.id, localPath: projectsTable.localPath })
        .from(projectsTable)
        .where(eq(projectsTable.localPath, p))
        .get() ?? null,
    allProjectPaths: () =>
      dbHandle.db
        .select({ id: projectsTable.id, localPath: projectsTable.localPath })
        .from(projectsTable)
        .all(),
  });
  const projects = new ProjectService({
    db: dbHandle.db,
    bus,
    fs,
    github,
    workspaceRoot,
    log: app.log,
  });

  const terminals = new TerminalService(dbHandle.db, bus);
  const engineRegistry = new EngineRegistry({
    db: dbHandle.db,
    bus,
    secrets,
    settings,
    terminals,
    home: config.home,
    log: app.log,
    autoRefresh: opts.engines?.autoRefresh ?? process.env.NODE_ENV !== 'test',
    extraPath: opts.engines?.extraPath,
  });
  engineRegistry.init();
  bus.subscribe((e) => {
    if (e.type === 'settings.updated') engineRegistry.reschedule();
  });

  const runs = new RunRecorder(dbHandle.db, bus, () => settings.get().pricing);
  const taskService = new TaskService(dbHandle.db, bus);
  const planner = new PlannerService({
    db: dbHandle.db,
    bus,
    tasks: taskService,
    engines: engineRegistry,
    runs,
    settings,
    log: app.log,
  });
  const orchestrator = new Orchestrator({
    db: dbHandle.db,
    bus,
    tasks: taskService,
    engines: engineRegistry,
    runs,
    settings,
    github,
    home: config.home,
    log: app.log,
    autoStart: opts.orchestrator?.autoStart ?? process.env.NODE_ENV !== 'test',
  });
  const errorService = new ErrorService(dbHandle.db, bus, taskService, terminals);
  errorService.attach();
  const runner = new RunService(dbHandle.db, bus, terminals, projects, errorService);
  runner.attach();
  const mcp = new McpService(dbHandle.db, bus, secrets);
  const pms = new PmsService({
    db: dbHandle.db,
    bus,
    mcp,
    tasks: taskService,
    planner,
    orchestrator,
    log: app.log,
    autoPoll: opts.pms?.autoPoll ?? process.env.NODE_ENV !== 'test',
  });
  pms.attach();
  // Work interrupted by a restart can't be resumed mid-stream: mark it failed.
  runs.failOrphans();
  planner.failOrphans();
  // The wizard's initial requirement is planned as soon as onboarding has analysed the folder.
  bus.subscribe((e) => {
    if (
      e.type === 'project.onboarding' &&
      (e.payload.status === 'done' || e.payload.status === 'failed')
    ) {
      try {
        planner.planInitialRequirement(e.payload.projectId);
      } catch (err) {
        app.log.warn({ err, projectId: e.payload.projectId }, 'could not start initial planning');
      }
    }
  });

  const ctx: AppContext = {
    config,
    db: dbHandle.db,
    bus,
    gateway,
    settings,
    secrets,
    fs,
    github,
    projects,
    engines: engineRegistry,
    terminals,
    tasks: taskService,
    planner,
    runs,
    orchestrator,
    usage: new UsageService(dbHandle.db, engineRegistry),
    errors: errorService,
    runner,
    files: new FileService(dbHandle.db),
    mcp,
    pms,
    workspaceRoot,
    startedAt: Date.now(),
  };

  registerErrorHandler(app);
  await app.register(cors, {
    origin: config.allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 10 } });
  // Must come after the websocket plugin: its onRequest hook marks upgrade
  // requests so rejected upgrades get their raw socket destroyed.
  registerLocalOnlyGuard(app, { bindHost: config.host, isOriginAllowed });

  gateway.register(app);
  registerSystemRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerFsRoutes(app, ctx);
  registerGithubRoutes(app, ctx);
  registerEngineRoutes(app, ctx);
  registerTerminalRoutes(app, ctx);
  registerPlanningRoutes(app, ctx);
  registerPipelineRoutes(app, ctx);
  registerUsageRoutes(app, ctx);
  registerRuntimeRoutes(app, ctx);
  registerIntegrationRoutes(app, ctx);

  app.addHook('onReady', async () => {
    projects.resumeInterruptedOnboarding();
    orchestrator.start();
    mcp.start();
  });

  app.addHook('onClose', async () => {
    await pms.stop();
    await orchestrator.stop();
    await mcp.stop();
    await planner.stop();
    await engineRegistry.stop();
    runner.stopAll();
    terminals.closeAll();
    await projects.drain();
    dbHandle.close();
  });
  return { app, ctx, dbHandle };
}
