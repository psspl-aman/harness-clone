import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Keep `.agentforge/` out of git without touching tracked files (uses .git/info/exclude). */
export function excludeAgentforgeDir(root: string): void {
  const git = join(root, '.git');
  // Only the main checkout has a .git directory; worktrees have a .git file.
  if (!existsSync(git) || !statSync(git).isDirectory()) return;
  const exclude = join(git, 'info', 'exclude');
  mkdirSync(join(git, 'info'), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!current.split('\n').some((l) => l.trim() === '.agentforge/'))
    appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}.agentforge/\n`);
}
