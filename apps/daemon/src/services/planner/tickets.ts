import type { PmsIssue } from '@ai-harness/shared';

/** Most tracker tickets looked up for one chat message (each is an MCP call). */
export const MAX_TICKETS_PER_MESSAGE = 5;

/** What the Planner is told about a ticket key the user mentioned. */
export type TicketReference =
  | { key: string; status: 'found'; tracker: string; issue: PmsIssue }
  | { key: string; status: 'failed'; tracker: string; reason: string }
  /** No tracker project linked to this project uses the key's prefix. */
  | { key: string; status: 'unlinked' };

/** Reads tickets through the project's linked issue trackers. */
export interface TicketSource {
  lookup(projectId: string, keys: string[]): Promise<TicketReference[]>;
}

/**
 * Jira-style ticket keys (`TVI-569`) in a chat message. `#KEY` is an AI Harness
 * task reference and keys in `exclude` (this project's own task keys) are
 * skipped. Upper-case only, so ordinary words don't match.
 */
export function extractTicketKeys(
  text: string,
  exclude: ReadonlySet<string>,
  max = MAX_TICKETS_PER_MESSAGE,
): string[] {
  const keys = [...text.matchAll(/(?<![\w#@/.-])([A-Z][A-Z0-9_]{1,9}-\d{1,7})(?![\w-])/g)]
    .map((m) => m[1]!)
    .filter((k) => !exclude.has(k));
  return [...new Set(keys)].slice(0, max);
}
