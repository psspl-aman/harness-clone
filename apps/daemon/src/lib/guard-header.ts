/** Header carrying a run's guard token (guard hook → safety API, agents → `/mcp`). */
export const GUARD_HEADER = 'x-ai-harness-guard';
/** Pre-rename (AgentForge) header, still accepted from older hook scripts and agent configs. */
const LEGACY_GUARD_HEADER = 'x-agentforge-guard';

export function readGuardToken(headers: Record<string, unknown>): string | undefined {
  const v = headers[GUARD_HEADER] ?? headers[LEGACY_GUARD_HEADER];
  return typeof v === 'string' ? v : undefined;
}
