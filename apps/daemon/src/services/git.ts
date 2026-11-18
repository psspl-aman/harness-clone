import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';

/** Patterns AgentForge always keeps out of git. */
export const SECRET_IGNORE_PATTERNS = [
  '.env',
  '.env.*',
  '!.env.example',
  '*.pem',
  '*.key',
  '*.p12',
  '.npmrc',
];
const HEAVY_DIRS = [
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.next',
  'dist',
  'build',
];
const SECRET_FILE_RE = /(^|\/)(\.env(\..+)?|.+\.(pem|key|p12)|\.npmrc)$/;

const FALLBACK_IDENTITY = ['user.name=AgentForge', 'user.email=agentforge@localhost'];

export function git(dir: string, config: string[] = []): SimpleGit {
  return simpleGit({ baseDir: dir, config, timeout: { block: 120_000 } });
}

/** True when `dir` is the root of its own repository (not merely nested in one). */
export async function isRepoRoot(dir: string): Promise<boolean> {
  if (!existsSync(join(dir, '.git'))) return false;
  try {
    const top = (await git(dir).revparse(['--show-toplevel'])).trim();
    return top === dir;
  } catch {
    return false;
  }
}

/** Use the user's git identity when configured; otherwise a neutral fallback for AgentForge's own commits. */
async function identityConfig(dir: string): Promise<string[]> {
  try {
    const email = await git(dir).raw(['config', '--get', 'user.email']);
    if (email.trim()) return [];
  } catch {
    /* not configured */
  }
  return FALLBACK_IDENTITY;
}

/** Ensure .gitignore excludes secrets (and heavy dirs that exist); returns lines added. */
export async function ensureSafeGitignore(dir: string): Promise<string[]> {
  const path = join(dir, '.gitignore');
  const current = existsSync(path) ? await readFile(path, 'utf8') : '';
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const wanted = [
    ...SECRET_IGNORE_PATTERNS,
    ...HEAVY_DIRS.filter((d) => existsSync(join(dir, d))).map((d) => `${d}/`),
  ];
  const missing = wanted.filter((l) => !have.has(l) && !have.has(l.replace(/\/$/, '')));
  if (missing.length === 0) return [];
  const block = `${current && !current.endsWith('\n') ? '\n' : ''}\n# Added by AgentForge — keep secrets and build output out of git\n${missing.join('\n')}\n`;
  if (current) await appendFile(path, block);
  else await writeFile(path, block.trimStart());
  return missing;
}

/**
 * `git init` (branch main) plus an initial commit so worktrees can branch from it.
 * Secret-looking files are never committed, even if .gitignore would allow them.
 */
export async function initRepo(
  dir: string,
  opts: { commitExisting: boolean },
): Promise<{ branch: string; committedFiles: number }> {
  await git(dir).init(['--initial-branch=main']);
  await ensureSafeGitignore(dir);
  const g = git(dir, await identityConfig(dir));
  if (opts.commitExisting) {
    await g.add(['-A']);
    const staged = (await g.diff(['--cached', '--name-only'])).split('\n').filter(Boolean);
    const leaked = staged.filter((f) => SECRET_FILE_RE.test(f));
    if (leaked.length) await g.raw(['rm', '--cached', '--quiet', '--', ...leaked]);
  } else {
    await g.add(['.gitignore']);
  }
  const staged = (await g.diff(['--cached', '--name-only'])).split('\n').filter(Boolean);
  await g.commit(
    opts.commitExisting
      ? 'chore: initial commit (AgentForge)'
      : 'chore: initialize project (AgentForge)',
    undefined,
    {
      '--allow-empty': null,
    },
  );
  return { branch: 'main', committedFiles: staged.length };
}

export async function currentBranch(dir: string): Promise<string | null> {
  try {
    const b = (await git(dir).revparse(['--abbrev-ref', 'HEAD'])).trim();
    return b && b !== 'HEAD' ? b : null;
  } catch {
    return null;
  }
}
