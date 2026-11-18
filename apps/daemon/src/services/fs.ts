import type { FsBrowseResult, FsEntry, PathCheckMode, PathCheckResult } from '@agentforge/shared';
import { constants } from 'node:fs';
import { access, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
  agentforgeHome: string;
  workspaceRoot: () => string;
  /** Returns the id of the project already registered at `path`, if any. */
  projectAtPath: (path: string) => { id: string; localPath: string } | null;
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
      let isDir = d.isDirectory();
      if (d.isSymbolicLink())
        isDir = await stat(join(path, d.name)).then(
          (s) => s.isDirectory(),
          () => false,
        );
      if (!isDir) {
        fileCount++;
        continue;
      }
      const hidden = d.name.startsWith('.');
      if (hidden && !showHidden) continue;
      const full = join(path, d.name);
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
    if (path === '/' || path === home)
      return fail('Choose a dedicated folder, not the filesystem root or your home folder');
    if (FORBIDDEN_PREFIXES.some((p) => isWithin(p, path)))
      return fail('System folders cannot be used for projects');
    if (isWithin(this.deps.agentforgeHome, path) && !isWithin(this.deps.workspaceRoot(), path)) {
      return fail('This folder belongs to AgentForge’s own data directory');
    }
    const existing = this.deps.projectAtPath(path);
    if (existing) {
      result.existingProjectId = existing.id;
      return fail('This folder is already an AgentForge project');
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
      if (!result.writable) return fail('AgentForge cannot write to this folder');
    } else {
      if (mode === 'existing') return fail('Folder does not exist');
      const parent = dirname(path);
      const pst = await stat(parent).catch(() => null);
      if (!pst?.isDirectory()) return fail('Parent folder does not exist');
      result.writable = await canWrite(parent);
      if (!result.writable) return fail('AgentForge cannot write to the parent folder');
    }

    if (mode === 'scratch' && result.exists && !result.empty) {
      return fail('Folder is not empty — use “Attach existing project” for folders with code');
    }
    if (mode === 'existing') {
      if (result.empty) result.warnings.push('Folder is empty');
      if (!result.isGitRepo)
        result.warnings.push('Not a git repository — AgentForge will initialise one');
    }
    return { ...result, ok: true };
  }
}
