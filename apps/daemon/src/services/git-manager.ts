import {
  GitCheckoutInputSchema,
  GitCommitInputSchema,
  GitCreateBranchInputSchema,
  GitDeleteBranchInputSchema,
  GitMergeInputSchema,
  GitPullRequestInputSchema,
  GitPushInputSchema,
  GitWorkingBranchInputSchema,
  isTerminal,
  Topics,
  type GitActionResultDto,
  type GitBranchDetailDto,
  type GitBranchDto,
  type GitChangeDto,
  type GitCommitDto,
  type GitOverviewDto,
  type GitTaskRefDto,
  type GitWorkGroupDto,
  type TaskStatus,
} from '@agentforge/shared';
import { eq } from 'drizzle-orm';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Db } from '../db/client';
import { tasks } from '../db/schema';
import type { EventBus } from '../events/bus';
import { AppError, badRequest, conflict, notFound } from '../http/errors';
import { ensureSafeGitignore, identityConfig, initRepo, isSecretFile } from './git';
import type { GithubService } from './github';
import * as gitops from './orchestrator/git-ops';
import type { ProjectService } from './projects';

export interface GitManagerDeps {
  db: Db;
  bus: EventBus;
  projects: ProjectService;
  github: GithubService;
  /** Serialises with the orchestrator's merges for the same project. */
  lock: <T>(projectId: string, fn: () => Promise<T>) => Promise<T>;
}

const SEP = '\x1f';
const MAX_CHANGES = 500;
const MAX_COMPARED = 60;
const MAX_REMOTE = 300;
const MAX_COMMITS = 100;
const TASK_KEY_RE = /\b[A-Z][A-Z0-9]*-\d+\b/g;

type Git = { code: number; out: string; err: string };

const samePath = (a: string, b: string) => {
  const n = (p: string) => resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/** Strip credentials from a remote URL (user:token@host → host). */
export const redactUrl = (url: string) => url.replace(/^(\w+:\/\/)[^@/]+@/, '$1');

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatus(raw: string): {
  head: string | null;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitChangeDto[];
} {
  const parts = raw.split('\0');
  let head: string | null = null;
  let oid: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const changes: GitChangeDto[] = [];
  const kindOf = (xy: string): GitChangeDto['kind'] => {
    if (xy.includes('A')) return 'added';
    if (xy.includes('D')) return 'deleted';
    if (xy.includes('R') || xy.includes('C')) return 'renamed';
    return 'modified';
  };
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!;
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const h = line.slice(14);
      head = h === '(detached)' ? null : h;
    } else if (line.startsWith('# branch.oid ')) {
      const o = line.slice(13);
      oid = o === '(initial)' ? null : o;
    } else if (line.startsWith('# branch.upstream ')) upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) [ahead, behind] = [Number(m[1]), Number(m[2])];
    } else if (line.startsWith('1 ')) {
      const f = line.split(' ');
      const xy = f[1]!;
      changes.push({
        path: f.slice(8).join(' '),
        from: null,
        kind: kindOf(xy),
        staged: xy[0] !== '.',
      });
    } else if (line.startsWith('2 ')) {
      const f = line.split(' ');
      const xy = f[1]!;
      changes.push({
        path: f.slice(9).join(' '),
        from: parts[++i] ?? null,
        kind: 'renamed',
        staged: xy[0] !== '.',
      });
    } else if (line.startsWith('u ')) {
      changes.push({
        path: line.split(' ').slice(10).join(' '),
        from: null,
        kind: 'conflicted',
        staged: false,
      });
    } else if (line.startsWith('? ')) {
      changes.push({ path: line.slice(2), from: null, kind: 'untracked', staged: false });
    }
  }
  return { head, oid, upstream, ahead, behind, changes };
}

interface RefRow {
  ref: string;
  head: string;
  upstream: string;
  track: string;
  date: number;
  author: string;
  subject: string;
}

/**
 * Branch management for a project's repository: what's on each branch, which
 * task's work went where, and the everyday actions (switch, create, merge,
 * delete, commit, fetch/pull/push, pull requests). Agents keep working in their
 * own worktrees; these actions only touch the project folder and branch refs.
 */
export class GitManager {
  constructor(private readonly d: GitManagerDeps) {}

  // ─── Reads ─────────────────────────────────────────────────────────────────

  async overview(projectId: string): Promise<GitOverviewDto> {
    const p = this.d.projects.get(projectId);
    const dir = p.localPath;
    const base: GitOverviewDto = {
      projectId,
      isRepo: false,
      localPath: dir,
      current: null,
      detachedAt: null,
      workingBranch: p.workingBranch,
      defaultBranch: p.defaultBranch,
      remotes: [],
      upstream: null,
      operation: null,
      changes: [],
      changesTruncated: false,
      branches: [],
      hiddenRemoteBranches: 0,
      work: [],
      githubRepo: p.githubRepo,
    };
    if (!this.isRepo(dir)) return base;

    const [status, refs, worktrees, remotes, operation] = await Promise.all([
      this.git(dir, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']),
      this.refs(dir),
      this.worktrees(dir),
      this.remotes(dir),
      this.operation(dir),
    ]);
    const st = parseStatus(status.out);
    const working = this.workingOf(p, st.head);
    const locals = new Set(
      refs.filter((r) => r.ref.startsWith('refs/heads/')).map((r) => short(r.ref)),
    );
    const workingExists = !!working && locals.has(working);
    const merged = workingExists ? await this.mergedInto(dir, working) : new Set<string>();
    const taskRefs = this.taskRefs(projectId, working);
    const activeTaskWorktrees = new Map(
      this.taskRows(projectId)
        .filter((t) => t.worktreePath)
        .map((t) => [t.worktreePath!, t.key]),
    );

    const all: GitBranchDto[] = refs.map((r) => {
      const kind = r.ref.startsWith('refs/heads/') ? 'local' : 'remote';
      const name = short(r.ref);
      const plain = kind === 'remote' ? name.replace(/^[^/]+\//, '') : name;
      const wt = kind === 'local' ? worktrees.get(name) : undefined;
      const tr = parseTrack(r.track);
      return {
        name,
        kind,
        head: r.head,
        subject: r.subject,
        author: r.author,
        date: r.date * 1000,
        upstream: r.upstream || null,
        upstreamAhead: r.upstream && !tr.gone ? tr.ahead : null,
        upstreamBehind: r.upstream && !tr.gone ? tr.behind : null,
        upstreamGone: tr.gone,
        ahead: null,
        behind: null,
        merged: merged.has(r.ref),
        current: kind === 'local' && name === st.head,
        working: kind === 'local' && name === working,
        default: kind === 'local' && name === p.defaultBranch,
        worktree: wt && !samePath(wt, dir) ? wt : null,
        hasLocal: kind === 'remote' && locals.has(plain),
        tasks: taskRefs.filter(
          (t) => t.branchName === plain && (kind === 'local' || !locals.has(plain)),
        ),
      };
    });

    // Big repos can have thousands of remote branches: keep the most recent ones.
    const sorted = sortBranches(all);
    const remoteKept = new Set(
      sorted
        .filter((b) => b.kind === 'remote')
        .slice(0, MAX_REMOTE)
        .map((b) => b.name),
    );
    const branches = sorted.filter((b) => b.kind === 'local' || remoteKept.has(b.name));
    const hiddenRemoteBranches = all.length - branches.length;

    // Ahead/behind the working branch for the most recently active branches (locals first).
    if (workingExists) {
      const compared = branches.filter((b) => !b.working).slice(0, MAX_COMPARED);
      await pool(compared, 8, async (b) => {
        const r = await this.git(
          dir,
          ['rev-list', '--left-right', '--count', `${working}...${b.name}`],
          {
            allowFail: true,
          },
        );
        const [behind, ahead] = r.out.trim().split(/\s+/).map(Number);
        if (r.code === 0) Object.assign(b, { ahead: ahead ?? 0, behind: behind ?? 0 });
      });
      const w = branches.find((b) => b.working);
      if (w) Object.assign(w, { ahead: 0, behind: 0 });
    }
    // Branches checked out by agents show which task holds them.
    for (const b of branches)
      if (b.worktree && !b.tasks.length) {
        const key = [...activeTaskWorktrees].find(([path]) => samePath(path, b.worktree!))?.[1];
        if (key) b.tasks = taskRefs.filter((t) => t.key === key);
      }

    return {
      ...base,
      isRepo: true,
      current: st.head,
      detachedAt: st.head ? null : (st.oid?.slice(0, 7) ?? null),
      workingBranch: working,
      remotes,
      upstream: st.upstream ? { name: st.upstream, ahead: st.ahead, behind: st.behind } : null,
      operation,
      changes: st.changes.slice(0, MAX_CHANGES),
      changesTruncated: st.changes.length > MAX_CHANGES,
      branches,
      hiddenRemoteBranches,
      work: this.workGroups(taskRefs, working, locals),
    };
  }

  async branch(projectId: string, name: string, base?: string | null): Promise<GitBranchDetailDto> {
    const p = this.d.projects.get(projectId);
    const dir = this.repoDir(p.localPath);
    if (!(await gitops.revParse(dir, name))) throw notFound(`Branch ${name}`);
    const current = (
      await this.git(dir, ['branch', '--show-current'], { allowFail: true })
    ).out.trim();
    const working = this.workingOf(p, current || null);
    let compare: string | null =
      base === undefined ? (working && working !== name ? working : null) : base;
    if (compare && (compare === name || !(await gitops.revParse(dir, compare)))) compare = null;

    const range = compare ? `${compare}..${name}` : name;
    const log = await this.git(dir, [
      'log',
      `--format=%H${SEP}%h${SEP}%an${SEP}%ct${SEP}%P${SEP}%s`,
      '-n',
      String(MAX_COMMITS + 1),
      range,
      '--',
    ]);
    const rows = this.taskRows(projectId);
    const byKey = new Map(rows.map((t) => [t.key, t]));
    const byMerge = new Map(
      rows.filter((t) => t.pipelineState.mergeCommit).map((t) => [t.pipelineState.mergeCommit!, t]),
    );
    const commits: GitCommitDto[] = log.out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, shortHash, author, ct, parents, ...subject] = line.split(SEP);
        const text = subject.join(SEP);
        const t =
          byMerge.get(hash!) ??
          [...text.matchAll(TASK_KEY_RE)].map((m) => byKey.get(m[0])).find(Boolean) ??
          null;
        return {
          hash: hash!,
          shortHash: shortHash!,
          subject: text,
          author: author!,
          date: Number(ct) * 1000,
          isMerge: (parents ?? '').trim().split(' ').length > 1,
          task: t ? { id: t.id, key: t.key, title: t.title } : null,
        };
      });

    let diff: GitBranchDetailDto['diff'] = null;
    if (compare) {
      const mb = await gitops.mergeBase(dir, compare, name);
      if (mb) diff = await gitops.diff(dir, mb, name);
    }
    const remote = (await this.remoteNames(dir)).find((r) => name.startsWith(`${r}/`));
    const plain = remote ? name.slice(remote.length + 1) : name;
    const refs = this.taskRefs(projectId, working).filter(
      (t) =>
        t.branchName === name ||
        t.branchName === plain ||
        t.mergedInto === name ||
        (t.state === 'in_progress' && (t.baseBranch ?? working) === name),
    );
    return {
      branch: name,
      base: compare,
      commits: commits.slice(0, MAX_COMMITS),
      commitsTruncated: commits.length > MAX_COMMITS,
      diff,
      tasks: refs,
    };
  }

  // ─── Actions ───────────────────────────────────────────────────────────────

  async init(projectId: string): Promise<GitActionResultDto> {
    const p = this.d.projects.get(projectId);
    if (this.isRepo(p.localPath)) throw conflict('This project is already a git repository');
    const { branch, committedFiles } = await initRepo(p.localPath, { commitExisting: true });
    this.d.projects.setBranches(projectId, {
      defaultBranch: p.defaultBranch ?? branch,
      workingBranch: p.workingBranch ?? branch,
    });
    return this.done(
      projectId,
      'init',
      `Initialised git on ${branch} (${committedFiles} file${committedFiles === 1 ? '' : 's'} committed)`,
    );
  }

  async createBranch(projectId: string, raw: unknown): Promise<GitActionResultDto> {
    const input = GitCreateBranchInputSchema.parse(raw);
    const p = this.d.projects.get(projectId);
    const dir = this.repoDir(p.localPath);
    const valid = await this.git(dir, ['check-ref-format', '--branch', input.name], {
      allowFail: true,
    });
    if (valid.code !== 0) throw badRequest(`“${input.name}” isn’t a valid branch name`);
    if (await gitops.branchExists(dir, input.name))
      throw conflict(`Branch ${input.name} already exists`);
    const from = input.from ?? this.workingOf(p, await this.currentOf(dir)) ?? 'HEAD';
    if (!(await gitops.revParse(dir, from)))
      throw badRequest(`Can’t branch from ${from}: not found`);
    await this.git(dir, ['branch', '--no-track', input.name, from]);
    if (input.checkout) await this.switchTo(projectId, dir, input.name);
    return this.done(
      projectId,
      'branch',
      `Created ${input.name} from ${from}${input.checkout ? ' and switched to it' : ''}`,
    );
  }

  async checkout(projectId: string, raw: unknown): Promise<GitActionResultDto> {
    const { branch } = GitCheckoutInputSchema.parse(raw);
    const p = this.d.projects.get(projectId);
    const dir = this.repoDir(p.localPath);
    if (await this.operation(dir)) throw conflict('Finish or abort the merge in progress first');
    const remote = await this.remoteBranch(dir, branch);
    if (remote) {
      if (await gitops.branchExists(dir, remote.plain))
        await this.switchTo(projectId, dir, remote.plain);
      else await this.git(dir, ['switch', '-c', remote.plain, '--track', branch]);
      return this.done(projectId, 'checkout', `Switched to ${remote.plain} (tracking ${branch})`);
    }
    if (!(await gitops.branchExists(dir, branch))) throw notFound(`Branch ${branch}`);
    await this.switchTo(projectId, dir, branch);
    return this.done(projectId, 'checkout', `Switched to ${branch}`);
  }

  async merge(projectId: string, raw: unknown): Promise<GitActionResultDto> {
    const input = GitMergeInputSchema.parse(raw);
    const p = this.d.projects.get(projectId);
    const dir = this.repoDir(p.localPath);
    const target = input.target ?? this.workingOf(p, await this.currentOf(dir));
    if (!target) throw badRequest('Pick a branch to merge into');
    if (target === input.source) throw badRequest('A branch can’t be merged into itself');
    if (!(await gitops.branchExists(dir, target))) throw notFound(`Branch ${target}`);
    if (!(await gitops.branchExists(dir, input.source)))
      throw badRequest(
        (await this.remoteBranch(dir, input.source))
          ? `Check out ${input.source} locally first, then merge it`
          : `Branch ${input.source} not found`,
      );
    if (await gitops.isAncestor(dir, input.source, target))
      return this.done(projectId, 'merge', `${target} already has everything from ${input.source}`);
    const outcome = await this.d.lock(projectId, () =>
      gitops.mergeIntoWorking(dir, input.source, target, `Merge ${input.source} into ${target}`),
    );
    if (outcome.status === 'conflict')
      throw new AppError(
        409,
        'MERGE_CONFLICT',
        `${input.source} and ${target} conflict${outcome.files.length ? ` in ${outcome.files.slice(0, 5).join(', ')}${outcome.files.length > 5 ? '…' : ''}` : ''}. Nothing was changed — resolve it in your editor (git merge ${input.source}) or ask an agent.`,
        { files: outcome.files },
      );
    if (outcome.status === 'dirty')
      throw conflict(
        `${target} is checked out in ${outcome.path} with uncommitted changes — commit them first.`,
      );
    return this.done(projectId, 'merge', `Merged ${input.source} into ${target}`);
  }

  async deleteBranch(projectId: string, raw: unknown): Promise<GitActionResultDto> {
    const input = GitDeleteBranchInputSchema.parse(raw);
    const p = this.d.projects.get(projectId);
    const dir = this.repoDir(p.localPath);
    if (!(await gitops.branchExists(dir, input.name))) throw notFound(`Branch ${input.name}`);
    const current = await this.currentOf(dir);
    if (input.name === current) throw conflict('Switch to another branch before deleting this one');
    if (input.name === this.workingOf(p, current))
      throw conflict('Agents merge into this branch — pick another working branch first');
    if (input.name === p.defaultBranch) throw conflict('The default branch can’t be deleted here');
    const busy = this.taskRows(projectId).find(
      (t) =>
        t.branchName === input.name && !isTerminal(t.status as TaskStatus) && t.status !== 'FAILED',
    );
    if (busy) throw conflict(`${busy.key} is working on this branch — cancel the task first`);
    const wt = (await this.worktrees(dir)).get(input.name);
    if (wt && !samePath(wt, dir)) throw conflict(`It’s checked out in ${wt}`);
    const r = await this.git(dir, ['branch', input.force ? '-D' : '-d', input.name], {
      allowFail: true,
    });
    if (r.code !== 0) {
      if (/not fully merged/i.test(r.err))
        throw new AppError(
          409,
          'BRANCH_UNMERGED',
          `${input.name} has commits that aren’t merged anywhere. Delete it anyway?`,
        );
      throw this.gitError('branch', r);
    }
    return this.done(projectId, 'delete', `Deleted ${input.name}`);
  }

  async setWorkingBranch(projectId: string, raw: unknown): Promise<GitActionResultDto> {
    const { branch } = GitWorkingBranchInputSchema.parse(raw);
    const p = this.d.projects.get(projectId);
    const dir = this.repoDir(p.localPath);
    if (!(await gitops.branchExists(dir, branch)))
      throw badRequest(`Only a local branch can be the working branch (${branch} isn’t one)`);
    this.d.projects.setBranches(projectId, { workingBranch: branch });
    return this.done(projectId, 'working', `Agents now branch from and merge into ${branch}`);
  }

  async commit(projectId: string, raw: unknown): Promise<GitActionResultDto> {
    const { message } = GitCommitInputSchema.parse(raw);
    const p = this.d.projects.get(projectId);
    const dir = this.repoDir(p.localPath);
    // First commit of an empty repo: keep secrets and dependency folders out from the start.
    if (!(await gitops.revParse(dir, 'HEAD'))) await ensureSafeGitignore(dir);
    await this.git(dir, ['add', '-A']);
    const staged = (await this.git(dir, ['diff', '--cached', '--name-only'])).out
      .split('\n')
      .filter(Boolean);
    const secrets = staged.filter((f) => isSecretFile(f));
    if (secrets.length) await this.git(dir, ['rm', '--cached', '--quiet', '--', ...secrets]);
    const files = staged.length - secrets.length;
    if (!files && !(await this.operation(dir)))
      throw badRequest(
        secrets.length
          ? 'Only secret files changed — they are never committed'
          : 'Nothing to commit',
      );
    const id = (await identityConfig(dir)).flatMap((c) => ['-c', c]);
    await this.git(dir, [...id, 'commit', '-m', message]);
    const branch = (await this.currentOf(dir)) ?? 'HEAD';
    return this.done(
      projectId,
      'commit',
      `Committed ${files} file${files === 1 ? '' : 's'} to ${branch}${secrets.length ? ` (left out ${secrets.length} secret file${secrets.length === 1 ? '' : 's'})` : ''}`,
    );
  }

  async abort(projectId: string): Promise<GitActionResultDto> {
    const p = this.d.projects.get(projectId);
    const dir = this.repoDir(p.localPath);
    const op = await this.operation(dir);
    if (!op) throw badRequest('Nothing to abort');
    await this.git(dir, [op, '--abort']);
    return this.done(projectId, 'abort', `Aborted the ${op}`);
  }

  async fetch(projectId: string): Promise<GitActionResultDto> {
    const p = this.d.projects.get(projectId);
    const dir = this.repoDir(p.localPath);
    const remotes = await this.remotes(dir, false);
    if (!remotes.length) throw badRequest('This repository has no remote to fetch from');
    for (const r of remotes)
      await this.git(dir, ['fetch', '--prune', r.name], {
        env: this.d.github.gitEnvFor(r.url),
        timeout: 180_000,
      });
    return this.done(projectId, 'fetch', `Fetched ${remotes.map((r) => r.name).join(', ')}`);
  }

  async pull(projectId: string): Promise<GitActionResultDto> {
    const p = this.d.projects.get(projectId);
    const dir = this.repoDir(p.localPath);
    const branch = await this.currentOf(dir);
    if (!branch) throw badRequest('Switch to a branch first (HEAD is detached)');
    const upstream = (
      await this.git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
        allowFail: true,
      })
    ).out.trim();
    if (!upstream || upstream.startsWith('fatal'))
      throw badRequest(`${branch} doesn’t track a remote branch yet — push it first`);
    const remote = upstream.split('/')[0]!;
    const url = (await this.remotes(dir, false)).find((r) => r.name === remote)?.url ?? '';
    const r = await this.git(dir, ['pull', '--ff-only', '--no-rebase'], {
      env: this.d.github.gitEnvFor(url),
      allowFail: true,
      timeout: 180_000,
    });
    if (r.code !== 0) {
      if (/not possible to fast-forward|diverg/i.test(r.err + r.out))
        throw conflict(
          `${branch} and ${upstream} have both changed. Merge ${upstream} into ${branch} instead.`,
        );
      throw this.gitError('pull', r);
    }
    return this.done(
      projectId,
      'pull',
      /up to date/i.test(r.out)
        ? `${branch} is already up to date`
        : `Pulled ${upstream} into ${branch}`,
    );
  }

  async push(projectId: string, raw: unknown): Promise<GitActionResultDto> {
    const input = GitPushInputSchema.parse(raw ?? {});
    const p = this.d.projects.get(projectId);
    const dir = this.repoDir(p.localPath);
    const branch = input.branch ?? (await this.currentOf(dir));
    if (!branch) throw badRequest('Switch to a branch first (HEAD is detached)');
    await this.pushBranch(dir, p.githubRepo, branch);
    return this.done(projectId, 'push', `Pushed ${branch}`);
  }

  async pullRequest(projectId: string, raw: unknown): Promise<GitActionResultDto> {
    const input = GitPullRequestInputSchema.parse(raw);
    const p = this.d.projects.get(projectId);
    const dir = this.repoDir(p.localPath);
    if (!p.githubRepo)
      throw badRequest('Link this project to a GitHub repository to open pull requests');
    if (!(await this.d.github.status()).connected)
      throw badRequest('Connect GitHub (Integrations) to open pull requests');
    if (!(await gitops.branchExists(dir, input.branch))) throw notFound(`Branch ${input.branch}`);
    const baseBranch = input.base ?? this.workingOf(p, await this.currentOf(dir)) ?? 'main';
    if (baseBranch === input.branch) throw badRequest('Pick a different branch to merge into');
    const task = this.taskRows(projectId).find((t) => t.branchName === input.branch);
    await this.pushBranch(dir, p.githubRepo, input.branch);
    const pr = await this.d.github.createPullRequest(p.githubRepo, {
      head: input.branch,
      base: baseBranch,
      title: input.title ?? (task ? `${task.key}: ${task.title}` : titleFromBranch(input.branch)),
      body: input.body ?? (task ? task.description : `Opened from AgentForge.`),
    });
    if (task && !task.pullRequestUrl)
      this.d.db.update(tasks).set({ pullRequestUrl: pr.url }).where(eq(tasks.id, task.id)).run();
    return {
      ...(await this.done(projectId, 'pull_request', `Opened pull request #${pr.number}`)),
      url: pr.url,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async done(
    projectId: string,
    action: string,
    message: string,
  ): Promise<GitActionResultDto> {
    this.d.bus.emit('project.git', { projectId, action }, [Topics.project(projectId)]);
    return { message, overview: await this.overview(projectId) };
  }

  private isRepo(dir: string) {
    return existsSync(join(dir, '.git'));
  }

  private repoDir(dir: string): string {
    if (!this.isRepo(dir))
      throw badRequest('This project isn’t a git repository yet — initialise it first');
    return dir;
  }

  private workingOf(
    p: { workingBranch: string | null; defaultBranch: string | null },
    current: string | null,
  ) {
    return p.workingBranch ?? p.defaultBranch ?? current;
  }

  private async currentOf(dir: string): Promise<string | null> {
    const b = (await this.git(dir, ['branch', '--show-current'], { allowFail: true })).out.trim();
    return b || null;
  }

  private async switchTo(projectId: string, dir: string, branch: string) {
    const wt = (await this.worktrees(dir)).get(branch);
    if (wt && !samePath(wt, dir)) {
      const t = this.taskRows(projectId).find(
        (x) => x.worktreePath && samePath(x.worktreePath, wt),
      );
      throw conflict(
        t
          ? `${branch} is in use by ${t.key} (an agent is working on it in its own folder)`
          : `${branch} is already checked out in ${wt}`,
      );
    }
    const r = await this.git(dir, ['switch', branch], { allowFail: true });
    if (r.code !== 0) {
      if (/would be overwritten|commit your changes or stash/i.test(r.err))
        throw conflict(
          `Your uncommitted changes would be overwritten by ${branch} — commit them first`,
        );
      throw this.gitError('switch', r);
    }
  }

  private async pushBranch(dir: string, githubRepo: string | null, branch: string): Promise<void> {
    const remotes = await this.remotes(dir, false);
    const upstream = (
      await this.git(dir, ['config', '--get', `branch.${branch}.remote`], { allowFail: true })
    ).out.trim();
    const remote =
      remotes.find((r) => r.name === upstream) ??
      remotes.find((r) => r.name === 'origin') ??
      remotes[0];
    if (!remote) {
      if (githubRepo) {
        await this.git(dir, ['remote', 'add', 'origin', `https://github.com/${githubRepo}.git`]);
        return this.pushBranch(dir, githubRepo, branch);
      }
      throw badRequest('This repository has no remote to push to');
    }
    const r = await this.git(dir, ['push', '-u', remote.name, `${branch}:refs/heads/${branch}`], {
      env: this.d.github.gitEnvFor(remote.url),
      allowFail: true,
      timeout: 300_000,
    });
    if (r.code !== 0) {
      if (/rejected|non-fast-forward|fetch first/i.test(r.err))
        throw conflict(`${remote.name}/${branch} has commits you don’t have — pull first`);
      throw this.gitError('push', r);
    }
  }

  private async refs(dir: string): Promise<RefRow[]> {
    const fmt = [
      '%(refname)',
      '%(objectname:short)',
      '%(upstream:short)',
      '%(upstream:track,nobracket)',
      '%(committerdate:unix)',
      '%(authorname)',
      '%(subject)',
    ].join('%1f');
    const r = await this.git(
      dir,
      ['for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/heads', 'refs/remotes'],
      {
        allowFail: true,
      },
    );
    return r.out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, head, upstream, track, date, author, ...subject] = line.split(SEP);
        return {
          ref: ref!,
          head: head!,
          upstream: upstream ?? '',
          track: track ?? '',
          date: Number(date) || 0,
          author: author ?? '',
          subject: subject.join(SEP),
        };
      })
      .filter((r) => !r.ref.endsWith('/HEAD'));
  }

  private async mergedInto(dir: string, working: string): Promise<Set<string>> {
    const r = await this.git(
      dir,
      [
        'for-each-ref',
        `--merged=refs/heads/${working}`,
        '--format=%(refname)',
        'refs/heads',
        'refs/remotes',
      ],
      { allowFail: true },
    );
    return new Set(r.out.split('\n').filter(Boolean));
  }

  /** branch → folder for every worktree (the project folder included). */
  private async worktrees(dir: string): Promise<Map<string, string>> {
    const out = (await this.git(dir, ['worktree', 'list', '--porcelain'], { allowFail: true })).out;
    const map = new Map<string, string>();
    let path: string | null = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice(9);
      else if (line.startsWith('branch refs/heads/') && path) map.set(line.slice(18), path);
    }
    return map;
  }

  private async remotes(dir: string, redact = true): Promise<{ name: string; url: string }[]> {
    const out = (await this.git(dir, ['remote', '-v'], { allowFail: true })).out;
    const seen = new Map<string, string>();
    for (const line of out.split('\n')) {
      const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
      if (m && !seen.has(m[1]!)) seen.set(m[1]!, redact ? redactUrl(m[2]!) : m[2]!);
    }
    return [...seen].map(([name, url]) => ({ name, url }));
  }

  private async remoteNames(dir: string) {
    return (await this.remotes(dir)).map((r) => r.name);
  }

  /** "origin/feature" → the remote branch, when it is one. */
  private async remoteBranch(dir: string, name: string) {
    const remote = (await this.remoteNames(dir)).find((r) => name.startsWith(`${r}/`));
    if (!remote || !(await gitops.revParse(dir, `refs/remotes/${name}`))) return null;
    return { remote, plain: name.slice(remote.length + 1) };
  }

  private async operation(dir: string): Promise<GitOverviewDto['operation']> {
    const r = await this.git(dir, ['rev-parse', '--git-dir'], { allowFail: true });
    if (r.code !== 0) return null;
    const raw = r.out.trim();
    const gd = isAbsolute(raw) ? raw : resolve(dir, raw);
    if (existsSync(join(gd, 'MERGE_HEAD'))) return 'merge';
    if (existsSync(join(gd, 'rebase-merge')) || existsSync(join(gd, 'rebase-apply')))
      return 'rebase';
    if (existsSync(join(gd, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
    return null;
  }

  private taskRows(projectId: string) {
    return this.d.db.select().from(tasks).where(eq(tasks.projectId, projectId)).all();
  }

  private taskRefs(projectId: string, working: string | null): GitTaskRefDto[] {
    return this.taskRows(projectId)
      .filter((t) => t.branchName || t.pipelineState.mergedInto || t.pullRequestUrl)
      .map((t) => {
        const st = t.status as TaskStatus;
        const mergedInto = t.pipelineState.mergedInto ?? null;
        const state: GitTaskRefDto['state'] = mergedInto
          ? 'merged'
          : t.pullRequestUrl
            ? 'pull_request'
            : st === 'CANCELLED'
              ? 'cancelled'
              : st === 'DONE'
                ? 'done'
                : 'in_progress';
        return {
          id: t.id,
          key: t.key,
          title: t.title,
          status: st,
          branchName: t.branchName,
          baseBranch: t.baseBranch ?? (state === 'in_progress' ? working : null),
          mergedInto,
          mergeCommit: t.pipelineState.mergeCommit ?? null,
          pullRequestUrl: t.pullRequestUrl,
          state,
          completedAt: t.completedAt,
          updatedAt: t.updatedAt,
        };
      })
      .sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt));
  }

  private workGroups(
    refs: GitTaskRefDto[],
    working: string | null,
    locals: Set<string>,
  ): GitWorkGroupDto[] {
    const groups = new Map<string, GitTaskRefDto[]>();
    for (const t of refs) {
      const key = t.mergedInto ?? t.baseBranch ?? working ?? t.branchName ?? 'unknown';
      groups.set(key, [...(groups.get(key) ?? []), t]);
    }
    return [...groups]
      .map(([branch, list]) => ({ branch, exists: locals.has(branch), tasks: list }))
      .sort((a, b) =>
        a.branch === working ? -1 : b.branch === working ? 1 : b.tasks.length - a.tasks.length,
      );
  }

  private async git(
    cwd: string,
    args: string[],
    opts: { allowFail?: boolean; env?: Record<string, string>; timeout?: number } = {},
  ): Promise<Git> {
    const r = await execa('git', args, {
      cwd,
      reject: false,
      env: {
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
        LC_ALL: 'C',
        ...opts.env,
      },
      timeout: opts.timeout ?? 60_000,
      maxBuffer: 64 * 1024 * 1024,
      stripFinalNewline: false,
    });
    const res = { code: r.exitCode ?? 1, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') };
    if (res.code !== 0 && !opts.allowFail) throw this.gitError(args[0]!, res);
    return res;
  }

  private gitError(op: string, r: Git): AppError {
    const text = this.d.github
      .redact(`${r.err}\n${r.out}`)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('hint:'))
      .slice(-3)
      .join(' ');
    return new AppError(409, 'GIT_FAILED', `git ${op} failed: ${text || 'unknown error'}`);
  }
}

const short = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, '');

function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  if (track === 'gone') return { ahead: 0, behind: 0, gone: true };
  return {
    ahead: Number(track.match(/ahead (\d+)/)?.[1] ?? 0),
    behind: Number(track.match(/behind (\d+)/)?.[1] ?? 0),
    gone: false,
  };
}

/** Current and working first, then other local branches, then remote ones; newest first within each. */
function sortBranches(list: GitBranchDto[]): GitBranchDto[] {
  const rank = (b: GitBranchDto) => (b.current ? 0 : b.working ? 1 : b.kind === 'local' ? 2 : 3);
  return [...list].sort((a, b) => rank(a) - rank(b) || b.date - a.date);
}

const titleFromBranch = (b: string) => {
  const s = b
    .replace(/^[^/]+\//, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : b;
};

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}
