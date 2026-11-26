import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { readGuardToken } from '../src/lib/guard-header';
import {
  excludeProjectDataDir,
  isProjectDataPath,
  projectDataDirName,
} from '../src/lib/project-data-dir';

const RM_DIR = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

/** Installs and projects from before the AgentForge → AI Harness rename keep working. */
describe('rename compatibility', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-harness-compat-'));
  });
  afterEach(() => rmSync(dir, RM_DIR));

  describe('config', () => {
    it('prefers AI_HARNESS_* and reports nothing deprecated', () => {
      const c = loadConfig({ AI_HARNESS_HOME: dir, AI_HARNESS_PORT: '5000', AGENTFORGE_PORT: '6000' });
      expect(c.port).toBe(5000);
      expect(c.home).toBe(dir);
      expect(c.dbPath).toBe(join(dir, 'ai-harness.db'));
      expect(c.deprecations).toEqual([]);
    });

    it('falls back to AGENTFORGE_* with a deprecation notice', () => {
      const c = loadConfig({ AGENTFORGE_HOME: dir, AGENTFORGE_PORT: '6000' });
      expect(c.home).toBe(dir);
      expect(c.port).toBe(6000);
      expect(c.deprecations).toHaveLength(2);
      expect(c.deprecations.join('\n')).toMatch(/AGENTFORGE_PORT is deprecated.*AI_HARNESS_PORT/);
    });

    it('keeps using an existing agentforge.db until an ai-harness.db exists', () => {
      writeFileSync(join(dir, 'agentforge.db'), '');
      expect(loadConfig({ AI_HARNESS_HOME: dir }).dbPath).toBe(join(dir, 'agentforge.db'));
      writeFileSync(join(dir, 'ai-harness.db'), '');
      expect(loadConfig({ AI_HARNESS_HOME: dir }).dbPath).toBe(join(dir, 'ai-harness.db'));
    });
  });

  describe('project data folder', () => {
    it('uses .ai-harness for new projects', () => {
      expect(projectDataDirName(dir)).toBe('.ai-harness');
    });

    it('keeps an existing .agentforge folder, and excludes that name from git', () => {
      mkdirSync(join(dir, '.agentforge'));
      mkdirSync(join(dir, '.git'));
      expect(projectDataDirName(dir)).toBe('.agentforge');
      excludeProjectDataDir(dir);
      expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toBe('.agentforge/\n');
    });

    it('recognises paths under either name', () => {
      expect(isProjectDataPath('.ai-harness/memory.md')).toBe(true);
      expect(isProjectDataPath('.agentforge/tasks/SA-1.md')).toBe(true);
      expect(isProjectDataPath('.ai-harnessx/file')).toBe(false);
      expect(isProjectDataPath('src/.ai-harness/file')).toBe(false);
    });
  });

  it('accepts the legacy guard header', () => {
    expect(readGuardToken({ 'x-ai-harness-guard': 'new' })).toBe('new');
    expect(readGuardToken({ 'x-agentforge-guard': 'old' })).toBe('old');
    expect(readGuardToken({})).toBeUndefined();
  });
});
