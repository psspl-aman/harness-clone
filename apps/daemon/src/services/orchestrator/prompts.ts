import type { FixSource, TaskDiffDto, TaskDto } from '@agentforge/shared';

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
    t.subtasks.length
      ? `Subtasks:\n${t.subtasks.map((s, i) => `${i + 1}. [${s.done ? 'x' : ' '}] ${s.title}`).join('\n')}`
      : '',
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
- If the code needs a new environment variable (e.g. an API key): read it from the environment, add \`NAME=\` (empty) to the \`.env.example\` in the same folder, and call \`request_env_var\` if you have the \`agentforge\` tools. The user enters the real value in AgentForge — never ask for, invent or hardcode one, and mock it in tests.
- Keep changes focused on this task; follow the project's conventions.
- If you have the \`agentforge\` tools: search project memory before design decisions (\`project_memory_search\`) and record lasting decisions or pitfalls with \`project_memory_add\`.`;

/** Asks implementers to report finished subtasks so AgentForge can tick them off. */
const subtaskReport = (ctx: RoleContext) =>
  ctx.task.subtasks.length
    ? '\n\nEnd your reply with one line `Subtasks done: <numbers>` listing the subtasks above that are now complete (e.g. `Subtasks done: 1, 3`; `all` and `none` also work).'
    : '';

/** Reads the `Subtasks done:` line from an implementer's reply (last one wins). */
export function parseSubtasksDone(text: string): number[] | 'all' | null {
  const m = [...text.matchAll(/subtasks done\s*:\s*([^\n]*)/gi)].at(-1);
  if (!m) return null;
  const v = m[1]!
    .replace(/[`*_.]/g, '')
    .trim()
    .toLowerCase();
  if (v.startsWith('all')) return 'all';
  return [...v.matchAll(/\d+/g)].map((x) => Number(x[0]));
}

const JSON_ONLY =
  'Finish with ONLY one JSON object as your final message — no prose around it and no code fences.';

export function developerPrompt(ctx: RoleContext): string {
  return `# Role: Developer
You implement one task in an AgentForge pipeline. A Reviewer, a Tester and a Documenter follow you.

${contextBlock(ctx)}

${WORKTREE_RULES(ctx)}
- Implement the task fully, including unit tests for the code you add.
- Run the relevant build/test commands if you can and fix what you break.

When done, reply with a short summary of what you changed and anything the Reviewer should know.${subtaskReport(ctx)}`;
}

export function reviewerPrompt(
  ctx: RoleContext,
  d: TaskDiffDto,
  developerSummary: string | null,
  withheldSecrets: string[],
): string {
  return `# Role: Reviewer
You review the change for task ${ctx.task.key} before it is tested and merged. You may read files in the repository; do not modify anything.

${contextBlock(ctx)}

## Developer's summary
${developerSummary ?? '(none)'}
${withheldBlock(withheldSecrets)}
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

/**
 * Files AgentForge deliberately left out of the commits. Without this the Reviewer sees
 * them in the worktree but not in the diff, and requests a commit nobody is allowed to make.
 */
function withheldBlock(files: string[]): string {
  if (!files.length) return '';
  return `
## Files withheld from git by AgentForge
These files exist in the worktree but AgentForge never commits them, because they may hold real secrets:
${files.map((f) => `- ${f}`).join('\n')}
This is intended. Do not request that they be committed, and do not count their absence from the diff against the change. If the project needs to document the variables in them, a template such as \`.env.example\` (with placeholder values) is committed normally.
`;
}

export interface TestReviewInput {
  /** Changed files of the whole task. */
  files: TaskDiffDto['files'];
  /** Patch of the test files only. */
  testPatch: string;
  testerSummary: string;
  /** One line on the fail-before check, e.g. "Passed: …" or "Skipped: …". */
  failBefore: string;
}

/** Reviews the tests after they pass: do they really check the task? */
export function testReviewerPrompt(ctx: RoleContext, t: TestReviewInput): string {
  return `# Role: Reviewer (tests)
The tests for task ${ctx.task.key} pass. Your job is to check that they really test the task, so that passing them means it works. You may read files in the repository; do not modify anything.

${contextBlock(ctx)}

## Tester's summary
${t.testerSummary || '(none)'}

## Fail-before check
${t.failBefore}

## Changed files (${t.files.length})
${t.files.map((f) => `- ${f.status} ${f.path} (+${f.additions} −${f.deletions})`).join('\n') || '(none)'}

## Diff of the test files
${clip(t.testPatch, 60_000) || '(no test files changed)'}

Check that:
- every acceptance criterion is covered by at least one test that would fail if it were broken;
- assertions check real outcomes (not just "no error thrown", snapshots of nothing, or always-true conditions);
- tests exercise the real code: mocks don't replace the very thing under test;
- important edge cases and error paths of this change are tested;
- tests are deterministic (no reliance on timing, order, network or random data without control).
If the change has behaviour but no tests cover it, request changes. Request changes only for gaps that matter; use "info"/"minor" for suggestions.

${JSON_ONLY}
{
  "verdict": "APPROVE" | "CHANGES_REQUESTED",
  "summary": "One paragraph on how well the tests verify the task",
  "comments": [{ "file": "test/x.test.ts", "line": 12, "severity": "info" | "minor" | "major" | "blocker", "body": "What is missing or wrong and what test to add or change" }]
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
  source: FixSource | 'error';
  failure?: string;
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
      : fix.source === 'failure'
        ? `The pipeline failed on this task and the user asked you to fix it:\n${clip(fix.failure ?? '(no details recorded)', 12_000)}\n\nDiagnose the cause in this worktree and fix it so the task can continue to review and tests.`
        : fix.source === 'error'
          ? 'The error described in the task above was detected while running the project. Reproduce it if you can (use the project commands), find the root cause and fix it.'
          : fix.source === 'human'
            ? `The user reviewed the change and asked for:\n${fix.humanComments ?? ''}`
            : fix.source === 'test_quality'
              ? `The tests pass, but they also pass when this task's source changes are put back to how they were before the task. So they don't test the change.\n\nAdd or strengthen tests for the acceptance criteria so they fail without the change and pass with it. Change only test files — do NOT change application code.${fix.checkLog ? `\n\nDetails:\n\`\`\`\n${clip(fix.checkLog, 12_000)}\n\`\`\`` : ''}`
              : fix.source === 'test_review'
                ? `The Reviewer checked the tests and asked for better ones:\n${fix.review?.summary ?? ''}\n\n${(fix.review?.comments ?? []).map((c) => `- [${c.severity}] ${c.file ?? ''}${c.line ? `:${c.line}` : ''} ${c.body}`).join('\n')}\n\nImprove the tests as asked. Change application code only if a better test reveals a real bug in it.`
                : `Tests or the build failed:\n${fix.testSummary ?? ''}\n${(fix.failures ?? []).map((f) => `- ${f}`).join('\n')}${fix.checkLog ? `\n\nOutput of AgentForge's own checks:\n\`\`\`\n${clip(fix.checkLog, 12_000)}\n\`\`\`` : ''}`;
  return `# Role: Fixer
You fix problems found in task ${ctx.task.key}'s change.

${contextBlock(ctx)}

## What to fix
${problem}

${WORKTREE_RULES(ctx)}
- Fix the root cause; keep the change minimal and keep existing tests passing.

When done, reply with a short summary of each fix.${subtaskReport(ctx)}`;
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
