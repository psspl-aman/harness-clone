import { homedir } from 'node:os';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

/** Expand `~` and normalise; returns null for non-absolute input. */
export function normalizePath(input: string): string | null {
  let p = input.trim();
  if (p === '~' || p.startsWith('~/')) p = homedir() + p.slice(1);
  if (!isAbsolute(p)) return null;
  const n = normalize(resolve(p));
  return n.length > 1 && n.endsWith(sep) ? n.slice(0, -1) : n;
}

/** True when `child` is `parent` or inside it. */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'project'
  );
}

/** Strip credentials from a git remote URL before showing or storing it. */
export function redactRemote(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/\/\/[^@/]+@/, '//');
}
