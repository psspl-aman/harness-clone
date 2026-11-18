import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';

export interface TestApp extends BuiltApp {
  home: string;
  cleanup(): Promise<void>;
}

/** Fresh daemon backed by a throwaway AGENTFORGE_HOME. */
export async function createTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const home = mkdtempSync(join(tmpdir(), 'agentforge-test-'));
  const config = loadConfig({
    AGENTFORGE_HOME: home,
    AGENTFORGE_PORT: '0',
    NODE_ENV: 'test',
    ...env,
  });
  const built = await buildApp(config);
  return {
    ...built,
    home,
    async cleanup() {
      await built.app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
