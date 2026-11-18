import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildApp, type BuildOptions, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';

export interface TestApp extends BuiltApp {
  home: string;
  cleanup(): Promise<void>;
}

/** Fresh daemon backed by a throwaway AGENTFORGE_HOME. */
export async function createTestApp(
  env: Record<string, string> = {},
  opts: BuildOptions = {},
): Promise<TestApp> {
  const home = mkdtempSync(join(tmpdir(), 'agentforge-test-'));
  const config = loadConfig({
    AGENTFORGE_HOME: home,
    AGENTFORGE_PORT: '0',
    NODE_ENV: 'test',
    ...env,
  });
  const built = await buildApp(config, {
    ...opts,
    github: { ghCommand: '/nonexistent/gh', ...opts.github },
  });
  return {
    ...built,
    home,
    async cleanup() {
      await built.app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Temp directory removed by the caller's cleanup. */
export function tempDir(prefix = 'af-fixture-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Write a tree of files: { 'src/a.ts': 'content' }. */
export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

export const GIT_ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
