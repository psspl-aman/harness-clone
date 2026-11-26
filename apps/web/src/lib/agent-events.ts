import type { AgentEvent } from '@ai-harness/shared';

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

/** One log line for an agent event (null for events that aren't shown in logs). */
export function eventLine(e: AgentEvent): { text: string; tone?: string } | null {
  switch (e.kind) {
    case 'text':
      return { text: e.text };
    case 'tool_call':
      return {
        text: `→ ${e.name} ${JSON.stringify(e.input ?? {}).slice(0, 160)}`,
        tone: 'text-primary',
      };
    case 'tool_result':
      return {
        text: `  ${e.ok ? '✓' : '✗'} ${(e.output ?? '').slice(0, 300)}`,
        tone: e.ok ? 'text-muted-foreground' : 'text-destructive',
      };
    case 'error':
      return { text: e.message, tone: 'text-destructive' };
    case 'log':
      return e.stream === 'stderr' ? { text: e.line, tone: 'text-warning' } : null;
    default:
      return null;
  }
}
