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
import { MemoryService } from './services/memory';
import { HandoffService } from './services/handoff';
import { SafetyService } from './services/safety';
import { registerSafetyRoutes } from './routes/safety';
import { registerAgentMcpRoutes } from './routes/agent-mcp';
import { createRedactor } from './safety/redact';
import { DocsService } from './services/docs';
import { registerMemoryDocsRoutes } from './routes/memory-docs';
import { PmsService } from './services/pms/pms-service';
import { SheetService } from './services/sheets/sheet-service';
import { CommandAdvisor } from './services/onboarding/command-advisor';
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
import { registerGitRoutes } from './routes/git';
import { GitManager } from './services/git-manager';
import { registerSettingsRoutes } from './routes/settings';
import { registerSystemRoutes } from './routes/system';
import { FsService } from './services/fs';
import { GithubService, type GithubServiceOptions } from './services/github';
import { EnvKeyService } from './services/env-keys';
import { AttachmentStore } from './services/attachments';
import { ProjectService } from './services/projects';
import { SecretStore } from './services/secrets';
import { SettingsService } from './services/settings';
import { WsGateway } from './ws/gateway';

export interface BuildOptions {
  github?: GithubServiceOptions;
  engines?: { autoRefresh?: boolean; extraPath?: string[] };
  orchestrator?: { autoStart?: boolean };
  pms?: { autoPoll?: boolean };
  sheets?: { autoPoll?: boolean };
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
        .select({
          id: projectsTable.id,
          localPath: projectsTable.localPath,
          archivedAt: projectsTable.archivedAt,
        })
        .from(projectsTable)
        .where(eq(projectsTable.localPath, p))
        .get() ?? null,
    allProjectPaths: () =>
      dbHandle.db
        .select({ id: projectsTable.id, localPath: projectsTable.localPath })
        .from(projectsTable)
        .all(),
  });
  const attachments = new AttachmentStore({ root: join(config.home, 'attachments'), log: app.log });
  const projects = new ProjectService({
    db: dbHandle.db,
    bus,
    fs,
    github,
    attachments,
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

  const memory = new MemoryService(dbHandle.db, bus, settings);
  const files = new FileService(dbHandle.db);
  const runs = new RunRecorder(dbHandle.db, bus, () => settings.get().pricing);
  // Secrets are masked in run logs and terminals (Settings → Safety).
  // Env keys the user typed into the chat live only in the project's .env; their values
  // are read back from there to mask them in logs and keep them out of commits.
  const envKeys = new EnvKeyService({ db: dbHandle.db, bus });
  bus.subscribe((e) => {
    if (e.type === 'project.deleted') envKeys.removeAll(e.payload.projectId);
  });
  const secretValues = () => [...secrets.values(), ...envKeys.knownValues()];
  const redactor = createRedactor(secretValues, () => settings.get().safety.redactSecrets);
  runs.setRedactor(redactor);
  terminals.setRedactor(redactor);
  const safety = new SafetyService({
    db: dbHandle.db,
    bus,
    settings,
    home: config.home,
    url: () => {
      const a = app.server.address();
      return a && typeof a === 'object' ? `http://127.0.0.1:${a.port}` : null;
    },
  });
  engineRegistry.setGuardProvider(safety.provider);
  const taskService = new TaskService(dbHandle.db, bus);
  const planner = new PlannerService({
    db: dbHandle.db,
    bus,
    tasks: taskService,
    engines: engineRegistry,
    runs,
    settings,
    memory,
    attachments,
    log: app.log,
  });
  const orchestrator = new Orchestrator({
    db: dbHandle.db,
    bus,
    tasks: taskService,
    engines: engineRegistry,
    runs,
    settings,
    memory,
    github,
    home: config.home,
    log: app.log,
    autoStart: opts.orchestrator?.autoStart ?? process.env.NODE_ENV !== 'test',
    secretValues,
  });
  // Markdown handoff notes (.agentforge/PROJECT.md, tasks/<KEY>.md) so any agent can pick up a task.
  const handoff = new HandoffService({
    db: dbHandle.db,
    bus,
    settings,
    tasks: taskService,
    engines: engineRegistry,
    log: app.log,
    redact: redactor,
  });
  handoff.setSource(orchestrator);
  handoff.attach();
  orchestrator.setHandoff(handoff);
  const errorService = new ErrorService(dbHandle.db, bus, taskService, terminals);
  errorService.attach();
  errorService.setTaskFixer((id) => orchestrator.fixFailed(id));
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
  const sheets = new SheetService({
    db: dbHandle.db,
    bus,
    tasks: taskService,
    planner,
    log: app.log,
    autoPoll: opts.sheets?.autoPoll ?? process.env.NODE_ENV !== 'test',
  });
  sheets.attach();
  const commandAdvisor = new CommandAdvisor({
    db: dbHandle.db,
    bus,
    engines: engineRegistry,
    runs,
    settings,
    log: app.log,
  });
  // Work interrupted by a restart can't be resumed mid-stream: mark it failed.
  runs.failOrphans();
  planner.failOrphans();
  // Onboarding and the Documenter write memory directly; refresh the mirror file and the UI.
  bus.subscribe((e) => {
    if (e.type === 'project.onboarding' && e.payload.status === 'done')
      memory.changed(e.payload.projectId);
    if (e.type === 'task.status_changed' && e.payload.to === 'DONE') {
      memory.changed(e.payload.projectId);
      // It passed review and tests, so its checklist is complete too.
      taskService.completeSubtasks(e.payload.taskId, 'all');
      // A project built from scratch had nothing to detect at first: once code lands, look again
      // so its install/run commands fill in (only empty ones are filled).
      try {
        const c = projects.get(e.payload.projectId).commands;
        if (!c.run && !c.services?.length) void projects.runOnboarding(e.payload.projectId);
      } catch {
        /* project removed */
      }
    }
  });
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
    attachments,
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
    files,
    docs: new DocsService(dbHandle.db, files),
    safety,
    mcp,
    pms,
    sheets,
    commandAdvisor,
    memory,
    git: new GitManager({
      db: dbHandle.db,
      bus,
      projects,
      github,
      lock: (projectId, fn) => orchestrator.withMergeLock(projectId, fn),
      secretValues,
    }),
    envKeys,
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
  registerGitRoutes(app, ctx);
  registerFsRoutes(app, ctx);
  registerGithubRoutes(app, ctx);
  registerEngineRoutes(app, ctx);
  registerTerminalRoutes(app, ctx);
  registerPlanningRoutes(app, ctx);
  registerPipelineRoutes(app, ctx);
  registerUsageRoutes(app, ctx);
  registerRuntimeRoutes(app, ctx);
  registerIntegrationRoutes(app, ctx);
  registerMemoryDocsRoutes(app, ctx);
  registerSafetyRoutes(app, ctx);
  registerAgentMcpRoutes(app, ctx);

  app.addHook('onReady', async () => {
    attachments.sweepStaging();
    projects.resumeInterruptedOnboarding();
    orchestrator.start();
    mcp.start();
  });

  app.addHook('onClose', async () => {
    sheets.stop();
    commandAdvisor.stop();
    await pms.stop();
    await orchestrator.stop();
    await mcp.stop();
    handoff.stop();
    safety.stop();
    await planner.stop();
    await engineRegistry.stop();
    runner.stopAll();
    terminals.closeAll();
    await projects.drain();
    // Last before the DB closes: the planner and onboarding above can still write memory.
    memory.stop();
    dbHandle.close();
  });
  return { app, ctx, dbHandle };
}
