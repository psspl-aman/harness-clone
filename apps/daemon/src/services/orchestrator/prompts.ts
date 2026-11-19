import type { TaskDiffDto, TaskDto } from '@agentforge/shared';

export interface RoleContext {
  project: {
    name: string;
    description: string | null;
    stack: string[];
    commands: Record<string, string | null | undefined>;
    conventions: string[];
  };
  memory: { title: string; content: string; pinned: boolean }[];
  memoryBudget: number;
  task: TaskDto;
  dependencies: { key: string; title: string; summary: string | null }[];
  branch: string;
  workingBranch: string;
  notes: string[];
}

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n)}\n… (truncated, ${s.length - n} more characters)` : s;

function memoryBlock(ctx: RoleContext): string {
  let out = '';
  for (const m of [...ctx.memory].sort((a, b) => Number(b.pinned) - Number(a.pinned))) {
    const block = `### ${m.title}\n${m.content}\n\n`;
    if (out.length + block.length > ctx.memoryBudget) break;
    out += block;
  }
  return out.trim() || '(none)';
}

function contextBlock(ctx: RoleContext): string {
  const t = ctx.task;
  const cmds = Object.entries(ctx.project.commands).filter(([, v]) => v);
  return [
    `## Project: ${ctx.project.name}`,
    ctx.project.description ?? '',
    ctx.project.stack.length ? `Stack: ${ctx.project.stack.join(', ')}` : '',
    cmds.length
      ? `Commands: ${cmds.map(([k, v]) => `${k}=\`${v}\``).join(', ')}`
      : 'No project commands are configured yet.',
    ctx.project.conventions.length
      ? `Conventions:\n${ctx.project.conventions.map((c) => `- ${c}`).join('\n')}`
      : '',
    `## Project memory\n${memoryBlock(ctx)}`,
    `## Task ${t.key}: ${t.title}`,
    `Type: ${t.type} · Priority: ${t.priority} · Complexity: ${t.complexity}`,
    t.description,
    `Acceptance criteria:\n${t.acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '- (none given)'}`,
    t.subtasks.length ? `Subtasks:\n${t.subtasks.map((s) => `- ${s.title}`).join('\n')}` : '',
    t.affectedAreas.length ? `Likely affected areas: ${t.affectedAreas.join(', ')}` : '',
    ctx.dependencies.length
      ? `## Already completed dependencies\n${ctx.dependencies.map((d) => `- ${d.key} ${d.title}${d.summary ? `: ${clip(d.summary, 400)}` : ''}`).join('\n')}`
      : '',
    ctx.notes.length
      ? `## Messages from the user (follow these)\n${ctx.notes.map((n) => `- ${n}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

const WORKTREE_RULES = (ctx: RoleContext) => `## Rules
- You are in a git worktree on branch \`${ctx.branch}\` (created from \`${ctx.workingBranch}\`). Work only inside this directory.
- Do NOT commit, push, merge, rebase or switch branches — AgentForge commits your changes after you finish.
- Never create, modify or print .env files, keys or other secrets.
- Keep changes focused on this task; follow the project's conventions.`;

const JSON_ONLY =
  'Finish with ONLY one JSON object as your final message — no prose around it and no code fences.';

export function developerPrompt(ctx: RoleContext): string {
  return `# Role: Developer
You implement one task in an AgentForge pipeline. A Reviewer, a Tester and a Documenter follow you.

${contextBlock(ctx)}

${WORKTREE_RULES(ctx)}
- Implement the task fully, including unit tests for the code you add.
- Run the relevant build/test commands if you can and fix what you break.

When done, reply with a short summary of what you changed and anything the Reviewer should know.`;
}

export function reviewerPrompt(
  ctx: RoleContext,
  d: TaskDiffDto,
  developerSummary: string | null,
): string {
  return `# Role: Reviewer
You review the change for task ${ctx.task.key} before it is tested and merged. You may read files in the repository; do not modify anything.

${contextBlock(ctx)}

## Developer's summary
${developerSummary ?? '(none)'}

## Changed files (${d.files.length})
${d.files.map((f) => `- ${f.status} ${f.path} (+${f.additions} −${f.deletions})`).join('\n') || '(no changes!)'}

## Diff against ${ctx.workingBranch}${d.truncated ? ' (truncated — read files for the rest)' : ''}
${clip(d.patch, 80_000) || '(empty diff)'}

Review for: correctness, every acceptance criterion being met, security (injection, secrets, unsafe input handling), error handling, tests covering the change, and consistency with the project's conventions.
Request changes only for problems that matter; use "info"/"minor" for suggestions. An empty diff must be CHANGES_REQUESTED.

${JSON_ONLY}
{
  "verdict": "APPROVE" | "CHANGES_REQUESTED",
  "summary": "One paragraph overall assessment",
  "comments": [{ "file": "src/x.ts", "line": 42, "severity": "info" | "minor" | "major" | "blocker", "body": "What is wrong and how to fix it" }]
}`;
}

export function testerPrompt(ctx: RoleContext, d: TaskDiffDto): string {
  return `# Role: Tester
You verify task ${ctx.task.key}. Make sure tests cover its acceptance criteria (write or update tests if they're missing or weak), then run the project's tests and build.

${contextBlock(ctx)}

## Changed files
${d.files.map((f) => `- ${f.path}`).join('\n') || '(none)'}

${WORKTREE_RULES(ctx)}
- Fix tests you write; do NOT change application code to make tests pass — report failures instead.
- AgentForge also runs the configured install/build/test commands itself after you.

${JSON_ONLY}
{
  "passed": true | false,
  "summary": "What you tested and the outcome",
  "total": 12, "failed": 0, "skipped": 0,
  "buildPassed": true | false | null,
  "commands": ["the commands you ran"],
  "failures": ["one entry per failing test or build error, with the key message"],
  "testsAdded": ["test files you created or changed"]
}`;
}

export interface FixInput {
  source: 'review' | 'tests' | 'human';
  review?: {
    summary: string;
    comments: { file?: string | null; line?: number | null; severity: string; body: string }[];
  };
  testSummary?: string;
  failures?: string[];
  checkLog?: string;
  humanComments?: string;
}

export function fixerPrompt(ctx: RoleContext, fix: FixInput): string {
  const problem =
    fix.source === 'review'
      ? `The Reviewer requested changes:\n${fix.review?.summary ?? ''}\n\n${(fix.review?.comments ?? []).map((c) => `- [${c.severity}] ${c.file ?? ''}${c.line ? `:${c.line}` : ''} ${c.body}`).join('\n')}`
      : fix.source === 'human'
        ? `The user reviewed the change and asked for:\n${fix.humanComments ?? ''}`
        : `Tests or the build failed:\n${fix.testSummary ?? ''}\n${(fix.failures ?? []).map((f) => `- ${f}`).join('\n')}${fix.checkLog ? `\n\nOutput of AgentForge's own checks:\n\`\`\`\n${clip(fix.checkLog, 12_000)}\n\`\`\`` : ''}`;
  return `# Role: Fixer
You fix problems found in task ${ctx.task.key}'s change.

${contextBlock(ctx)}

## What to fix
${problem}

${WORKTREE_RULES(ctx)}
- Fix the root cause; keep the change minimal and keep existing tests passing.

When done, reply with a short summary of each fix.`;
}

export function documenterPrompt(
  ctx: RoleContext,
  d: TaskDiffDto,
  review: string | null,
  tests: string | null,
): string {
  return `# Role: Documenter
Task ${ctx.task.key} passed review and tests. Update user-facing documentation where this change warrants it (README, CHANGELOG, docs/), then write the task report.

${contextBlock(ctx)}

## Changed files
${d.files.map((f) => `- ${f.status} ${f.path}`).join('\n') || '(none)'}

## Review outcome
${review ?? '(none)'}

## Test outcome
${tests ?? '(none)'}

${WORKTREE_RULES(ctx)}
- Only touch documentation files. If a CHANGELOG exists, add an entry; don't create one just for this.

${JSON_ONLY}
{
  "summary": "One or two sentences: what the task delivered",
  "report": "Markdown: what changed and why, how it works, how to use it",
  "docsUpdated": ["README.md"],
  "limitations": ["Known limitations or follow-ups"],
  "memory": [{ "kind": "decision" | "convention" | "pitfall" | "feature" | "architecture" | "command", "title": "...", "content": "Facts future agents should know" }]
}`;
}

export function conflictPrompt(
  ctx: RoleContext,
  original: { key: string; title: string },
  files: string[],
): string {
  return `# Role: Developer
You resolve merge conflicts. Task ${original.key} ("${original.title}") is finished on this branch, but \`${ctx.workingBranch}\` changed meanwhile and they conflict${files.length ? ` in: ${files.join(', ')}` : ''}.

${contextBlock(ctx)}

## Steps
1. Run \`git merge ${ctx.workingBranch}\` in this directory.
2. Resolve every conflict so both sides' intent is preserved; make the build and tests pass.
3. Stage the resolution with \`git add\` — this task explicitly allows completing the merge with \`git commit --no-edit\`.
- Never create, modify or print .env files or secrets.

When done, reply with a summary of how you resolved each conflict.`;
}
