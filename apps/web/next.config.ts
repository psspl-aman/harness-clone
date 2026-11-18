import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

/** Monorepo root — pinned so Next never picks up an unrelated parent workspace. */
const root = fileURLToPath(new URL('../..', import.meta.url));

const config: NextConfig = {
  reactStrictMode: true,
  // Shared contracts are consumed as TypeScript source.
  transpilePackages: ['@agentforge/shared'],
  devIndicators: false,
  turbopack: { root },
  outputFileTracingRoot: root,
};

export default config;
