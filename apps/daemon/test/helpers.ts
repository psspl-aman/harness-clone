import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildApp, type BuildOptions, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import { makeFakeCli, type FakeCli, type FakeResponse } from './fake-cli';

export interface TestApp extends BuiltApp {
  home: string;
  cleanup(): Promise<void>;
}

/** Fresh daemon backed by a throwaway AI_HARNESS_HOME. */
export async function createTestApp(
  env: Record<string, string> = {},
  opts: BuildOptions = {},
): Promise<TestApp> {
  const home = mkdtempSync(join(tmpdir(), 'ai-harness-test-'));
  const config = loadConfig({
    AI_HARNESS_HOME: home,
    AI_HARNESS_PORT: '0',
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
      // On Windows a just-killed child process can still hold a handle to the
      // temp dir for a moment, so rmSync throws EPERM; retry briefly. No-op on POSIX.
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

/**
 * Make an engine "installed" (and signed in) with a fake CLI, so it can be assigned to roles.
 * `responses` are tried before the version/login answers.
 */
export async function installFakeEngine(
  t: TestApp,
  id: 'codex' | 'gemini-cli',
  responses: FakeResponse[] = [],
): Promise<FakeCli> {
  const dir = mkdtempSync(join(t.home, `fake-${id}-`));
  const cli = makeFakeCli(dir, id === 'codex' ? 'codex' : 'gemini');
  cli.setResponses([
    ...responses,
    { match: '--version', stdout: `${id} 1.0.0` },
    { match: 'login status', stdout: 'Logged in using ChatGPT' },
  ]);
  await t.app.inject({
    method: 'PATCH',
    url: `/api/engines/${id}`,
    payload: { binaryPath: cli.path, enabled: true },
  });
  await t.ctx.engines.refresh(id);
  return cli;
}
