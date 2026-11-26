import {
  AppSettingsSchema,
  deepMerge,
  DEFAULT_SETTINGS,
  type AppSettings,
} from '@ai-harness/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { settings } from '../db/schema';
import type { EventBus } from '../events/bus';
import { badRequest } from '../http/errors';

const KEY = 'app';

export class SettingsService {
  private cache: AppSettings | null = null;

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly log: { warn: (obj: unknown, msg: string) => void },
  ) {}

  get(): AppSettings {
    if (this.cache) return this.cache;
    const row = this.db.select().from(settings).where(eq(settings.key, KEY)).get();
    const merged = deepMerge(DEFAULT_SETTINGS, row?.value ?? {});
    const parsed = AppSettingsSchema.safeParse(merged);
    if (parsed.success) {
      this.cache = parsed.data;
    } else {
      // Stored settings drifted from the schema (e.g. after an upgrade): keep
      // every still-valid section and reset only the invalid ones.
      this.log.warn({ issues: parsed.error.issues }, 'stored settings invalid; resetting bad keys');
      const repaired = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
      for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
        const candidate = { ...DEFAULT_SETTINGS, [key]: (merged as Record<string, unknown>)[key] };
        if (AppSettingsSchema.safeParse(candidate).success) repaired[key] = candidate[key];
      }
      this.cache = AppSettingsSchema.parse(repaired);
    }
    return this.cache;
  }

  update(patch: unknown): AppSettings {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw badRequest('Settings patch must be a JSON object');
    }
    const merged = deepMerge(this.get(), patch);
    // These maps are replaced as a whole so removed keys really go away (a deep
    // merge would keep them). The price table and the per-role model overrides.
    const p = patch as { pricing?: unknown; roleModels?: unknown };
    if (p.pricing !== undefined) merged.pricing = p.pricing as typeof merged.pricing;
    if (p.roleModels !== undefined) merged.roleModels = p.roleModels as typeof merged.roleModels;
    const next = AppSettingsSchema.parse(merged);
    this.db
      .insert(settings)
      .values({ key: KEY, value: next })
      .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: Date.now() } })
      .run();
    this.cache = next;
    this.bus.emit('settings.updated', { settings: next });
    return next;
  }
}
