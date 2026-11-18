import { PlannerOutputSchema, type PlannerOutput } from '@agentforge/shared';
import { validatePlannerGraph } from '../tasks';

export type PlannerOutputType = PlannerOutput['type'];

/**
 * Pull a JSON object out of an LLM reply: prefers the last ```json fenced
 * block, otherwise the first balanced {...} span (string-aware).
 */
export function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)```/g)].map((m) =>
    m[1]!.trim(),
  );
  const candidates = [...fences.reverse(), ...balancedObjects(text)];
  let lastError = 'No JSON object found in the response';
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch (err) {
      lastError = `Invalid JSON: ${(err as Error).message}`;
    }
  }
  throw new Error(lastError);
}

/** Top-level balanced `{...}` substrings, in order of appearance. */
function balancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = depth > 0;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

export type ParseResult = { ok: true; output: PlannerOutput } | { ok: false; errors: string[] };

/** Extract, schema-validate and graph-check planner output. Errors are phrased for feeding back to the model. */
export function parsePlannerOutput(
  text: string,
  opts: { allowed: PlannerOutputType[]; existingKeys: Set<string> },
): ParseResult {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (err) {
    return { ok: false, errors: [(err as Error).message] };
  }
  const parsed = PlannerOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues
        .slice(0, 15)
        .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`),
    };
  }
  const output = parsed.data;
  if (!opts.allowed.includes(output.type)) {
    return {
      ok: false,
      errors: [
        `"type" must be one of ${opts.allowed.map((t) => `"${t}"`).join(', ')} for this request (got "${output.type}")`,
      ],
    };
  }
  const items =
    output.type === 'plan' || output.type === 'tasks'
      ? output.tasks
      : output.type === 'task'
        ? [output.task]
        : [];
  const problems = items.length ? validatePlannerGraph(items, opts.existingKeys) : [];
  return problems.length ? { ok: false, errors: problems } : { ok: true, output };
}
