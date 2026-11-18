import { describe, expect, it } from 'vitest';
import {
  AppSettingsSchema,
  ClientMessageSchema,
  deepMerge,
  DEFAULT_SETTINGS,
  EventPayloads,
  EVENT_TYPES,
  TopicSchema,
} from '../src';

describe('settings', () => {
  it('defaults are valid', () => {
    expect(AppSettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it('deep merges partial patches without clobbering siblings', () => {
    const merged = deepMerge(DEFAULT_SETTINGS, { pipeline: { maxFixLoops: 5 } });
    expect(merged.pipeline.maxFixLoops).toBe(5);
    expect(merged.pipeline.mergeStrategy).toBe('merge');
    expect(merged.concurrency).toEqual(DEFAULT_SETTINGS.concurrency);
    expect(DEFAULT_SETTINGS.pipeline.maxFixLoops).toBe(3); // base untouched
  });

  it('rejects unknown engines and out-of-range values', () => {
    const bad = deepMerge(DEFAULT_SETTINGS, { defaultEngines: { planner: 'gpt-shell' } });
    expect(AppSettingsSchema.safeParse(bad).success).toBe(false);
    const custom = deepMerge(DEFAULT_SETTINGS, { defaultEngines: { planner: 'custom:my-cli' } });
    expect(AppSettingsSchema.safeParse(custom).success).toBe(true);
    const range = deepMerge(DEFAULT_SETTINGS, { concurrency: { maxTasksPerProject: 0 } });
    expect(AppSettingsSchema.safeParse(range).success).toBe(false);
  });
});

describe('ws protocol', () => {
  it('validates topics', () => {
    expect(TopicSchema.safeParse('global').success).toBe(true);
    expect(TopicSchema.safeParse('project:abc_123').success).toBe(true);
    expect(TopicSchema.safeParse('project:').success).toBe(false);
    expect(TopicSchema.safeParse('admin:x').success).toBe(false);
  });

  it('parses client messages', () => {
    expect(ClientMessageSchema.parse({ op: 'subscribe', topics: ['global'], sinceSeq: 4 }).op).toBe(
      'subscribe',
    );
    expect(ClientMessageSchema.safeParse({ op: 'subscribe', topics: [] }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ op: 'nuke' }).success).toBe(false);
  });

  it('every event type has a payload schema', () => {
    for (const t of EVENT_TYPES) expect(EventPayloads[t]).toBeDefined();
  });
});
