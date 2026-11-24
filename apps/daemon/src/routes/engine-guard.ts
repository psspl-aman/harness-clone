import { ROLE_LABELS, type AgentRole } from '@agentforge/shared';
import type { AppContext } from '../context';
import { badRequest } from '../http/errors';

type EngineMap = Partial<Record<string, string | null | undefined>>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Refuse to newly assign an engine that isn't installed (or is disabled). Values
 * that are unchanged pass, so an engine uninstalled later doesn't block saving
 * other fields — the orchestrator falls back for those at run time.
 */
export function assertUsableEngines(
  ctx: AppContext,
  next: unknown,
  current: EngineMap = {},
  what: (key: string) => string = (k) => ROLE_LABELS[k as AgentRole] ?? k,
): void {
  if (!isRecord(next)) return;
  for (const [key, id] of Object.entries(next)) {
    if (typeof id !== 'string' || !id || current[key] === id) continue;
    let ok = false;
    let name = id;
    try {
      const e = ctx.engines.get(id);
      name = e.displayName;
      ok = e.installed && e.enabled;
    } catch {
      /* unknown engine: not usable */
    }
    if (!ok)
      throw badRequest(
        `${name} isn’t installed${name === id ? '' : ' or is disabled'} — pick an installed engine for ${what(key)}.`,
      );
  }
}
