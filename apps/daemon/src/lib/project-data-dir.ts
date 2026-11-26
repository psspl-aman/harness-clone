import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The folder AI Harness keeps inside each project (memory mirror, handoff notes, attachments). */
export const PROJECT_DATA_DIR = '.ai-harness';
/** Its pre-rename (AgentForge) name: projects that already have it keep using it. */
export const LEGACY_PROJECT_DATA_DIR = '.agentforge';
/** Every name the folder can have — for filters that must skip it. */
export const PROJECT_DATA_DIR_NAMES = [PROJECT_DATA_DIR, LEGACY_PROJECT_DATA_DIR] as const;

/**
 * The data folder's name for this project. Nothing is moved on upgrade: a project that
 * already has the legacy folder keeps it, so stored attachment paths stay valid.
 */
export function projectDataDirName(root: string): string {
  return !existsSync(join(root, PROJECT_DATA_DIR)) && existsSync(join(root, LEGACY_PROJECT_DATA_DIR))
    ? LEGACY_PROJECT_DATA_DIR
    : PROJECT_DATA_DIR;
}

export function projectDataDir(root: string): string {
  return join(root, projectDataDirName(root));
}

/** True for a project-relative, `/`-separated path inside the data folder (either name). */
export function isProjectDataPath(relPath: string): boolean {
  return PROJECT_DATA_DIR_NAMES.some((d) => relPath === d || relPath.startsWith(`${d}/`));
}

/** Keep the data folder out of git without touching tracked files (uses .git/info/exclude). */
export function excludeProjectDataDir(root: string): void {
  const git = join(root, '.git');
  // Only the main checkout has a .git directory; worktrees have a .git file.
  if (!existsSync(git) || !statSync(git).isDirectory()) return;
  const entry = `${projectDataDirName(root)}/`;
  const exclude = join(git, 'info', 'exclude');
  mkdirSync(join(git, 'info'), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!current.split('\n').some((l) => l.trim() === entry))
    appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${entry}\n`);
}
