import { statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];
/** Files each package manager rewrites at the end of an install (npm, pnpm, yarn berry, yarn classic). */
const INSTALL_RECORDS = [
  '.package-lock.json',
  '.modules.yaml',
  '.yarn-state.yml',
  '.yarn-integrity',
];
/** Package managers write the lockfile and their install record moments apart. */
const SLACK_MS = 2000;

const stat = (path: string) => {
  try {
    return statSync(path);
  } catch {
    return null;
  }
};
const mtime = (path: string) => stat(path)?.mtimeMs ?? null;

/** `dir` and its parents, up to and including the project root. */
function upToRoot(root: string, dir: string): string[] {
  const out: string[] = [];
  for (let d = dir; ; d = dirname(d)) {
    out.push(d);
    if (d === root || relative(root, d).startsWith('..') || dirname(d) === d) return out;
  }
}

/**
 * When the packages serving `dir` were last installed: the nearest `node_modules`
 * (its own, or a hoisted one up to the project root) or a Yarn Plug'n'Play map.
 * Null when nothing has been installed.
 */
function installedAt(root: string, dir: string): number | null {
  for (const d of upToRoot(root, dir)) {
    const pnp = mtime(join(d, '.pnp.cjs'));
    if (pnp !== null) return pnp;
    const modules = join(d, 'node_modules');
    if (!stat(modules)?.isDirectory()) continue;
    for (const record of INSTALL_RECORDS) {
      const t = mtime(join(modules, record));
      if (t !== null) return t;
    }
    return mtime(modules);
  }
  return null;
}

/**
 * Do the Node packages of `dir` need installing? True when nothing is installed
 * or `package.json` / a lockfile changed since the last install; null when `dir`
 * isn't a Node package.
 */
export function nodePackagesStale(root: string, dir: string): boolean | null {
  const manifest = mtime(join(dir, 'package.json'));
  if (manifest === null) return null;
  const installed = installedAt(root, dir);
  if (installed === null) return true;
  const lockfiles = [dir, root].flatMap((d) => LOCKFILES.map((f) => mtime(join(d, f)) ?? 0));
  return Math.max(manifest, ...lockfiles) > installed + SLACK_MS;
}

/**
 * Should the project's install command run before its servers start? Checks the
 * project root and every server folder. Ecosystems it can't judge count as up to
 * date, so Run never slows down on a guess.
 */
export function needsInstall(root: string, dirs: readonly string[]): boolean {
  return [...new Set([root, ...dirs])].some((d) => nodePackagesStale(root, d) === true);
}
