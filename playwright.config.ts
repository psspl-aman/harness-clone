import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * E2E runs against an isolated daemon (throwaway AGENTFORGE_HOME, ports
 * 4417/4418) so it never touches your real ~/.agentforge data.
 * The env var is set once in the main process and inherited by workers.
 */
process.env.AF_E2E_HOME ??= mkdtempSync(join(tmpdir(), 'agentforge-e2e-'));
/** Scratch area for project folders created by tests (outside AGENTFORGE_HOME). */
process.env.AF_E2E_WORK ??= mkdtempSync(join(tmpdir(), 'agentforge-e2e-work-'));
const DAEMON_PORT = 4417;
const WEB_PORT = 4418;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    channel: process.env.PW_CHANNEL ?? 'chromium',
  },
  webServer: [
    {
      command: 'pnpm --filter @agentforge/daemon exec tsx src/main.ts',
      url: `http://127.0.0.1:${DAEMON_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        AGENTFORGE_HOME: process.env.AF_E2E_HOME,
        AGENTFORGE_PORT: String(DAEMON_PORT),
        AGENTFORGE_WEB_PORT: String(WEB_PORT),
        AGENTFORGE_LOG_LEVEL: 'warn',
      },
    },
    {
      command:
        `pnpm --filter @agentforge/web exec node scripts/copy-monaco.mjs && ` +
        `pnpm --filter @agentforge/web exec next dev -p ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { NEXT_PUBLIC_AGENTFORGE_DAEMON_URL: `http://127.0.0.1:${DAEMON_PORT}` },
    },
  ],
});

export const E2E = { daemonUrl: `http://127.0.0.1:${DAEMON_PORT}` };
