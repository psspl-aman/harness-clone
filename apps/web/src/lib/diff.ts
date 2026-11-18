/** Minimal deep diff: returns only the keys of `next` that differ from `base`. */
export function diffObjects(base: unknown, next: unknown): unknown {
  if (
    typeof base !== 'object' ||
    typeof next !== 'object' ||
    base === null ||
    next === null ||
    Array.isArray(next)
  ) {
    return Object.is(base, next) ? undefined : next;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) {
    const d = diffObjects((base as Record<string, unknown>)[k], v);
    if (d !== undefined) out[k] = d;
  }
  return Object.keys(out).length ? out : undefined;
}
