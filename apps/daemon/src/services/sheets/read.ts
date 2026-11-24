import {
  COMPLEXITIES,
  SHEET_FIELDS,
  TASK_TYPES,
  type Complexity,
  type Priority,
  type SheetField,
  type SheetKind,
  type SheetPreviewDto,
  type SheetRowDto,
  type TaskType,
} from '@agentforge/shared';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { badRequest } from '../../http/errors';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 2000;
const FETCH_TIMEOUT_MS = 20_000;

export interface SheetTable {
  headers: string[];
  rows: string[][];
  /** Sheet row number (1-based) of each data row. */
  rowNumbers: number[];
  sheets: string[];
}

export interface SheetLocation {
  kind: SheetKind;
  location: string;
  sheet?: string | null;
}

// ─── Fetching ────────────────────────────────────────────────────────────────

/**
 * Turn a Google Sheets link into its CSV export URL. Works for sheets shared as
 * "Anyone with the link can view" and for "Publish to web" links; any other
 * https URL is fetched as CSV as-is.
 */
export function csvUrlFor(link: string): string {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    throw badRequest('That isn’t a valid link');
  }
  if (u.protocol !== 'https:') throw badRequest('Use an https:// link');
  if (/(^|[?&])(format|output)=(csv|tsv)/.test(u.search)) return u.toString();
  if (u.hostname === 'docs.google.com') {
    const gid = u.searchParams.get('gid') ?? /gid=(\d+)/.exec(u.hash)?.[1] ?? null;
    const g = gid ? `&gid=${gid}` : '';
    const pub = /\/spreadsheets\/d\/e\/([\w-]+)/.exec(u.pathname);
    if (pub) return `https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=csv${g}`;
    const doc = /\/spreadsheets\/d\/([\w-]+)/.exec(u.pathname);
    if (doc) return `https://docs.google.com/spreadsheets/d/${doc[1]}/export?format=csv${g}`;
    throw badRequest('That isn’t a Google Sheets link (expected docs.google.com/spreadsheets/d/…)');
  }
  return u.toString();
}

async function fetchCsv(link: string): Promise<string> {
  const url = csvUrlFor(link);
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'text/csv,text/plain;q=0.9,*/*;q=0.1' },
    });
  } catch (err) {
    throw badRequest(`Couldn’t reach the sheet: ${(err as Error).message}`);
  }
  const type = res.headers.get('content-type') ?? '';
  if ([401, 403, 404].includes(res.status) || type.includes('text/html'))
    throw badRequest(
      'The sheet isn’t readable without signing in. In Google Sheets choose Share → General access → “Anyone with the link” (Viewer), or File → Share → Publish to web.',
    );
  if (!res.ok) throw badRequest(`The sheet returned HTTP ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES)
    throw badRequest('The sheet is too large (over 20 MB)');
  const text = await res.text();
  if (text.length > MAX_BYTES) throw badRequest('The sheet is too large (over 20 MB)');
  return text;
}

export function expandPath(p: string): string {
  return resolve(p.startsWith('~/') ? `${homedir()}${p.slice(1)}` : p);
}

const cellText = (v: ExcelJS.CellValue): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    return '';
  }
  return String(v);
};

async function readXlsx(path: string, sheet: string | null | undefined) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(path);
  } catch (err) {
    throw badRequest(`Couldn’t open the Excel file: ${(err as Error).message}`);
  }
  const sheets = wb.worksheets.map((w) => w.name);
  const ws = sheet ? wb.getWorksheet(sheet) : wb.worksheets[0];
  if (!ws)
    throw badRequest(
      sheet
        ? `No worksheet named “${sheet}” (found: ${sheets.join(', ')})`
        : 'The workbook is empty',
    );
  const rows: { n: number; cells: string[] }[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const values = row.values as ExcelJS.CellValue[];
    // ExcelJS row values are 1-based: index 0 is always empty.
    const cells: string[] = [];
    for (let i = 1; i < values.length; i++) cells.push(cellText(values[i]).trim());
    rows.push({ n, cells });
  });
  return { rows, sheets };
}

/** Read the raw table (header row + data rows) from a sheet source. */
export async function readTable(src: SheetLocation): Promise<SheetTable> {
  let raw: { n: number; cells: string[] }[];
  let sheets: string[] = [];
  if (src.kind === 'google') {
    raw = parseCsv(await fetchCsv(src.location)).map((cells, i) => ({ n: i + 1, cells }));
  } else {
    const path = expandPath(src.location);
    let size: number;
    try {
      const s = await stat(path);
      if (!s.isFile()) throw new Error('not a file');
      size = s.size;
    } catch {
      throw badRequest(`File not found: ${path}`);
    }
    if (size > MAX_BYTES) throw badRequest('The file is too large (over 20 MB)');
    const ext = extname(path).toLowerCase();
    if (ext === '.xlsx') {
      const x = await readXlsx(path, src.sheet);
      raw = x.rows;
      sheets = x.sheets;
    } else if (ext === '.csv' || ext === '.tsv') {
      const text = await readFile(path, 'utf8');
      raw = parseCsv(text, ext === '.tsv' ? '\t' : undefined).map((cells, i) => ({
        n: i + 1,
        cells,
      }));
    } else {
      throw badRequest('Supported files: .xlsx, .csv, .tsv');
    }
  }
  const nonEmpty = raw.filter((r) => r.cells.some((c) => c.trim() !== ''));
  const [head, ...body] = nonEmpty;
  if (!head) return { headers: [], rows: [], rowNumbers: [], sheets };
  const data = body.slice(0, MAX_ROWS);
  return {
    headers: head.cells.map((h) => h.trim()),
    rows: data.map((r) => r.cells),
    rowNumbers: data.map((r) => r.n),
    sheets,
  };
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

/** RFC 4180 CSV (quoted fields, escaped quotes, newlines in quotes); delimiter sniffed when omitted. */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const nl = src.search(/\r?\n/);
  const firstLine = nl < 0 ? src : src.slice(0, nl);
  const d =
    delimiter ??
    [',', ';', '\t'].map((c) => ({ c, n: firstLine.split(c).length })).sort((a, b) => b.n - a.n)[0]!
      .c;
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === d) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      out.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    out.push(row);
  }
  return out.map((r) => r.map((c) => c.trim()));
}

// ─── Columns ─────────────────────────────────────────────────────────────────

const ALIASES: Record<SheetField, string[]> = {
  id: ['id', 'key', 'ticket', 'ticket id', 'task id', 'issue', 'issue id', 'ref', 'no', '#'],
  title: ['title', 'task', 'task name', 'name', 'summary', 'feature', 'item', 'story', 'todo'],
  description: [
    'description',
    'details',
    'detail',
    'desc',
    'notes',
    'requirement',
    'requirements',
    'body',
    'what',
    'spec',
  ],
  priority: ['priority', 'prio', 'pri', 'p', 'importance', 'urgency', 'rank', 'order', 'severity'],
  complexity: [
    'complexity',
    'size',
    'estimate',
    'effort',
    'points',
    'story points',
    'sp',
    't shirt',
  ],
  type: ['type', 'kind', 'category', 'task type', 'issue type'],
  status: ['status', 'state', 'done', 'stage', 'progress'],
  acceptance: ['acceptance criteria', 'acceptance', 'criteria', 'definition of done', 'dod', 'ac'],
};

const norm = (h: string) =>
  h
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, ' ')
    .trim();

/** Which header feeds each field: explicit overrides first, then known header names. */
export function detectColumns(
  headers: string[],
  overrides: Partial<Record<SheetField, string>> = {},
): { index: Record<SheetField, number>; warnings: string[] } {
  const warnings: string[] = [];
  const index = Object.fromEntries(SHEET_FIELDS.map((f) => [f, -1])) as Record<SheetField, number>;
  const taken = new Set<number>();
  const normalized = headers.map(norm);
  for (const f of SHEET_FIELDS) {
    const want = overrides[f]?.trim();
    if (!want) continue;
    const i = normalized.indexOf(norm(want));
    if (i < 0) warnings.push(`Column “${want}” (for ${f}) isn’t in the sheet`);
    else {
      index[f] = i;
      taken.add(i);
    }
  }
  for (const f of SHEET_FIELDS) {
    if (index[f] >= 0) continue;
    const i = normalized.findIndex((h, j) => !taken.has(j) && ALIASES[f].includes(h));
    if (i >= 0) {
      index[f] = i;
      taken.add(i);
    }
  }
  if (index.title < 0) {
    // Partial matches ("Task title", "Feature name"…) before falling back to the first free column.
    const i = normalized.findIndex(
      (h, j) => !taken.has(j) && /\b(title|task|summary|name|feature)\b/.test(h),
    );
    const fallback = i >= 0 ? i : headers.findIndex((_, j) => !taken.has(j));
    if (fallback >= 0) {
      index.title = fallback;
      taken.add(fallback);
      if (i < 0)
        warnings.push(
          `No “Title” column found — using “${headers[fallback]}”. Name a column Title (or choose one) to be sure.`,
        );
    }
  }
  return { index, warnings };
}

// ─── Values ──────────────────────────────────────────────────────────────────

const PRIORITY_WORDS: [RegExp, Priority, number][] = [
  [/^(critical|crit|urgent|blocker|highest|asap|must|must have|top|immediate)$/, 'critical', 0],
  [/^(high|hi|important|major|should|should have)$/, 'high', 1],
  [/^(medium|med|normal|moderate|mid|average|default)$/, 'medium', 2],
  [/^(low|lo|minor|trivial|lowest|could|could have|nice to have|wont|later|someday)$/, 'low', 3],
];

/**
 * Sheet priority → AgentForge priority plus a rank (lower runs sooner).
 * Accepts words (High, Urgent…), P0–P9, and numbers where 1 is the most important.
 */
export function parsePriority(raw: string): { priority: Priority; rank: number } {
  const v = raw.trim().toLowerCase();
  if (!v) return { priority: 'medium', rank: 2 };
  const p = /^p\s*([0-9])$/.exec(v);
  if (p) {
    const n = Number(p[1]);
    const priority: Priority = n === 0 ? 'critical' : n === 1 ? 'high' : n === 2 ? 'medium' : 'low';
    return { priority, rank: n };
  }
  const num = Number(v);
  if (Number.isFinite(num)) {
    const n = Math.max(0, num);
    const priority: Priority = n <= 1 ? 'critical' : n <= 2 ? 'high' : n <= 3 ? 'medium' : 'low';
    return { priority, rank: n };
  }
  const word = v
    .replace(/^[0-9]+\s*[-.:)]\s*/, '')
    .replace(/[^a-z ]/g, '')
    .trim();
  for (const [re, priority, rank] of PRIORITY_WORDS) if (re.test(word)) return { priority, rank };
  return { priority: 'medium', rank: 2 };
}

export function parseComplexity(raw: string): Complexity {
  const v = raw.trim().toLowerCase();
  if ((COMPLEXITIES as readonly string[]).includes(v)) return v as Complexity;
  if (/^(tiny|trivial|xxs)$/.test(v)) return 'xs';
  if (/^(small|easy|sm)$/.test(v)) return 's';
  if (/^(medium|med|moderate|normal)$/.test(v)) return 'm';
  if (/^(large|big|hard|lg)$/.test(v)) return 'l';
  if (/^(huge|epic|xxl|very large|very hard)$/.test(v)) return 'xl';
  const n = Number(v.replace(/\s*(pts?|points?|sp|h|hrs?|hours?)$/, ''));
  if (v !== '' && Number.isFinite(n))
    return n <= 1 ? 'xs' : n <= 2 ? 's' : n <= 5 ? 'm' : n <= 8 ? 'l' : 'xl';
  return 'm';
}

export function parseType(raw: string, title: string): TaskType {
  const v = raw.trim().toLowerCase();
  if ((TASK_TYPES as readonly string[]).includes(v)) return v as TaskType;
  if (/bug|defect|fix|error/.test(v)) return 'bug';
  if (/doc/.test(v)) return 'docs';
  if (/test|qa/.test(v)) return 'test';
  if (/refactor|tech debt|cleanup/.test(v)) return 'refactor';
  if (/chore|maintenance|infra|ops|setup/.test(v)) return 'chore';
  if (!v && /^(fix|bug)\b/i.test(title)) return 'bug';
  return 'feature';
}

const SKIP_STATUS =
  /^(done|completed?|closed|cancell?ed|skip(ped)?|resolved|finished|shipped|released|won'?t (do|fix)|wontfix|duplicate|archived|yes|true|x|✓|✔|✅|☑)$/;

export const isSkipStatus = (raw: string) => SKIP_STATUS.test(raw.trim().toLowerCase());

const rowId = (title: string) =>
  `row-${createHash('sha1')
    .update(title.trim().toLowerCase().replace(/\s+/g, ' '))
    .digest('hex')
    .slice(0, 8)}`;

/** Change-detection hash of the fields that become the task definition. */
export const rowHash = (r: SheetRowDto) =>
  createHash('sha1')
    .update(
      JSON.stringify([
        r.title,
        r.description,
        r.priority,
        r.complexity,
        r.type,
        r.acceptanceCriteria,
      ]),
    )
    .digest('hex')
    .slice(0, 16);

const LEVEL: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Normalise a raw table into task rows: by priority, then rank, then sheet order; finished rows last. */
export function toRows(
  table: SheetTable,
  overrides: Partial<Record<SheetField, string>> = {},
): SheetPreviewDto {
  const { index, warnings } = detectColumns(table.headers, overrides);
  const columns = Object.fromEntries(
    SHEET_FIELDS.map((f) => [f, index[f] >= 0 ? (table.headers[index[f]] ?? null) : null]),
  ) as Record<SheetField, string | null>;
  const cell = (cells: string[], f: SheetField) => (index[f] >= 0 ? (cells[index[f]] ?? '') : '');
  const seen = new Set<string>();
  const rows: SheetRowDto[] = [];
  table.rows.forEach((cells, i) => {
    const n = table.rowNumbers[i] ?? i + 2;
    const title = cell(cells, 'title').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!title) return;
    const explicitId = cell(cells, 'id').trim().slice(0, 120);
    const id = explicitId || rowId(title);
    if (seen.has(id)) {
      warnings.push(
        explicitId
          ? `Row ${n}: ID “${explicitId}” is used twice — only the first row is imported`
          : `Row ${n}: “${title}” appears twice — only the first row is imported`,
      );
      return;
    }
    seen.add(id);
    const priorityRaw = cell(cells, 'priority').trim() || null;
    const { priority, rank } = parsePriority(priorityRaw ?? '');
    const status = cell(cells, 'status').trim() || null;
    rows.push({
      id,
      row: n,
      title,
      description: cell(cells, 'description').trim().slice(0, 20_000),
      priority,
      priorityRaw,
      rank,
      complexity: parseComplexity(cell(cells, 'complexity')),
      type: parseType(cell(cells, 'type'), title),
      acceptanceCriteria: cell(cells, 'acceptance')
        .split(/\r?\n|;|•/)
        .map((s) => s.replace(/^\s*[-*\d.)]+\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 20),
      status,
      skip: !!status && isSkipStatus(status),
    });
  });
  rows.sort(
    (a, b) =>
      Number(a.skip) - Number(b.skip) ||
      LEVEL[a.priority] - LEVEL[b.priority] ||
      a.rank - b.rank ||
      a.row - b.row,
  );
  if (table.headers.length && index.priority < 0)
    warnings.push('No “Priority” column found — every row is treated as medium priority.');
  return {
    headers: table.headers,
    columns,
    sheets: table.sheets,
    rows,
    total: rows.length,
    warnings,
  };
}
