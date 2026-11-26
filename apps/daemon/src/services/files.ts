import type { FileContentDto } from '@ai-harness/shared';
import { eq } from 'drizzle-orm';
import { execa } from 'execa';
import { open, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { Db } from '../db/client';
import { projects } from '../db/schema';
import { AppError, badRequest, notFound } from '../http/errors';
import { isWithin } from '../lib/paths';
import { isProjectDataPath } from '../lib/project-data-dir';
import { isSecretFile } from './git';

const MAX_BYTES = 1024 * 1024;
const LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  rb: 'ruby',
  php: 'php',
  cs: 'csharp',
  css: 'css',
  scss: 'scss',
  html: 'html',
  vue: 'html',
  svelte: 'html',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  sh: 'shell',
  sql: 'sql',
  dockerfile: 'dockerfile',
  xml: 'xml',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  swift: 'swift',
  dart: 'dart',
};

/** Read-only access to the project's files for the Code tab. Secret files are never served. */
export class FileService {
  constructor(private readonly db: Db) {}

  async tree(projectId: string): Promise<{ files: string[]; truncated: boolean }> {
    const root = this.root(projectId);
    const r = await execa('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      reject: false,
      timeout: 20_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const files = String(r.stdout ?? '')
      .split('\n')
      .filter((f) => f && !isProjectDataPath(f))
      .sort();
    return { files: files.slice(0, 20_000), truncated: files.length > 20_000 };
  }

  async read(projectId: string, rel: string): Promise<FileContentDto> {
    const root = this.root(projectId);
    const clean = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
    const path = join(root, clean);
    if (
      !rel ||
      rel.includes('\0') ||
      !isWithin(root, path) ||
      clean.startsWith('.git/') ||
      clean === '.git'
    )
      throw badRequest('Invalid path');
    if (isSecretFile(clean))
      throw new AppError(
        403,
        'SECRET_FILE',
        'This file may contain secrets, so AI Harness does not display it',
      );
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) throw notFound('File');
    const fh = await open(path, 'r');
    try {
      const len = Math.min(st.size, MAX_BYTES);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
      const binary = buf.subarray(0, 8000).includes(0);
      const ext = extname(clean).slice(1).toLowerCase() || clean.split('/').pop()!.toLowerCase();
      return {
        path: clean,
        size: st.size,
        binary,
        truncated: st.size > MAX_BYTES,
        content: binary ? '' : buf.toString('utf8'),
        language: LANG[ext] ?? 'plaintext',
      };
    } finally {
      await fh.close();
    }
  }

  private root(projectId: string): string {
    const p = this.db
      .select({ path: projects.localPath })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    if (!p) throw notFound('Project');
    return p.path;
  }
}
