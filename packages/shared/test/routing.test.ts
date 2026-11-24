import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING,
  DEFAULT_SETTINGS,
  resolveRoleModel,
  resolveRouting,
  routingRuleFor,
  type Routing,
} from '../src';

describe('complexity routing', () => {
  it('is off by default, so every complexity runs the full pipeline', () => {
    expect(DEFAULT_ROUTING.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.routing.enabled).toBe(false);
    for (const c of ['xs', 's', 'm', 'l', 'xl'] as const)
      expect(routingRuleFor(DEFAULT_ROUTING, c)).toBeNull();
  });

  it('maps complexity to a pipeline profile and model when enabled', () => {
    const routing: Routing = { ...DEFAULT_ROUTING, enabled: true };
    expect(routingRuleFor(routing, 'xs')).toEqual({ pipeline: 'lite', model: 'haiku' });
    expect(routingRuleFor(routing, 's')).toEqual({ pipeline: 'lite', model: 'haiku' });
    expect(routingRuleFor(routing, 'm')).toEqual({ pipeline: 'full', model: null });
    expect(routingRuleFor(routing, 'l')).toEqual({ pipeline: 'full', model: 'opus' });
    expect(routingRuleFor(routing, 'xl')).toEqual({ pipeline: 'full', model: 'opus' });
  });

  it('prefers a project override over the global routing', () => {
    const global: Routing = { ...DEFAULT_ROUTING, enabled: true };
    const override: Routing = {
      enabled: true,
      profiles: { ...DEFAULT_ROUTING.profiles, xs: { pipeline: 'full', model: null } },
    };
    expect(resolveRouting(global, null)).toBe(global);
    expect(resolveRouting(global, undefined)).toBe(global);
    expect(resolveRouting(global, override)).toBe(override);
    expect(routingRuleFor(resolveRouting(global, override), 'xs')).toEqual({
      pipeline: 'full',
      model: null,
    });
  });
});

describe('role model resolution', () => {
  it('prefers the task override, then the project override, else nothing', () => {
    expect(resolveRoleModel({ developer: 'opus' }, { developer: 'sonnet' }, 'developer')).toBe(
      'opus',
    );
    expect(resolveRoleModel({}, { developer: 'sonnet' }, 'developer')).toBe('sonnet');
    expect(resolveRoleModel(undefined, undefined, 'developer')).toBeUndefined();
    // An override for another role doesn't apply.
    expect(resolveRoleModel({ reviewer: 'haiku' }, undefined, 'developer')).toBeUndefined();
  });
});
