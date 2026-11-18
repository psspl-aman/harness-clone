import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface DaemonConfig {
  /** Root data dir (DB, logs, attachments, managed workspaces). */
  home: string;
  dbPath: string;
  host: string;
  port: number;
  /** Origins allowed to call the API / open the WebSocket. */
  allowedOrigins: string[];
  logLevel: string;
  version: string;
}

export const VERSION = '0.1.0';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const home = resolve(env.AGENTFORGE_HOME?.trim() || join(homedir(), '.agentforge'));
  const port = Number(env.AGENTFORGE_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid AGENTFORGE_PORT: ${env.AGENTFORGE_PORT}`);
  }
  const webPort = env.AGENTFORGE_WEB_PORT ?? '4318';
  const allowedOrigins = (
    env.AGENTFORGE_ALLOWED_ORIGINS ?? `http://localhost:${webPort},http://127.0.0.1:${webPort}`
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    home,
    dbPath: join(home, 'agentforge.db'),
    host: env.AGENTFORGE_HOST?.trim() || '127.0.0.1',
    port,
    allowedOrigins,
    logLevel: env.AGENTFORGE_LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),
    version: VERSION,
  };
}

/** Create the data directory layout. */
export function ensureHome(config: DaemonConfig): void {
  for (const dir of ['', 'workspaces', 'attachments', 'logs']) {
    mkdirSync(join(config.home, dir), { recursive: true, mode: 0o700 });
  }
}
