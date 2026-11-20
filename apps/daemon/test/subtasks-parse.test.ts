import { describe, expect, it } from 'vitest';
import { parseSubtasksDone } from '../src/services/orchestrator/prompts';

describe('parseSubtasksDone', () => {
  it('reads the last "Subtasks done" line', () => {
    expect(parseSubtasksDone('Did things.\n\nSubtasks done: 1, 3')).toEqual([1, 3]);
    expect(parseSubtasksDone('**Subtasks done:** `2`')).toEqual([2]);
    expect(parseSubtasksDone('Subtasks done: 1\nlater\nSubtasks done: all')).toBe('all');
    expect(parseSubtasksDone('Subtasks done: none')).toEqual([]);
    expect(parseSubtasksDone('No report here')).toBeNull();
  });
});
