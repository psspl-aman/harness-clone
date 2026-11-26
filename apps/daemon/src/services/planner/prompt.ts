import type { AttachmentDto, OnboardingReport, PlanDto, TaskDto } from '@ai-harness/shared';
import type { PlannerOutputType } from './parse';

export type PlannerMode =
  'generate_plan' | 'add_to_plan' | 'discuss' | 'regenerate_plan' | 'regenerate_task';

export interface PlannerContext {
  mode: PlannerMode;
  project: {
    name: string;
    description: string | null;
    localPath: string;
    origin: 'scratch' | 'existing';
    stack: string[];
    stackPreferences: string | null;
    commands: Record<string, string | null | undefined>;
  };
  report: OnboardingReport | null;
  memory: { title: string; content: string; pinned: boolean }[];
  memoryBudget: number;
  plan: PlanDto | null;
  tasks: TaskDto[];
  history: { author: string; content: string }[];
  requirement: string;
  instructions?: string;
  targetTask?: TaskDto;
  referencedFiles: string[];
  referencedTasks: TaskDto[];
  attachments: AttachmentDto[];
  engines: string[];
  allowQuestions: boolean;
}

export const ALLOWED_OUTPUTS: Record<PlannerMode, PlannerOutputType[]> = {
  generate_plan: ['plan', 'questions'],
  regenerate_plan: ['plan'],
  add_to_plan: ['tasks', 'questions'],
  discuss: ['reply'],
  regenerate_task: ['task'],
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (truncated)` : s);

function memoryBlock(ctx: PlannerContext): string {
  const entries = [...ctx.memory].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  let out = '';
  for (const e of entries) {
    const block = `### ${e.title}${e.pinned ? ' (pinned)' : ''}\n${e.content}\n\n`;
    if (out.length + block.length > ctx.memoryBudget) break;
    out += block;
  }
  return out.trim() || '(no project memory yet)';
}

function codebaseBlock(r: OnboardingReport | null): string {
  if (!r) return '(not analysed yet)';
  if (r.stats.files === 0 || r.notes.some((n) => n.includes('folder is empty')))
    return 'The repository is empty. The first tasks must scaffold the project.';
  return [
    r.languages.length &&
      `Languages: ${r.languages.map((l) => `${l.name} ${l.share}%`).join(', ')}`,
    r.frameworks.length && `Frameworks/tools: ${r.frameworks.join(', ')}`,
    r.packageManagers.length && `Package manager: ${r.packageManagers.join(', ')}`,
    r.monorepo && `Monorepo (${r.monorepo.tool}): ${r.monorepo.packages.join(', ')}`,
    r.conventions.length && `Conventions:\n${r.conventions.map((c) => `- ${c}`).join('\n')}`,
    `Structure:\n${clip(r.structure, 3000)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function taskLine(t: TaskDto, all: TaskDto[]): string {
  const deps = t.dependsOn.map((id) => all.find((x) => x.id === id)?.key).filter(Boolean);
  return `- ${t.key} [${t.status}] (${t.type}, ${t.priority}, ${t.complexity}) ${t.title}${deps.length ? ` — depends on ${deps.join(', ')}` : ''}`;
}

const TASK_SHAPE = `{
      "ref": "T1",                      // short local id, unique in this response
      "title": "Imperative, specific title",
      "description": "What to build and how, with enough detail for a developer agent (markdown ok)",
      "type": "feature" | "bug" | "refactor" | "test" | "docs" | "chore",
      "priority": "low" | "medium" | "high" | "critical",
      "complexity": "xs" | "s" | "m" | "l" | "xl",
      "acceptanceCriteria": ["Verifiable outcome", "..."],   // at least 1
      "affectedAreas": ["src/routes/todos.ts", "web/app/page.tsx"],  // estimated files/areas
      "dependsOn": ["T0"],             // refs from this response or existing task keys
      "subtasks": ["Optional smaller steps"],
      "suggestedEngines": { "developer": "claude-code" }   // optional; roles: planner, developer, reviewer, tester, fixer, documenter
    }`;

function outputContract(ctx: PlannerContext): string {
  const allowed = ALLOWED_OUTPUTS[ctx.mode].filter((t) => t !== 'questions' || ctx.allowQuestions);
  const shapes: Record<PlannerOutputType, string> = {
    plan: `{
  "type": "plan",
  "message": "2-4 sentence summary for the user",
  "plan": {
    "goal": "...", "scope": "...", "outOfScope": "...", "architectureNotes": "...",
    "risks": ["..."], "assumptions": ["..."]
  },
  "tasks": [
    ${TASK_SHAPE}
  ]
}`,
    tasks: `{
  "type": "tasks",
  "message": "Short summary of what you added",
  "tasks": [
    ${TASK_SHAPE}
  ]
}`,
    task: `{
  "type": "task",
  "message": "What you changed",
  "task": ${TASK_SHAPE.replace(/\n {4}/g, '\n  ')}
}`,
    questions: `{
  "type": "questions",
  "message": "Why you need answers before planning",
  "questions": [{ "question": "...", "why": "...", "options": ["Option A", "Option B"] }]
}`,
    reply: `{ "type": "reply", "message": "Your answer in markdown" }`,
  };
  return [
    `Respond with ONLY one JSON object — no prose before or after it, no markdown code fences, no comments. Allowed shapes:`,
    ...allowed.map((t) => shapes[t]),
  ].join('\n\n');
}

function modeInstructions(ctx: PlannerContext): string {
  const q = ctx.allowQuestions
    ? 'If — and only if — the requirement is too ambiguous to plan responsibly, return "questions" (at most 5, each with suggested options). Otherwise plan, stating assumptions.'
    : 'Do not ask questions: make reasonable assumptions and list them in "assumptions".';
  switch (ctx.mode) {
    case 'generate_plan':
      return `Create a complete implementation plan for the requirement below. ${q}`;
    case 'regenerate_plan':
      return `Re-create the current draft plan from scratch for the requirement below, applying the user's extra instructions. Do not ask questions.`;
    case 'add_to_plan':
      return `Add NEW tasks to the existing plan for the requirement below. Do not repeat existing tasks; new tasks may depend on existing task keys. ${q}`;
    case 'discuss':
      return 'The user wants to discuss, not plan. Answer helpfully and concisely. Do not create tasks.';
    case 'regenerate_task':
      return `Rewrite task ${ctx.targetTask?.key ?? ''} applying the user's instructions. Keep it the same unit of work unless told otherwise; you may change any field. Use ref "T1"; dependsOn may only use existing task keys.`;
  }
}

const RULES = `Planning rules:
- Prefer the fewest tasks that deliver the requirement. A small or self-contained request should be a SINGLE task — do not split a simple ask into separate setup, implementation, test and documentation tasks. Decompose into several tasks only when the work genuinely spans independent pieces, has real ordering dependencies, or is too large for one agent session to implement and one reviewer to check in a pass (roughly ≤ 300 changed lines each). Split anything bigger.
- Match the solution to the request. For a trivial ask (a single page, a small script, a one-off), choose the simplest implementation that satisfies it — a single static file with no framework, build step or dependencies when that is enough. Reserve frameworks and build tooling for requests that actually need them.
- Size each task honestly with complexity: a trivial one-file change is xs or s; reserve l/xl for genuinely large work. This drives how much pipeline a task gets.
- Order tasks so dependencies come first; express ordering with dependsOn. No cycles.
- Acceptance criteria must be objectively verifiable (behaviour, tests passing, commands succeeding).
- Include tests in the same task as the code they cover; add separate test tasks only for broad test suites.
- For an empty repository that needs a project structure, start with a scaffolding task that sets up the stack, tooling, a test runner and run/build/test scripts — but a trivial single-file requirement needs no scaffolding, framework or build step.
- Respect the existing stack, conventions and commands. Never plan to commit secrets or .env files.
- You may read files in the repository to ground the plan, but you must not modify anything.`;

export function buildPlannerPrompt(ctx: PlannerContext): string {
  const p = ctx.project;
  const cmds = Object.entries(p.commands).filter(([, v]) => v);
  const sections = [
    `You are the Planner agent in AI Harness, a harness where specialised AI agents (Developer, Reviewer, Tester, Fixer, Documenter) build software from tasks you define. A human reviews and approves your plan before anything is built.`,
    `## Project\nName: ${p.name}\n${p.description ? `Description: ${p.description}\n` : ''}Path: ${p.localPath}\nOrigin: ${p.origin === 'scratch' ? 'new project from scratch' : 'existing codebase'}\n${p.stack.length ? `Detected stack: ${p.stack.join(', ')}\n` : ''}${p.stackPreferences ? `Stack preferences from the user: ${p.stackPreferences}\n` : ''}${cmds.length ? `Commands: ${cmds.map(([k, v]) => `${k}=\`${v}\``).join(', ')}` : ''}`.trim(),
    `## Codebase summary\n${codebaseBlock(ctx.report)}`,
    `## Project memory\n${memoryBlock(ctx)}`,
  ];
  if (ctx.plan || ctx.tasks.length) {
    sections.push(
      `## Current plan${ctx.plan ? ` (v${ctx.plan.version}, ${ctx.plan.status.toLowerCase()})` : ''}\n${ctx.plan ? `Goal: ${ctx.plan.goal}\n` : ''}${ctx.tasks.map((t) => taskLine(t, ctx.tasks)).join('\n') || '(no tasks)'}`,
    );
  }
  if (ctx.history.length) {
    sections.push(
      `## Conversation so far\n${ctx.history.map((m) => `[${m.author}] ${clip(m.content, 1500)}`).join('\n\n')}`,
    );
  }
  if (ctx.targetTask) {
    const t = ctx.targetTask;
    sections.push(
      `## Task to rewrite: ${t.key}\nTitle: ${t.title}\nType: ${t.type}, priority ${t.priority}, complexity ${t.complexity}\nDescription:\n${t.description}\nAcceptance criteria:\n${t.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}\nAffected areas: ${t.affectedAreas.join(', ') || '—'}\nSubtasks: ${t.subtasks.map((s) => s.title).join('; ') || '—'}`,
    );
  }
  sections.push(`## Your job\n${modeInstructions(ctx)}`);
  sections.push(
    `## Requirement\n${ctx.requirement}${ctx.instructions ? `\n\nExtra instructions from the user: ${ctx.instructions}` : ''}`,
  );
  if (ctx.referencedFiles.length)
    sections.push(
      `## Files the user referenced (read them)\n${ctx.referencedFiles.map((f) => `- ${f}`).join('\n')}`,
    );
  if (ctx.referencedTasks.length) {
    sections.push(
      `## Tasks the user referenced\n${ctx.referencedTasks.map((t) => `- ${t.key} [${t.status}] ${t.title}\n  ${clip(t.description, 600).replace(/\n/g, '\n  ')}`).join('\n')}`,
    );
  }
  if (ctx.attachments.length) {
    sections.push(
      `## Attachments (read them; images included)\n${ctx.attachments.map((a) => `- ${a.name} (${a.mime}, ${a.size} bytes): ${a.path}${a.textPath ? `\n  Text version (read this one): ${a.textPath}` : ''}`).join('\n')}`,
    );
  }
  if (ctx.mode !== 'discuss')
    sections.push(`## Available engines for suggestedEngines\n${ctx.engines.join(', ')}`);
  if (ctx.mode !== 'discuss') sections.push(RULES);
  sections.push(`## Output format\n${outputContract(ctx)}`);
  return sections.join('\n\n');
}

export function buildRetryPrompt(errors: string[], allowed: PlannerOutputType[]): string {
  return `Your previous response could not be used:\n${errors.map((e) => `- ${e}`).join('\n')}\n\nReply again with ONLY the corrected JSON object (type ${allowed.map((t) => `"${t}"`).join(' or ')}), no prose and no code fences.`;
}
