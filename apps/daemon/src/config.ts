import { existsSync, mkdirSync } from 'node:fs';
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
  /** Pre-rename (AgentForge) settings still in use; logged once at startup. */
  deprecations: string[];
}

export const VERSION = '0.1.0';

/** Env vars use this prefix; `AGENTFORGE_*` (the old product name) is still read as a fallback. */
const ENV_PREFIX = 'AI_HARNESS_';
const LEGACY_ENV_PREFIX = 'AGENTFORGE_';
const HOME_DIR = '.ai-harness';
const LEGACY_HOME_DIR = '.agentforge';
const DB_FILE = 'ai-harness.db';
const LEGACY_DB_FILE = 'agentforge.db';

/** Reads `AI_HARNESS_<key>`, falling back to `AGENTFORGE_<key>` (and recording that). */
function envReader(env: NodeJS.ProcessEnv, deprecations: string[]) {
  return (key: string): string | undefined => {
    const current = env[ENV_PREFIX + key]?.trim();
    if (current) return current;
    const legacy = env[LEGACY_ENV_PREFIX + key]?.trim();
    if (legacy) {
      deprecations.push(`${LEGACY_ENV_PREFIX + key} is deprecated; rename it to ${ENV_PREFIX + key}`);
      return legacy;
    }
    return undefined;
  };
}

/**
 * Existing installs keep their data where it is: the pre-rename home and DB file are used
 * as long as no new-style one exists, so upgrading never strands projects or encrypted secrets.
 */
function resolveHome(explicit: string | undefined, deprecations: string[]): string {
  if (explicit) return resolve(explicit);
  const home = join(homedir(), HOME_DIR);
  const legacy = join(homedir(), LEGACY_HOME_DIR);
  if (!existsSync(home) && existsSync(legacy)) {
    deprecations.push(`Using the existing data dir ${legacy}; move it to ${home} to drop this notice`);
    return legacy;
  }
  return home;
}

function resolveDbPath(home: string): string {
  const current = join(home, DB_FILE);
  const legacy = join(home, LEGACY_DB_FILE);
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const deprecations: string[] = [];
  const read = envReader(env, deprecations);
  const home = resolveHome(read('HOME'), deprecations);
  const rawPort = read('PORT');
  const port = Number(rawPort ?? 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid ${ENV_PREFIX}PORT: ${rawPort}`);
  }
  const webPort = read('WEB_PORT') ?? '4318';
  const allowedOrigins = (
    read('ALLOWED_ORIGINS') ?? `http://localhost:${webPort},http://127.0.0.1:${webPort}`
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    home,
    dbPath: resolveDbPath(home),
    host: read('HOST') || '127.0.0.1',
    port,
    allowedOrigins,
    logLevel: read('LOG_LEVEL') ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),
    version: VERSION,
    deprecations,
  };
}

/** Create the data directory layout. */
export function ensureHome(config: DaemonConfig): void {
  for (const dir of ['', 'workspaces', 'attachments', 'logs']) {
    mkdirSync(join(config.home, dir), { recursive: true, mode: 0o700 });
  }
}
