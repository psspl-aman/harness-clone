import { describe, expect, it } from 'vitest';
import { extractJson, parsePlannerOutput } from '../src/services/planner/parse';
import { keyPrefix } from '../src/services/tasks';

const task = (ref: string, extra: object = {}) => ({
  ref,
  title: `Task ${ref}`,
  description: 'Do it',
  type: 'feature',
  priority: 'medium',
  complexity: 'm',
  acceptanceCriteria: ['Works'],
  ...extra,
});
const plan = (tasks: object[]) =>
  JSON.stringify({ type: 'plan', message: 'ok', plan: { goal: 'Build it' }, tasks });
const opts = { allowed: ['plan', 'questions'] as const, existingKeys: new Set(['TA-1']) };

describe('extractJson', () => {
  it('reads bare JSON, fenced JSON and JSON wrapped in prose', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Here you go:\n```json\n{"a":2}\n```\nThanks')).toEqual({ a: 2 });
    expect(extractJson('Sure! {"a": "brace } in string", "b": {"c": 3}} done')).toEqual({
      a: 'brace } in string',
      b: { c: 3 },
    });
  });
  it('prefers the last fenced block and reports invalid JSON', () => {
    expect(extractJson('```json\n{"v":1}\n```\nfixed:\n```json\n{"v":2}\n```')).toEqual({ v: 2 });
    expect(() => extractJson('no json here')).toThrow(/No JSON object/);
    expect(() => extractJson('{"a": }')).toThrow(/Invalid JSON/);
  });
});

describe('parsePlannerOutput', () => {
  it('accepts a valid plan and normalises enum casing and defaults', () => {
    const r = parsePlannerOutput(
      plan([
        task('T1', { type: 'Feature', priority: ' HIGH ' }),
        task('T2', { dependsOn: ['T1', 'ta-1'] }),
      ]),
      { ...opts, allowed: [...opts.allowed] },
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.output.type === 'plan') {
      expect(r.output.tasks[0]).toMatchObject({
        type: 'feature',
        priority: 'high',
        affectedAreas: [],
        subtasks: [],
        suggestedEngines: {},
      });
      expect(r.output.plan).toMatchObject({ goal: 'Build it', scope: '', risks: [] });
    }
  });

  it('reports schema problems with paths', () => {
    const r = parsePlannerOutput(
      plan([task('T1', { acceptanceCriteria: [], complexity: 'huge' })]),
      { ...opts, allowed: [...opts.allowed] },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join('\n')).toMatch(
        /tasks\.0\.acceptanceCriteria: Every task needs at least one acceptance criterion/,
      );
      expect(r.errors.join('\n')).toMatch(/tasks\.0\.complexity/);
    }
  });

  it('rejects unknown dependencies, self-dependencies, duplicates and cycles', () => {
    const run = (tasks: object[]) => {
      const r = parsePlannerOutput(plan(tasks), { ...opts, allowed: [...opts.allowed] });
      return r.ok ? [] : r.errors;
    };
    expect(run([task('T1', { dependsOn: ['T9'] })]).join()).toMatch(/unknown task "T9"/);
    expect(run([task('T1', { dependsOn: ['T1'] })]).join()).toMatch(/depends on itself/);
    expect(run([task('T1'), task('T1')]).join()).toMatch(/Duplicate task ref/);
    expect(
      run([task('T1', { dependsOn: ['T2'] }), task('T2', { dependsOn: ['T1'] })]).join(),
    ).toMatch(/cycle: T1 → T2 → T1/);
  });

  it('enforces the output types allowed for the request', () => {
    const r = parsePlannerOutput('{"type":"reply","message":"hi"}', {
      ...opts,
      allowed: [...opts.allowed],
    });
    expect(r).toEqual({
      ok: false,
      errors: ['"type" must be one of "plan", "questions" for this request (got "reply")'],
    });
  });
});

describe('task keys', () => {
  it('derives a short prefix from the project slug', () => {
    expect(keyPrefix('todo-app')).toBe('TA');
    expect(keyPrefix('storefront')).toBe('STO');
    expect(keyPrefix('my-big-cool-app')).toBe('MBC');
  });
});
