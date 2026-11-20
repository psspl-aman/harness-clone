import type { TaskExternalDto } from './integrations';
import { z } from 'zod';
import {
  AGENT_ROLES,
  COMPLEXITIES,
  PLAN_STATUSES,
  PRIORITIES,
  REQUIREMENT_INTENTS,
  TASK_STATUSES,
  TASK_TYPES,
  type AgentRole,
  type Complexity,
  type PlanStatus,
  type Priority,
  type RequirementIntent,
  type TaskStatus,
  type TaskType,
} from './enums';
import { EngineIdSchema, type RoleEngines } from './settings';
import type { TaskPipelineDto } from './pipeline';
import type { TaskTimingDto } from './estimate';

// ─── Planner output contract (what the Planner agent must return) ────────────

const str = (max: number) => z.string().trim().min(1).max(max);
const strList = (maxItems: number, maxLen = 500) => z.array(str(maxLen)).max(maxItems);

/** Lenient enum: normalises case/whitespace before validating. */
const looseEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), z.enum(values));

export const PlannerTaskSchema = z.object({
  /** Local reference used for dependencies inside one planner response, e.g. "T1". */
  ref: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9_-]{0,15}$/, 'ref must look like T1'),
  title: str(160),
  description: str(8000),
  type: looseEnum(TASK_TYPES),
  priority: looseEnum(PRIORITIES),
  complexity: looseEnum(COMPLEXITIES),
  acceptanceCriteria: strList(20).min(1, 'Every task needs at least one acceptance criterion'),
  affectedAreas: strList(30, 300).default([]),
  /** refs of tasks in this response, or keys of existing tasks (e.g. "TA-3"). */
  dependsOn: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
  subtasks: strList(15, 300).default([]),
  /** Optional per-role engine suggestion. */
  suggestedEngines: z.partialRecord(z.enum(AGENT_ROLES), EngineIdSchema).default({}),
});
export type PlannerTask = z.infer<typeof PlannerTaskSchema>;

export const PlannerPlanSchema = z.object({
  goal: str(2000),
  scope: z.string().trim().max(6000).default(''),
  outOfScope: z.string().trim().max(4000).default(''),
  architectureNotes: z.string().trim().max(8000).default(''),
  risks: strList(20).default([]),
  assumptions: strList(20).default([]),
});

export const PlannerQuestionSchema = z.object({
  question: str(500),
  why: z.string().trim().max(500).optional(),
  /** Suggested answers the user can click. */
  options: strList(6, 200).optional(),
});
export type PlannerQuestion = z.infer<typeof PlannerQuestionSchema>;

export const PlannerOutputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('questions'),
    message: z.string().trim().max(4000).default(''),
    questions: z.array(PlannerQuestionSchema).min(1).max(8),
  }),
  z.object({
    type: z.literal('plan'),
    message: z.string().trim().max(4000).default(''),
    plan: PlannerPlanSchema,
    tasks: z.array(PlannerTaskSchema).min(1).max(40),
  }),
  z.object({
    type: z.literal('tasks'),
    message: z.string().trim().max(4000).default(''),
    tasks: z.array(PlannerTaskSchema).min(1).max(40),
  }),
  z.object({
    type: z.literal('task'),
    message: z.string().trim().max(4000).default(''),
    task: PlannerTaskSchema,
  }),
  z.object({ type: z.literal('reply'), message: str(20_000) }),
]);
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

// ─── Chat ────────────────────────────────────────────────────────────────────

export const MESSAGE_KINDS = ['message', 'questions', 'plan', 'error'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface AttachmentDto {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Absolute path agents can read. */
  path: string;
}

export interface ChatMessageDto {
  id: string;
  projectId: string;
  author: 'user' | 'planner' | 'system';
  kind: MessageKind;
  content: string;
  intent: RequirementIntent | null;
  status: 'done' | 'running' | 'failed' | 'cancelled';
  version: number;
  supersedesId: string | null;
  supersededBy: string | null;
  attachments: AttachmentDto[];
  references: { files: string[]; tasks: string[] };
  questions: PlannerQuestion[] | null;
  planId: string | null;
  runId: string | null;
  /** For user requirements: tasks this requirement produced (traceability). */
  producedTaskIds: string[];
  createdAt: number;
}

export const SendMessageInputSchema = z.object({
  content: z.string().trim().min(1, 'Write something first').max(50_000),
  intent: z.enum(REQUIREMENT_INTENTS),
  attachmentIds: z.array(z.string().max(64)).max(10).default([]),
  /** Ask the planner to plan without asking clarifying questions. */
  skipQuestions: z.boolean().default(false),
  /** Edit of an earlier user message: creates a new version. */
  supersedesId: z.string().max(64).optional(),
});
export type SendMessageInput = z.input<typeof SendMessageInputSchema>;

export interface PlannerState {
  projectId: string;
  running: boolean;
  runId: string | null;
  messageId: string | null;
  engineId: string | null;
  startedAt: number | null;
}

// ─── Plans & tasks ───────────────────────────────────────────────────────────

export interface SubtaskDto {
  id: string;
  title: string;
  done: boolean;
  orderIndex: number;
}

export interface TaskStatusChangeDto {
  from: TaskStatus | null;
  to: TaskStatus;
  reason: string | null;
  actor: string;
  createdAt: number;
}

/** A status change in the project-wide activity feed. */
export interface ActivityItemDto extends TaskStatusChangeDto {
  id: number;
  taskId: string;
  taskKey: string;
  taskTitle: string;
}

export interface TaskDto {
  id: string;
  projectId: string;
  planId: string | null;
  requirementId: string | null;
  key: string;
  title: string;
  description: string;
  type: TaskType;
  priority: Priority;
  complexity: Complexity;
  status: TaskStatus;
  statusReason: string | null;
  acceptanceCriteria: string[];
  affectedAreas: string[];
  roleEngines: Partial<RoleEngines>;
  orderIndex: number;
  dependsOn: string[];
  subtasks: SubtaskDto[];
  origin: string;
  /** Set for tasks imported from a PMS. */
  external: TaskExternalDto | null;
  /** Open errors recorded against this task (pipeline failures). */
  openErrors: number;
  pipeline: TaskPipelineDto;
  /** Estimated and spent agent time. */
  timing: TaskTimingDto;
  createdAt: number;
  updatedAt: number;
}

export interface PlanDto {
  id: string;
  projectId: string;
  requirementId: string | null;
  version: number;
  status: PlanStatus;
  goal: string;
  scope: string;
  outOfScope: string;
  architectureNotes: string;
  risks: string[];
  assumptions: string[];
  approvedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PlanBoardDto {
  plans: PlanDto[];
  tasks: TaskDto[];
}

const editable = {
  title: str(160),
  description: z.string().trim().max(8000),
  type: z.enum(TASK_TYPES),
  priority: z.enum(PRIORITIES),
  complexity: z.enum(COMPLEXITIES),
  acceptanceCriteria: strList(20),
  affectedAreas: strList(30, 300),
  roleEngines: z.partialRecord(z.enum(AGENT_ROLES), EngineIdSchema),
};

export const UpdateTaskInputSchema = z.object(editable).partial().strict();
export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>;

export const CreateTaskInputSchema = z.object({
  ...editable,
  description: editable.description.default(''),
  type: editable.type.default('feature'),
  priority: editable.priority.default('medium'),
  complexity: editable.complexity.default('m'),
  acceptanceCriteria: editable.acceptanceCriteria.default([]),
  affectedAreas: editable.affectedAreas.default([]),
  roleEngines: editable.roleEngines.default({}),
  dependsOn: z.array(z.string().max(64)).max(20).default([]),
  subtasks: strList(15, 300).default([]),
});
export type CreateTaskInput = z.input<typeof CreateTaskInputSchema>;

export const UpdatePlanInputSchema = z
  .object({
    goal: str(2000),
    scope: z.string().trim().max(6000),
    outOfScope: z.string().trim().max(4000),
    architectureNotes: z.string().trim().max(8000),
    risks: strList(20),
    assumptions: strList(20),
  })
  .partial()
  .strict();
export type UpdatePlanInput = z.infer<typeof UpdatePlanInputSchema>;

export const SetDependenciesInputSchema = z.object({
  dependsOn: z.array(z.string().max(64)).max(20),
});
export const SplitTaskInputSchema = z.object({
  parts: z
    .array(z.object({ title: str(160), description: z.string().trim().max(8000).optional() }))
    .min(2)
    .max(8),
});
export const MergeTasksInputSchema = z.object({
  taskIds: z.array(z.string().max(64)).min(2).max(10),
  title: str(160).optional(),
});
export const ReorderTasksInputSchema = z.object({
  taskIds: z.array(z.string().max(64)).min(1).max(200),
});
export const ApprovePlanInputSchema = z.object({
  taskIds: z.array(z.string().max(64)).max(200).optional(),
});
export const RegenerateInputSchema = z.object({
  instructions: z.string().trim().max(4000).default(''),
});
export const SubtaskInputSchema = z.object({ title: str(300) });
export const UpdateSubtaskInputSchema = z
  .object({ title: str(300), done: z.boolean(), orderIndex: z.number() })
  .partial()
  .strict();

export interface ReferenceSuggestions {
  files: string[];
  tasks: { key: string; title: string; status: TaskStatus }[];
}

export type {
  AgentRole,
  Complexity,
  PlanStatus,
  Priority,
  RequirementIntent,
  TaskStatus,
  TaskType,
};
export { TASK_STATUSES, PLAN_STATUSES };
