import type { SheetSourceDto, TaskDto } from '@ai-harness/shared';
import ExcelJS from 'exceljs';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  csvUrlFor,
  parseComplexity,
  parseCsv,
  parsePriority,
  readTable,
  toRows,
} from '../src/services/sheets/read';
import { createTestApp, tempDir, type TestApp } from './helpers';

const until = async (fn: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
};

describe('sheet parsing', () => {
  it('parses quoted CSV, escaped quotes and newlines inside cells', () => {
    expect(parseCsv('a,b,c\n"x, y","say ""hi""","line1\nline2"\r\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
      ['1', '2', '3'],
    ]);
    // Semicolon-separated (European Excel exports) is sniffed from the header.
    expect(parseCsv('Title;Priority\nLogin;High')).toEqual([
      ['Title', 'Priority'],
      ['Login', 'High'],
    ]);
  });

  it('turns Google Sheets links into CSV export URLs', () => {
    expect(
      csvUrlFor('https://docs.google.com/spreadsheets/d/abc_123-X/edit?usp=sharing#gid=42'),
    ).toBe('https://docs.google.com/spreadsheets/d/abc_123-X/export?format=csv&gid=42');
    const pub = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ'; // gforge:allow — fake sheet id
    expect(csvUrlFor(`${pub}/pubhtml`)).toBe(`${pub}/pub?output=csv`);
    expect(csvUrlFor('https://example.com/tasks.csv?output=csv')).toBe(
      'https://example.com/tasks.csv?output=csv',
    );
    expect(() => csvUrlFor('http://docs.google.com/spreadsheets/d/x')).toThrow(/https/);
  });

  it('understands words, P-levels and numbers as priorities', () => {
    expect(parsePriority('Urgent')).toEqual({ priority: 'critical', rank: 0 });
    expect(parsePriority('high')).toEqual({ priority: 'high', rank: 1 });
    expect(parsePriority('P0')).toEqual({ priority: 'critical', rank: 0 });
    expect(parsePriority('p2')).toEqual({ priority: 'medium', rank: 2 });
    expect(parsePriority('1')).toEqual({ priority: 'critical', rank: 1 });
    expect(parsePriority('3')).toEqual({ priority: 'medium', rank: 3 });
    expect(parsePriority('7')).toEqual({ priority: 'low', rank: 7 });
    expect(parsePriority('2 - High')).toEqual({ priority: 'high', rank: 1 });
    expect(parsePriority('')).toEqual({ priority: 'medium', rank: 2 });
    expect(parseComplexity('Large')).toBe('l');
    expect(parseComplexity('3 pts')).toBe('m');
    expect(parseComplexity('XS')).toBe('xs');
  });

  it('maps columns, orders rows by priority and skips finished or duplicate rows', () => {
    const p = toRows({
      headers: ['Ref', 'Task name', 'Details', 'Prio', 'State'],
      rows: [
        ['A-1', 'Polish footer', 'Spacing', 'Low', ''],
        ['A-2', 'Fix checkout crash', 'Empty cart', 'P0', 'todo'],
        ['A-3', 'Add search', '', 'High', ''],
        ['A-4', 'Old thing', '', 'High', 'Done'],
        ['A-3', 'Add search again', '', 'Low', ''],
        ['', '', '', '', ''],
      ],
      rowNumbers: [2, 3, 4, 5, 6, 7],
      sheets: [],
    });
    expect(p.columns).toMatchObject({
      id: 'Ref',
      title: 'Task name',
      description: 'Details',
      priority: 'Prio',
      status: 'State',
    });
    expect(p.rows.map((r) => [r.id, r.priority, r.skip])).toEqual([
      ['A-2', 'critical', false],
      ['A-3', 'high', false],
      ['A-1', 'low', false],
      ['A-4', 'high', true],
    ]);
    expect(p.rows[0]).toMatchObject({ type: 'bug', row: 3 });
    expect(p.warnings.join('\n')).toMatch(/A-3” is used twice/);
  });

  it('reads Excel workbooks, choosing the worksheet', async () => {
    const dir = tempDir('af-xlsx-');
    const file = join(dir, 'plan.xlsx');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Notes').addRow(['nothing here']);
    const ws = wb.addWorksheet('Backlog');
    ws.addRow(['Title', 'Priority', 'Size']);
    ws.addRow(['Dark mode', 'Medium', 'S']);
    ws.addRow([{ richText: [{ text: 'Export ' }, { text: 'PDF' }] }, 1, 'XL']);
    await wb.xlsx.writeFile(file);
    try {
      const t = await readTable({ kind: 'file', location: file, sheet: 'Backlog' });
      expect(t.sheets).toEqual(['Notes', 'Backlog']);
      const p = toRows(t);
      expect(p.rows.map((r) => [r.title, r.priority, r.complexity])).toEqual([
        ['Export PDF', 'critical', 'xl'],
        ['Dark mode', 'medium', 's'],
      ]);
      await expect(readTable({ kind: 'file', location: file, sheet: 'Nope' })).rejects.toThrow(
        /No worksheet named “Nope”/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe('sheet sources', () => {
  let t: TestApp;
  let root: string;
  let projectId: string;
  let csv: string;

  const write = (rows: string[][]) =>
    writeFileSync(csv, rows.map((r) => r.map((c) => JSON.stringify(c)).join(',')).join('\n'));
  const tasks = (): TaskDto[] => t.ctx.tasks.board(projectId).tasks;
  const byTitle = (title: string) => tasks().find((x) => x.title === title);
  const sync = async (id: string) =>
    (await t.app.inject({ method: 'POST', url: `/api/sheets/${id}/sync` })).json();

  beforeEach(async () => {
    root = tempDir('af-sheets-');
    csv = join(root, 'backlog.csv');
    t = await createTestApp({}, { orchestrator: { autoStart: false } });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        mode: 'scratch',
        name: 'Sheet App',
        location: { kind: 'local', parentDir: root, folderName: 'app' },
      },
    });
    projectId = res.json().id;
  });
  afterEach(async () => {
    await t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('imports rows as approved tasks in priority order and keeps them in sync', async () => {
    write([
      ['ID', 'Title', 'Description', 'Priority', 'Status'],
      ['T-1', 'Polish footer', 'Spacing tweaks', 'Low', ''],
      ['T-2', 'Fix checkout crash', 'Throws on empty cart', 'P0', ''],
      ['T-3', 'Old feature', '', 'High', 'Done'],
      ['T-4', 'Add search', 'Search by name', 'High', ''],
    ]);
    const preview = await t.app.inject({
      method: 'POST',
      url: '/api/sheets/preview',
      payload: { kind: 'file', location: csv },
    });
    // Highest priority first; T-3 is marked done, so it's listed last and not imported.
    expect(preview.json().rows.map((r: { id: string }) => r.id)).toEqual([
      'T-2',
      'T-4',
      'T-1',
      'T-3',
    ]);

    const created = await t.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sheets`,
      payload: {
        name: 'Backlog',
        kind: 'file',
        location: csv,
        pollingIntervalSec: null,
        autoStart: true,
        autoEnrich: false,
      },
    });
    expect(created.statusCode).toBe(201);
    const src = created.json() as SheetSourceDto;
    expect(src.id).toMatch(/^sht_/);
    await until(() => tasks().length === 3);
    await until(() => !t.ctx.sheets.get(src.id).syncing);
    expect(t.ctx.sheets.get(src.id).lastResult).toMatchObject({
      total: 4,
      created: 3,
      skipped: 1,
      started: 3,
    });
    const list = [...tasks()].sort((a, b) => a.orderIndex - b.orderIndex);
    expect(list.map((x) => [x.title, x.priority, x.status])).toEqual([
      ['Fix checkout crash', 'critical', 'APPROVED'],
      ['Add search', 'high', 'APPROVED'],
      ['Polish footer', 'low', 'APPROVED'],
    ]);
    expect(byTitle('Fix checkout crash')).toMatchObject({
      type: 'bug',
      external: { provider: 'sheet', id: 'T-2' },
    });
    expect(byTitle('Fix checkout crash')!.description).toContain(
      'Imported from sheet “Backlog”, row 3',
    );

    // Unchanged on the next sync; an edit to an approved task is flagged, not applied.
    expect(await sync(src.id)).toMatchObject({ created: 0, unchanged: 3, skipped: 1 });
    write([
      ['ID', 'Title', 'Description', 'Priority', 'Status'],
      ['T-1', 'Polish footer', 'Spacing tweaks', 'Low', ''],
      ['T-2', 'Fix checkout crash', 'Throws on empty cart AND on coupons', 'P0', ''],
      ['T-4', 'Add search', 'Search by name', 'High', 'Cancelled'],
      ['T-5', 'Add sorting', '', '2', ''],
    ]);
    expect(await sync(src.id)).toMatchObject({ created: 1, conflicts: 2, started: 1 });
    expect(byTitle('Fix checkout crash')!.external?.conflict).toMatchObject({
      kind: 'changed',
      description: expect.stringContaining('AND on coupons'),
    });
    expect(byTitle('Add search')!.external?.conflict).toMatchObject({ kind: 'closed' });
    expect(byTitle('Add sorting')).toMatchObject({ priority: 'high', status: 'APPROVED' });
    // Flagged once, not on every sync.
    expect(await sync(src.id)).toMatchObject({ conflicts: 2 });
    const apply = await t.app.inject({
      method: 'POST',
      url: `/api/tasks/${byTitle('Fix checkout crash')!.id}/pms-conflict`,
      payload: { action: 'dismiss' },
    });
    expect(apply.statusCode).toBe(200);
    expect(await sync(src.id)).toMatchObject({ conflicts: 1, unchanged: 3 });
  });

  it('without auto-start, rows wait as drafts that follow sheet edits', async () => {
    write([
      ['Title', 'Priority'],
      ['Write docs', 'Medium'],
    ]);
    const src = (
      await t.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/sheets`,
        payload: {
          name: 'Ideas',
          kind: 'file',
          location: csv,
          pollingIntervalSec: null,
          autoStart: false,
          autoEnrich: false,
        },
      })
    ).json() as SheetSourceDto;
    await until(() => tasks().length === 1);
    expect(byTitle('Write docs')).toMatchObject({ status: 'DRAFT', priority: 'medium' });
    expect(byTitle('Write docs')!.external!.id).toMatch(/^row-[0-9a-f]{8}$/);
    await until(() => !t.ctx.sheets.get(src.id).syncing);

    write([
      ['Title', 'Priority', 'Description'],
      ['Write docs', 'Urgent', 'Cover install and run'],
    ]);
    expect(await sync(src.id)).toMatchObject({ updated: 1, started: 0 });
    expect(byTitle('Write docs')).toMatchObject({ status: 'DRAFT', priority: 'critical' });
    expect(byTitle('Write docs')!.description).toContain('Cover install and run');

    write([
      ['Title', 'Priority', 'Status'],
      ['Write docs', 'Urgent', "Won't do"],
    ]);
    expect(await sync(src.id)).toMatchObject({ updated: 1 });
    expect(byTitle('Write docs')!.status).toBe('CANCELLED');

    // Duplicate links are refused; unreadable files report the error on the source.
    const dup = await t.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sheets`,
      payload: { name: 'Again', kind: 'file', location: csv },
    });
    expect(dup.statusCode).toBe(409);
    rmSync(csv);
    const bad = await t.app.inject({ method: 'POST', url: `/api/sheets/${src.id}/sync` });
    expect(bad.statusCode).toBe(400);
    expect(t.ctx.sheets.get(src.id).lastError).toMatch(/File not found/);

    const del = await t.app.inject({ method: 'DELETE', url: `/api/sheets/${src.id}` });
    expect(del.statusCode).toBe(204);
    expect(tasks()).toHaveLength(1);
  });

  it('validates the source', async () => {
    const bad = await t.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sheets`,
      payload: { name: 'X', kind: 'file', location: 'relative/tasks.pdf' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/full path|Supported files/);
  });
});
