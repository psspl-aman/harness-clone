import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, tempDir, type TestApp } from './helpers';

let t: TestApp;
let root: string;
beforeEach(async () => {
  t = await createTestApp();
  root = tempDir();
});
afterEach(async () => {
  await t.cleanup();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const get = async (url: string) => t.app.inject({ method: 'GET', url });

describe('directory browser', () => {
  it('lists sub-folders only, hides dot-folders, marks git repos', async () => {
    mkdirSync(join(root, 'b-app/.git'), { recursive: true });
    mkdirSync(join(root, 'a-lib'));
    mkdirSync(join(root, '.hidden'));
    writeFileSync(join(root, 'notes.txt'), 'x');
    const res = (await get(`/api/fs/browse?path=${encodeURIComponent(root)}`)).json();
    expect(res.entries.map((e: { name: string }) => e.name)).toEqual(['a-lib', 'b-app']);
    expect(res.entries[1].isGitRepo).toBe(true);
    expect(res.fileCount).toBe(1);
    expect(res.writable).toBe(true);
    const withHidden = (
      await get(`/api/fs/browse?path=${encodeURIComponent(root)}&hidden=1`)
    ).json();
    expect(withHidden.entries.map((e: { name: string }) => e.name)).toContain('.hidden');
  });

  it('defaults to the home folder and 404s on missing paths', async () => {
    expect((await get('/api/fs/browse')).json().path).toBe(homedir());
    const missing = await get(`/api/fs/browse?path=${encodeURIComponent(join(root, 'nope'))}`);
    expect(missing.statusCode).toBe(404);
    expect((await get('/api/fs/browse?path=relative/path')).statusCode).toBe(400);
  });

  it('reports platform info and drive roots', async () => {
    const r = (await get('/api/fs/roots')).json();
    expect(r.home).toBe(homedir());
    if (process.platform === 'win32') {
      expect(r).toMatchObject({ platform: 'win32', sep: '\\' });
      expect(r.drives).toContain(parse(homedir()).root.toUpperCase());
      for (const d of r.drives) expect(d).toMatch(/^[A-Z]:\\$/);
    } else {
      expect(r).toMatchObject({ platform: 'posix', sep: '/', drives: ['/'] });
    }
  });

  it.runIf(process.platform === 'win32')('browses a drive root as the root, not cwd', async () => {
    const drive = parse(root).root; // e.g. C:\
    const res = (await get(`/api/fs/browse?path=${encodeURIComponent(drive)}`)).json();
    expect(res.path).toBe(drive);
    expect(res.parent).toBeNull();
  });

  const cookies = join(homedir(), 'Cookies');
  const hasJunction =
    process.platform === 'win32' && existsSync(cookies) && lstatSync(cookies).isSymbolicLink();
  it.runIf(hasJunction)(
    'hides Windows legacy junctions unless hidden folders are shown',
    async () => {
      const res = (await get(`/api/fs/browse?path=${encodeURIComponent(homedir())}`)).json();
      const names = res.entries.map((e: { name: string }) => e.name);
      expect(names).not.toContain('Cookies');
      expect(names).not.toContain('Application Data');
      const all = (
        await get(`/api/fs/browse?path=${encodeURIComponent(homedir())}&hidden=1`)
      ).json();
      expect(all.entries.find((e: { name: string }) => e.name === 'Cookies')).toMatchObject({
        hidden: true,
      });
    },
  );

  it('creates folders', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/fs/mkdir',
      payload: { parent: root, name: 'new-app' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().path).toBe(join(root, 'new-app'));
    const again = await t.app.inject({
      method: 'POST',
      url: '/api/fs/mkdir',
      payload: { parent: root, name: 'new-app' },
    });
    expect(again.statusCode).toBe(409);
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/fs/mkdir',
      payload: { parent: root, name: '../escape' },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('project path checks', () => {
  const check = async (path: string, mode: 'scratch' | 'existing') =>
    (await get(`/api/fs/check?path=${encodeURIComponent(path)}&mode=${mode}`)).json();

  it('accepts a new or empty folder for scratch, rejects non-empty ones', async () => {
    expect((await check(join(root, 'fresh'), 'scratch')).ok).toBe(true);
    mkdirSync(join(root, 'empty'));
    expect(await check(join(root, 'empty'), 'scratch')).toMatchObject({
      ok: true,
      exists: true,
      empty: true,
    });
    writeFileSync(join(root, 'empty/file.txt'), 'x');
    expect((await check(join(root, 'empty'), 'scratch')).reason).toMatch(/not empty/);
  });

  // Windows: asserts POSIX "dangerous location" semantics (e.g. `/`) that map differently on
  // Windows drives (a known cross-platform path gap, tracked as follow-up). Runs on Linux/macOS.
  it.skipIf(process.platform === 'win32')('rejects dangerous or invalid locations', async () => {
    for (const p of [
      '/',
      homedir(),
      '/etc/ai-harness',
      '/usr/local/x',
      t.home,
      join(t.home, 'logs'),
    ]) {
      expect((await check(p, 'existing')).ok, p).toBe(false);
    }
    writeFileSync(join(root, 'file'), 'x');
    expect((await check(join(root, 'file'), 'scratch')).reason).toMatch(/file/);
    expect((await check(join(root, 'missing/child'), 'scratch')).reason).toMatch(/Parent/);
    expect((await check(join(root, 'missing'), 'existing')).reason).toMatch(/does not exist/);
  });

  it.runIf(process.platform === 'win32')('rejects a drive root and the home folder', async () => {
    const drive = parse(homedir()).root; // e.g. C:\
    for (const p of [drive, drive.slice(0, 2) + '/', homedir()]) {
      expect((await check(p, 'existing')).reason, p).toMatch(/filesystem root or your home/);
    }
  });

  it('allows the managed workspace folder and warns about non-git existing folders', async () => {
    expect((await check(join(t.home, 'workspaces', 'repo'), 'scratch')).ok).toBe(true);
    writeFileSync(join(root, 'a.txt'), 'x');
    const r = await check(root, 'existing');
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/Not a git repository/);
  });
});
