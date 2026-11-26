import type {
  FsBrowseResult,
  FsEntry,
  FsRoots,
  PathCheckMode,
  PathCheckResult,
} from '@ai-harness/shared';
import { constants } from 'node:fs';
import { access, mkdir, opendir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { AppError, badRequest } from '../http/errors';
import { isWithin, normalizePath } from '../lib/paths';

const MAX_ENTRIES = 1000;
/** Places a project may never live: system dirs and the user's home itself. */
const FORBIDDEN_PREFIXES = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib64',
  '/proc',
  '/sbin',
  '/sys',
  '/usr',
  '/var/lib',
  '/root',
];
/**
 * Windows legacy compatibility junctions (`Application Data`, `Cookies`, …). They are detected
 * as unreadable junctions; this list is a fallback for when detection doesn't catch one.
 */
const WIN_LEGACY_JUNCTIONS = new Set(
  [
    'Application Data',
    'Cookies',
    'Local Settings',
    'My Documents',
    'NetHood',
    'PrintHood',
    'Recent',
    'SendTo',
    'Start Menu',
    'Templates',
    'My Music',
    'My Pictures',
    'My Videos',
    'Default User',
    'All Users',
    'Documents and Settings',
    'History',
    'Temporary Internet Files',
  ].map((n) => n.toLowerCase()),
);
const isWin = process.platform === 'win32';

/** True when a symlink/junction can't be opened (e.g. Windows' deny-listed legacy junctions). */
const unreadable = (p: string) =>
  opendir(p).then(
    (d) => d.close().then(() => false),
    (err: NodeJS.ErrnoException) => err.code === 'EPERM' || err.code === 'EACCES',
  );

/** Files that don't make a folder "non-empty" for a scratch project. */
const IGNORABLE = new Set(['.DS_Store', 'Thumbs.db', '.git']);

const canWrite = (p: string) =>
  access(p, constants.W_OK).then(
    () => true,
    () => false,
  );

function fsError(err: unknown, path: string): AppError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return new AppError(404, 'NOT_FOUND', `Folder not found: ${path}`);
  if (code === 'EACCES' || code === 'EPERM')
    return new AppError(403, 'FS_PERMISSION', `Permission denied: ${path}`);
  if (code === 'ENOTDIR') return badRequest(`Not a folder: ${path}`);
  return new AppError(500, 'FS_ERROR', `Could not read ${path}`);
}

export interface FsServiceDeps {
  aiHarnessHome: string;
  workspaceRoot: () => string;
  /** Returns the id of the project already registered at `path`, if any. */
  projectAtPath: (
    path: string,
  ) => { id: string; localPath: string; archivedAt: number | null } | null;
  allProjectPaths: () => { id: string; localPath: string }[];
}

export class FsService {
  constructor(private readonly deps: FsServiceDeps) {}

  async browse(rawPath?: string, showHidden = false): Promise<FsBrowseResult> {
    const home = homedir();
    const path = rawPath ? normalizePath(rawPath) : home;
    if (!path) throw badRequest('Path must be absolute');
    let dirents;
    try {
      dirents = await readdir(path, { withFileTypes: true });
    } catch (err) {
      throw fsError(err, path);
    }
    const entries: FsEntry[] = [];
    let fileCount = 0;
    for (const d of dirents) {
      const full = join(path, d.name);
      let isDir = d.isDirectory();
      let hidden = d.name.startsWith('.');
      if (d.isSymbolicLink()) {
        isDir = await stat(full).then(
          (s) => s.isDirectory(),
          () => false,
        );
        // Unreadable links (Windows legacy junctions like `Cookies`) are system clutter.
        if (isDir && (await unreadable(full))) hidden = true;
      }
      if (!isDir) {
        fileCount++;
        continue;
      }
      if (isWin && WIN_LEGACY_JUNCTIONS.has(d.name.toLowerCase()) && d.isSymbolicLink())
        hidden = true;
      if (hidden && !showHidden) continue;
      entries.push({ name: d.name, path: full, hidden, isGitRepo: existsSync(join(full, '.git')) });
    }
    entries.sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name));
    const parent = dirname(path);
    return {
      path,
      parent: parent === path ? null : parent,
      home,
      writable: await canWrite(path),
      isGitRepo: existsSync(join(path, '.git')),
      entries: entries.slice(0, MAX_ENTRIES),
      fileCount,
      truncated: entries.length > MAX_ENTRIES,
    };
  }

  /** Platform info + drive roots for the folder picker's drive switcher. */
  roots(): FsRoots {
    const drives = isWin
      ? Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`).filter((d) =>
          existsSync(d),
        )
      : ['/'];
    return {
      platform: isWin ? 'win32' : 'posix',
      sep: isWin ? '\\' : '/',
      home: homedir(),
      drives,
    };
  }

  async mkdir(rawParent: string, name: string): Promise<FsBrowseResult> {
    const parent = normalizePath(rawParent);
    if (!parent) throw badRequest('Parent must be an absolute path');
    if (!/^[A-Za-z0-9._ -]+$/.test(name) || name === '.' || name === '..')
      throw badRequest('Invalid folder name');
    const target = join(parent, name);
    try {
      await mkdir(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST')
        throw new AppError(409, 'CONFLICT', `${name} already exists`);
      throw fsError(err, target);
    }
    return this.browse(target);
  }

  /** Validate a folder as a project root for a new (scratch) or existing project. */
  async check(rawPath: string, mode: PathCheckMode): Promise<PathCheckResult> {
    const path = normalizePath(rawPath);
    const result: PathCheckResult = {
      path: path ?? rawPath,
      ok: false,
      exists: false,
      isDirectory: false,
      empty: true,
      writable: false,
      isGitRepo: false,
      reason: null,
      warnings: [],
      existingProjectId: null,
    };
    const fail = (reason: string) => ({ ...result, ok: false, reason });
    if (!path) return fail('Path must be absolute');

    const home = homedir();
    if (parse(path).root === path || path === home)
      return fail('Choose a dedicated folder, not the filesystem root or your home folder');
    if (FORBIDDEN_PREFIXES.some((p) => isWithin(p, path)))
      return fail('System folders cannot be used for projects');
    if (isWithin(this.deps.aiHarnessHome, path) && !isWithin(this.deps.workspaceRoot(), path)) {
      return fail('This folder belongs to AI Harness’s own data directory');
    }
    const existing = this.deps.projectAtPath(path);
    if (existing) {
      result.existingProjectId = existing.id;
      return fail(
        existing.archivedAt
          ? 'This folder is an archived AI Harness project — restore it from Archived projects on the dashboard'
          : 'This folder is already an AI Harness project',
      );
    }
    for (const p of this.deps.allProjectPaths()) {
      if (isWithin(p.localPath, path))
        result.warnings.push(`Inside another project (${p.localPath})`);
      else if (isWithin(path, p.localPath))
        result.warnings.push(`Contains another project (${p.localPath})`);
    }

    const st = await stat(path).catch(() => null);
    result.exists = !!st;
    result.isDirectory = !!st?.isDirectory();
    if (st && !st.isDirectory()) return fail('A file with this name already exists');

    if (st) {
      let names: string[];
      try {
        names = await readdir(path);
      } catch (err) {
        return fail(fsError(err, path).message);
      }
      result.empty = names.every((n) => IGNORABLE.has(n));
      result.isGitRepo = names.includes('.git');
      result.writable = await canWrite(path);
      if (!result.writable) return fail('AI Harness cannot write to this folder');
    } else {
      if (mode === 'existing') return fail('Folder does not exist');
      const parent = dirname(path);
      const pst = await stat(parent).catch(() => null);
      if (!pst?.isDirectory()) return fail('Parent folder does not exist');
      result.writable = await canWrite(parent);
      if (!result.writable) return fail('AI Harness cannot write to the parent folder');
    }

    if (mode === 'scratch' && result.exists && !result.empty) {
      return fail('Folder is not empty — use “Attach existing project” for folders with code');
    }
    if (mode === 'existing') {
      if (result.empty) result.warnings.push('Folder is empty');
      if (!result.isGitRepo)
        result.warnings.push('Not a git repository — AI Harness will initialise one');
    }
    return { ...result, ok: true };
  }
}
