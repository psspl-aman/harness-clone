import {
  EnvKeyRequestInputSchema,
  EnvKeyValueSchema,
  PUBLIC_ENV_PREFIX,
  Topics,
  isReservedEnvKey,
  looksSecretEnvKey,
  type EnvKeyRequestDto,
  type EnvKeySetResultDto,
} from '@agentforge/shared';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { kvDelete, kvGet, kvSet } from '../db/kv';
import { projects } from '../db/schema';
import type { EventBus } from '../events/bus';
import { badRequest, notFound } from '../http/errors';
import { newId } from '../lib/id';
import { ensureSafeGitignore, git, isRepoRoot } from './git';

/** What AgentForge keeps about a request. There is deliberately no value here. */
interface Req {
  id: string;
  name: string;
  /** Folder relative to the project ("" = root); the value goes into `<folder>/.env`. */
  folder: string;
  why: string | null;
  secret: boolean;
  skipped: boolean;
  source: 'agent' | 'example';
  taskKey: string | null;
  createdAt: number;
  updatedAt: number;
}

const kvKey = (projectId: string) => `project.${projectId}.envKeys`;
const EXAMPLE_RE = /^\.env\.(example|sample|template)$/i;
const SCAN_SKIP = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.venv',
  'venv',
  'target',
]);
const MAX_ENV_FILE = 256 * 1024;
const KNOWN_TTL_MS = 5_000;

/**
 * Minimal dotenv parser: `KEY=value`, `export KEY=value`, single/double/backtick quotes
 * (double quotes understand \n \r \t \" \\ and may span lines), `# comments` after
 * unquoted values. Returns key → value; later keys win, like dotenv.
 */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const line = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/gm;
  let m: RegExpExecArray | null;
  while ((m = line.exec(src))) {
    const key = m[1]!;
    let i = line.lastIndex;
    let value = '';
    const q = src[i];
    if (q === '"' || q === "'" || q === '`') {
      let j = i + 1;
      let closed = false;
      for (; j < src.length; j++) {
        const c = src[j]!;
        if (c === q) {
          closed = true;
          break;
        }
        if (q === '"' && c === '\\' && j + 1 < src.length) {
          const n = src[++j]!;
          value += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n;
        } else value += c;
      }
      if (closed) i = j + 1;
      else {
        // Unterminated quote: take the rest of the line only.
        const end = src.indexOf('\n', i);
        value = src.slice(i + 1, end === -1 ? undefined : end);
        i = end === -1 ? src.length : end;
      }
    } else {
      const end = src.indexOf('\n', i);
      value = src
        .slice(i, end === -1 ? undefined : end)
        .replace(/[ \t]+#.*$/, '')
        .trim();
      i = end === -1 ? src.length : end;
    }
    line.lastIndex = i;
    out.set(key, value);
  }
  return out;
}

/**
 * Serialise a value for a .env line so dotenv, dotenv-expand (Next.js, Vite) and
 * python-dotenv all read it back unchanged: plain when safe, single quotes (literal,
 * no `$` expansion) when possible, double quotes with escapes otherwise.
 */
export function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9_\-.:/@+=,~%]*$/.test(value)) return value;
  if (!value.includes("'") && !value.includes('\n')) return `'${value}'`;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** Replace `name`'s line (keeping its position) or append it; other lines are untouched. */
export function upsertEnvLine(text: string, name: string, value: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const head = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=`);
  const entry = `${name}=${formatEnvValue(value)}`;
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!head.test(lines[i]!)) continue;
    // Drop the old entry, including a quoted value that spans several lines.
    let end = i;
    const rest = lines[i]!.replace(head, '').trimStart();
    const q = rest[0];
    if ((q === '"' || q === "'" || q === '`') && rest.indexOf(q, 1) === -1) {
      while (end + 1 < lines.length && !lines[end + 1]!.includes(q)) end++;
      if (end + 1 < lines.length) end++;
    }
    if (at === -1) {
      lines.splice(i, end - i + 1, entry);
      at = i;
    } else {
      lines.splice(i, end - i + 1);
      i--;
    }
  }
  if (at === -1) {
    while (lines.length && lines.at(-1) === '') lines.pop();
    lines.push(entry);
  }
  return `${lines.join('\n').replace(/\n*$/, '')}\n`;
}

export interface EnvKeyDeps {
  db: Db;
  bus: EventBus;
}

/**
 * Env keys a project needs from the user. Agents declare names (tool call, or a name
 * added to a `.env.example`); the user types the value in the Requirements chat and
 * the daemon writes it into the project's gitignored `.env` — the only place it lives.
 * Written values are remembered in memory only, to mask them in logs and keep them
 * out of commits.
 */
export class EnvKeyService {
  private known: { at: number; values: string[] } | null = null;

  constructor(private readonly d: EnvKeyDeps) {}

  /** Requests for a project, after picking up names newly added to `.env.example` files. */
  list(projectId: string): EnvKeyRequestDto[] {
    const root = this.root(projectId);
    const reqs = this.load(projectId);
    let added = false;
    for (const ex of this.examples(root)) {
      for (const name of ex.names) {
        if (isReservedEnvKey(name) || reqs.some((r) => r.name === name && r.folder === ex.folder))
          continue;
        const now = Date.now();
        reqs.push({
          id: newId('envk'),
          name,
          folder: ex.folder,
          why: `Listed in ${ex.file}`,
          secret: looksSecretEnvKey(name),
          skipped: false,
          source: 'example',
          taskKey: null,
          createdAt: now,
          updatedAt: now,
        });
        added = true;
      }
    }
    if (added) this.save(projectId, reqs);
    return reqs
      .map((r) => this.dto(projectId, root, r))
      .sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
  }

  /** An agent (or the UI) declares that the project needs `name`. Never takes a value. */
  request(projectId: string, raw: unknown, taskKey: string | null = null): EnvKeyRequestDto {
    const root = this.root(projectId);
    const v = EnvKeyRequestInputSchema.parse(raw);
    this.folderPath(root, v.folder, false);
    const reqs = this.load(projectId);
    const now = Date.now();
    let r = reqs.find((x) => x.name === v.name && x.folder === v.folder);
    if (r) {
      r.why = v.why ?? r.why;
      r.secret = v.secret ?? r.secret;
      r.skipped = false;
      r.source = 'agent';
      r.taskKey = taskKey ?? r.taskKey;
      r.updatedAt = now;
    } else {
      r = {
        id: newId('envk'),
        name: v.name,
        folder: v.folder,
        why: v.why ?? null,
        secret: v.secret ?? looksSecretEnvKey(v.name),
        skipped: false,
        source: 'agent',
        taskKey,
        createdAt: now,
        updatedAt: now,
      };
      reqs.push(r);
    }
    this.save(projectId, reqs);
    const dto = this.dto(projectId, root, r);
    if (dto.status === 'pending')
      this.d.bus.emit(
        'notification',
        {
          level: 'info',
          title: `${v.name} is needed`,
          message: `${taskKey ? `${taskKey}: ` : ''}add its value in the Requirements chat — it goes into ${dto.file} only.`,
          projectId,
        },
        [Topics.global, Topics.project(projectId)],
      );
    return dto;
  }

  /** Write the user's value into `<folder>/.env`. The value is not stored anywhere else. */
  async setValue(projectId: string, id: string, raw: unknown): Promise<EnvKeySetResultDto> {
    const root = this.root(projectId);
    const { value } = EnvKeyValueSchema.parse(raw);
    const reqs = this.load(projectId);
    const r = reqs.find((x) => x.id === id);
    if (!r) throw notFound('Key request');
    const dir = this.folderPath(root, r.folder, true);
    const target = join(dir, '.env');
    if (existsSync(target) && lstatSync(target).isSymbolicLink())
      throw badRequest(
        `${this.rel(root, target)} is a symlink — AgentForge won’t write through it`,
      );
    const warnings: string[] = [];
    const relFile = this.rel(root, target);
    if (await isRepoRoot(root)) {
      await ensureSafeGitignore(root);
      const g = git(root);
      const ignored = await g.raw(['check-ignore', '-q', '--', relFile]).then(
        () => true,
        () => false,
      );
      if (!ignored)
        warnings.push(`${relFile} isn’t ignored by git — check .gitignore before committing.`);
      const tracked = await g.raw(['ls-files', '--error-unmatch', '--', relFile]).then(
        () => true,
        () => false,
      );
      if (tracked)
        warnings.push(
          `${relFile} is already tracked by git, so the value could be committed. Untrack it: git rm --cached ${relFile}`,
        );
    }
    const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
    if (current.length > MAX_ENV_FILE) throw badRequest(`${relFile} is unexpectedly large`);
    // Atomic replace, readable by the owner only (chmod is a no-op on Windows).
    const tmp = join(dir, `.env.agentforge-${randomBytes(6).toString('hex')}.tmp`);
    try {
      writeFileSync(tmp, upsertEnvLine(current, r.name, value), { mode: 0o600, flag: 'wx' });
      renameSync(tmp, target);
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp);
    }
    try {
      chmodSync(target, 0o600);
    } catch {
      // Not supported on this file system; the file still works.
    }
    r.skipped = false;
    r.updatedAt = Date.now();
    this.save(projectId, reqs);
    this.known = null;
    if (r.secret && PUBLIC_ENV_PREFIX.test(r.name))
      warnings.push(
        `${r.name} starts with ${r.name.match(PUBLIC_ENV_PREFIX)![1]}, so frameworks ship it to the browser. Keep secret keys in a server-only variable.`,
      );
    return { request: this.dto(projectId, root, r), warnings };
  }

  skip(projectId: string, id: string): EnvKeyRequestDto {
    const root = this.root(projectId);
    const reqs = this.load(projectId);
    const r = reqs.find((x) => x.id === id);
    if (!r) throw notFound('Key request');
    r.skipped = true;
    r.updatedAt = Date.now();
    this.save(projectId, reqs);
    return this.dto(projectId, root, r);
  }

  removeAll(projectId: string): void {
    kvDelete(this.d.db, kvKey(projectId));
    this.known = null;
  }

  /**
   * Secret values AgentForge wrote (read back from the .env files they live in), for
   * masking logs and refusing commits. Cached briefly: the redactor calls this a lot.
   */
  knownValues(): string[] {
    if (this.known && Date.now() - this.known.at < KNOWN_TTL_MS) return this.known.values;
    const out = new Set<string>();
    for (const p of this.d.db
      .select({ id: projects.id, localPath: projects.localPath })
      .from(projects)
      .all()) {
      const reqs = this.load(p.id).filter((r) => r.secret);
      if (!reqs.length) continue;
      const byFile = new Map<string, Map<string, string>>();
      for (const r of reqs) {
        const file = join(resolve(p.localPath, r.folder), '.env');
        let parsed = byFile.get(file);
        if (!parsed) {
          parsed = this.readEnv(file);
          byFile.set(file, parsed);
        }
        const v = parsed.get(r.name);
        if (v && v.length >= 8) out.add(v);
      }
    }
    const values = [...out].sort((a, b) => b.length - a.length);
    this.known = { at: Date.now(), values };
    return values;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private dto(projectId: string, root: string, r: Req): EnvKeyRequestDto {
    const file = join(resolve(root, r.folder), '.env');
    const value = this.readEnv(file).get(r.name);
    const set = !!value;
    return {
      id: r.id,
      projectId,
      name: r.name,
      file: this.rel(root, file),
      why: r.why,
      secret: r.secret,
      publicPrefixWarning: r.secret && PUBLIC_ENV_PREFIX.test(r.name),
      status: set ? 'set' : r.skipped ? 'skipped' : 'pending',
      length: set ? value.length : null,
      source: r.source,
      taskKey: r.taskKey,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private readEnv(file: string): Map<string, string> {
    try {
      if (!existsSync(file) || statSync(file).size > MAX_ENV_FILE) return new Map();
      return parseDotenv(readFileSync(file, 'utf8'));
    } catch {
      return new Map();
    }
  }

  /** `.env.example`-style files (root and two levels down) with their variable names. */
  private examples(root: string): { folder: string; file: string; names: string[] }[] {
    const out: { folder: string; file: string; names: string[] }[] = [];
    const walk = (dir: string, depth: number) => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (depth < 2 && !SCAN_SKIP.has(e.name) && !e.name.startsWith('.'))
            walk(join(dir, e.name), depth + 1);
        } else if (e.isFile() && EXAMPLE_RE.test(e.name)) {
          const abs = join(dir, e.name);
          const names = [...this.readEnv(abs).keys()];
          const folder = this.rel(root, dir);
          out.push({ folder: folder === '.' ? '' : folder, file: this.rel(root, abs), names });
        }
      }
    };
    walk(root, 0);
    return out;
  }

  /** Absolute folder inside the project; refuses anything that escapes it (incl. symlinks). */
  private folderPath(root: string, folder: string, mustExist: boolean): string {
    if (isAbsolute(folder) || folder.split('/').includes('..'))
      throw badRequest('Use a folder inside the project');
    const abs = resolve(root, folder);
    if (!existsSync(abs)) {
      if (mustExist)
        throw badRequest(
          `${folder || 'The project folder'} doesn’t exist yet — set the value once the task’s changes are merged`,
        );
      return abs;
    }
    const rel = relative(realpathSync(root), realpathSync(abs));
    if (rel.startsWith('..') || isAbsolute(rel))
      throw badRequest('Use a folder inside the project');
    return abs;
  }

  private rel(root: string, abs: string): string {
    return relative(root, abs).split(sep).join('/') || '.';
  }

  private root(projectId: string): string {
    const p = this.d.db
      .select({ localPath: projects.localPath })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    if (!p) throw notFound('Project');
    return p.localPath;
  }

  private load(projectId: string): Req[] {
    return [...(kvGet<Req[]>(this.d.db, kvKey(projectId)) ?? [])];
  }

  private save(projectId: string, reqs: Req[]): void {
    kvSet(this.d.db, kvKey(projectId), reqs);
    this.d.bus.emit('project.env_keys', { projectId }, [Topics.project(projectId)]);
  }
}
