import { defineConfig } from 'vitest/config';

const isWindows = process.platform === 'win32';

export default defineConfig({
  test: {
    environment: 'node',
    env: { NODE_ENV: 'test' },
    // Spawning real child processes (git, engine CLIs via cmd.exe shims) is markedly
    // slower on Windows, so integration tests get a longer budget there. No change on POSIX.
    testTimeout: isWindows ? 40_000 : 15_000,
    hookTimeout: isWindows ? 40_000 : 10_000,
    // Run each test file in a forked child process rather than a worker thread, which
    // node-pty's native addon needs on Windows. No behavioural change on POSIX.
    pool: 'forks',
  },
});
