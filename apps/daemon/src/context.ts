import type { DaemonConfig } from './config';
import type { Db } from './db/client';
import type { EventBus } from './events/bus';
import type { FsService } from './services/fs';
import type { GithubService } from './services/github';
import type { ProjectService } from './services/projects';
import type { SecretStore } from './services/secrets';
import type { SettingsService } from './services/settings';
import type { WsGateway } from './ws/gateway';
import type { EngineRegistry } from './engines/registry';
import type { TerminalService } from './services/terminals';
import type { PlannerService } from './services/planner/service';
import type { RunRecorder } from './services/runs';
import type { TaskService } from './services/tasks';
import type { Orchestrator } from './services/orchestrator/orchestrator';

/** Everything route handlers and services need; built once in `buildApp`. */
export interface AppContext {
  config: DaemonConfig;
  db: Db;
  bus: EventBus;
  gateway: WsGateway;
  settings: SettingsService;
  secrets: SecretStore;
  fs: FsService;
  github: GithubService;
  projects: ProjectService;
  engines: EngineRegistry;
  terminals: TerminalService;
  tasks: TaskService;
  planner: PlannerService;
  runs: RunRecorder;
  orchestrator: Orchestrator;
  workspaceRoot: () => string;
  startedAt: number;
}
