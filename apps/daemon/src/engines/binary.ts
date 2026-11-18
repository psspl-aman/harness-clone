import { constants, existsSync, readdirSync, statSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

const isExecutable = (p: string) =>
  access(p, constants.X_OK).then(
    () => statSync(p).isFile(),
    () => false,
  );

/** Directories commonly holding user-installed CLIs, even when not on the daemon's PATH. */
export function extraBinDirs(): string[] {
  const h = homedir();
  return [
    join(h, '.local/bin'),
    join(h, 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    join(h, '.npm-global/bin'),
    join(h, '.bun/bin'),
    join(h, '.volta/bin'),
  ];
}

/** Locate an executable by name on PATH (+ extra dirs), or verify an absolute path. */
export async function which(nameOrPath: string, extra: string[] = []): Promise<string | null> {
  if (isAbsolute(nameOrPath)) return (await isExecutable(nameOrPath)) ? nameOrPath : null;
  const dirs = [...extra, ...(process.env.PATH ?? '').split(delimiter), ...extraBinDirs()].filter(
    Boolean,
  );
  for (const dir of dirs) {
    const candidate = join(dir, nameOrPath);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Compare dotted versions numerically ("2.1.327" > "2.1.99"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Newest binary inside versioned extension folders, e.g.
 * ~/.vscode/extensions/anthropic.claude-code-2.1.327-linux-x64/resources/native-binary/claude gforge:allow — example path, not a secret
 */
export function newestExtensionBinary(
  extensionsDirs: string[],
  prefix: string,
  relPath: string,
): string | null {
  let best: { version: string; path: string } | null = null;
  for (const dir of extensionsDirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const version = name.slice(prefix.length).match(/^(\d+(?:\.\d+)+)/)?.[1];
      const path = join(dir, name, relPath);
      if (version && existsSync(path) && (!best || compareVersions(version, best.version) > 0))
        best = { version, path };
    }
  }
  return best?.path ?? null;
}

export const firstSemver = (text: string): string | null =>
  text.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/)?.[0] ?? null;
