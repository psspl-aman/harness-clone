import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  // Shared contracts ship as TS source; bundle them into the daemon build.
  noExternal: ['@ai-harness/shared'],
});
