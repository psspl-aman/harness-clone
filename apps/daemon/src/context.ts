import type { DaemonConfig } from './config';
import type { Db } from './db/client';
import type { EventBus } from './events/bus';
import type { FsService } from './services/fs';
import type { GithubService } from './services/github';
import type { ProjectService } from './services/projects';
import type { SecretStore } from './services/secrets';
import type { SettingsService } from './services/settings';
import type { WsGateway } from './ws/gateway';

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
  workspaceRoot: () => string;
  startedAt: number;
}
