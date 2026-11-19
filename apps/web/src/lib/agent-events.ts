import type { AgentEvent } from '@agentforge/shared';

/** One-line, human description of an agent stream event (null = not worth showing). */
export function describeEvent(e: AgentEvent): string | null {
  switch (e.kind) {
    case 'tool_call': {
      const input = (e.input ?? {}) as Record<string, unknown>;
      const target = input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.Path;
      return `${e.name}${typeof target === 'string' ? ` · ${target.length > 70 ? `…${target.slice(-70)}` : target}` : ''}`;
    }
    case 'thinking':
      return 'Thinking…';
    case 'text':
      return e.text.trim() ? 'Writing…' : null;
    default:
      return null;
  }
}

export const ROLE_VERB: Record<string, string> = {
  planner: 'Planning',
  developer: 'Developing',
  reviewer: 'Reviewing',
  tester: 'Testing',
  fixer: 'Fixing',
  documenter: 'Documenting',
};
