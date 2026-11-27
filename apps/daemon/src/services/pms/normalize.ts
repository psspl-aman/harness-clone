import type { McpToolDto, PmsField, PmsIssue, PmsOperation, PmsToolMap } from '@ai-harness/shared';

// ─── Argument templates ──────────────────────────────────────────────────────

export type TemplateVars = Record<string, unknown>;

/** Template variables for a mapping (plus per-call extras such as issueId/status/body). */
export function baseVars(
  project: string,
  filters: Record<string, unknown>,
  extra: TemplateVars = {},
): TemplateVars {
  const [owner, repo] = project.includes('/') ? project.split('/', 2) : [project, project];
  return { project, owner, repo, limit: 50, filters, ...extra };
}

const lookup = (vars: TemplateVars, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
      vars,
    );

const EXACT = /^\{\{\s*([\w.]+)\s*(?:\|\s*(number|string|json))?\s*\}\}$/;
const INLINE = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Render an args template: `"{{x}}"` → raw value (`|number` converts),
 * `"a {{x}} b"` → string interpolation. Keys whose value renders to
 * undefined/empty are dropped so optional filters disappear.
 */
export function renderArgs(template: unknown, vars: TemplateVars): unknown {
  if (typeof template === 'string') {
    const m = template.match(EXACT);
    if (m) {
      const v = lookup(vars, m[1]!);
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length))
        return undefined;
      if (m[2] === 'number') {
        const n = Number(v);
        return Number.isFinite(n) ? n : v;
      }
      if (m[2] === 'string') return Array.isArray(v) ? v.join(',') : String(v);
      return v;
    }
    let missing = false;
    const out = template.replace(INLINE, (_, k: string) => {
      const v = lookup(vars, k);
      if (v === undefined || v === null || v === '') missing = true;
      return Array.isArray(v) ? v.join(',') : String(v ?? '');
    });
    return missing && out.trim() === '' ? undefined : out;
  }
  if (Array.isArray(template))
    return template.map((t) => renderArgs(t, vars)).filter((x) => x !== undefined);
  if (template && typeof template === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, t] of Object.entries(template)) {
      const v = renderArgs(t, vars);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return template;
}

/**
 * Fill the given placeholders in a template now (e.g. a site id found at setup
 * time) and leave every other `{{var}}` for render time.
 */
export function bindConstants<T>(template: T, constants: Record<string, string>): T {
  const bind = (t: unknown): unknown => {
    if (typeof t === 'string')
      return t.replace(INLINE, (whole, k: string) => constants[k] ?? whole);
    if (Array.isArray(t)) return t.map(bind);
    if (t && typeof t === 'object')
      return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, bind(v)]));
    return t;
  };
  return bind(template) as T;
}

// ─── Result normalisation ────────────────────────────────────────────────────

const get = (o: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined),
      o,
    );

const ITEM_KEYS = [
  'issues',
  'items',
  'nodes',
  'results',
  'data',
  'tasks',
  'cards',
  'value',
  'workItems',
  'tickets',
  'records',
  'edges',
];

/** Find the array of issues in a tool result (explicit path, common wrapper keys, or the first array of objects). */
export function extractItems(json: unknown, itemsPath?: string): Record<string, unknown>[] {
  const isObjArray = (x: unknown): x is Record<string, unknown>[] =>
    Array.isArray(x) && x.every((i) => i && typeof i === 'object' && !Array.isArray(i));
  if (itemsPath) {
    const v = get(json, itemsPath);
    if (!isObjArray(v))
      throw new Error(`"${itemsPath}" in the tool result is not a list of objects`);
    return unwrapEdges(v);
  }
  if (isObjArray(json)) return unwrapEdges(json);
  const queue: unknown[] = [json];
  for (let depth = 0; depth < 3 && queue.length; depth++) {
    const next: unknown[] = [];
    for (const node of queue) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
      const rec = node as Record<string, unknown>;
      for (const k of ITEM_KEYS) if (isObjArray(rec[k])) return unwrapEdges(rec[k]);
      for (const v of Object.values(rec)) {
        if (isObjArray(v) && v.length) return unwrapEdges(v);
        if (v && typeof v === 'object') next.push(v);
      }
    }
    queue.splice(0, queue.length, ...next);
  }
  if (json && typeof json === 'object' && !Array.isArray(json)) return [];
  throw new Error('The tool did not return JSON with a list of issues');
}

/** GraphQL-style `edges: [{ node }]`. */
const unwrapEdges = (items: Record<string, unknown>[]) =>
  items.map((i) =>
    i.node && typeof i.node === 'object' && Object.keys(i).length <= 2
      ? (i.node as Record<string, unknown>)
      : i,
  );

const CANDIDATES: Record<PmsField, string[]> = {
  id: ['identifier', 'key', 'number', 'iid', 'id', 'gid', 'idShort'],
  title: ['title', 'summary', 'name', 'fields.summary', 'fields.System.Title', 'subject'],
  description: [
    'description',
    'body',
    'fields.description',
    'fields.System.Description',
    'notes',
    'desc',
    'text_content',
    'content',
  ],
  status: [
    'status.name',
    'state.name',
    'fields.status.name',
    'fields.System.State',
    'status.status',
    'status',
    'state',
    'list.name',
  ],
  url: [
    'url',
    'html_url',
    'web_url',
    'webUrl',
    'permalink_url',
    'browse_url',
    'permalink',
    'shortUrl',
    '_links.html.href',
    'link',
  ],
  updatedAt: [
    'updatedAt',
    'updated_at',
    'fields.updated',
    'modified_at',
    'date_updated',
    'dateLastActivity',
    'fields.System.ChangedDate',
    'updated',
  ],
  labels: ['labels.nodes', 'labels', 'fields.labels', 'tags', 'fields.System.Tags'],
  assignee: [
    'assignee.name',
    'assignee.displayName',
    'assignee.display_name',
    'assignee.login',
    'fields.assignee.displayName',
    'assignee',
    'assignees.0.login',
    'assignees.0.name',
  ],
};

const asText = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['name', 'displayName', 'login', 'title', 'value', 'text'])
      if (typeof o[k] === 'string') return o[k] as string;
    // Atlassian document format and similar rich text: collect the text nodes.
    const texts: string[] = [];
    const walk = (n: unknown) => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === 'object') {
        const r = n as Record<string, unknown>;
        if (typeof r.text === 'string') texts.push(r.text);
        if (r.content) walk(r.content);
      }
    };
    walk(v);
    if (texts.length) return texts.join(' ');
  }
  return null;
};

const asTime = (v: unknown): number | null => {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
};

function pick(item: Record<string, unknown>, field: PmsField, override?: string): unknown {
  for (const p of override ? [override] : CANDIDATES[field]) {
    const v = get(item, p);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

export function normalizeIssue(
  item: Record<string, unknown>,
  fields: PmsToolMap['fields'] = {},
): PmsIssue | null {
  const id = asText(pick(item, 'id', fields.id));
  const title = asText(pick(item, 'title', fields.title));
  if (!id || !title) return null;
  const labelsRaw = pick(item, 'labels', fields.labels);
  const labels = Array.isArray(labelsRaw)
    ? labelsRaw.map(asText).filter((x): x is string => !!x)
    : typeof labelsRaw === 'string'
      ? labelsRaw
          .split(/[;,]/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  return {
    id,
    title: title.slice(0, 500),
    description: (asText(pick(item, 'description', fields.description)) ?? '').slice(0, 20_000),
    status: asText(pick(item, 'status', fields.status)),
    url: asText(pick(item, 'url', fields.url)),
    updatedAt: asTime(pick(item, 'updatedAt', fields.updatedAt)),
    labels,
    assignee: asText(pick(item, 'assignee', fields.assignee)),
  };
}

/**
 * The id of the transition that moves an issue into `status`, matched on the
 * target status first (Jira `to.name`, mcp-atlassian `to_status`) and then on
 * the transition's own name. null when the workflow offers none.
 */
export function findTransition(items: Record<string, unknown>[], status: string): string | null {
  const want = status.trim().toLowerCase();
  const idOf = (i: Record<string, unknown>) => asText(i.id);
  const target = (i: Record<string, unknown>) =>
    asText(get(i, 'to.name') ?? i.to_status ?? i.toStatus ?? i.to);
  const byTarget = items.find((i) => target(i)?.toLowerCase() === want && idOf(i));
  const byName = items.find((i) => asText(i.name)?.toLowerCase() === want && idOf(i));
  const hit = byTarget ?? byName;
  return hit ? idOf(hit) : null;
}

/** Human-readable names of the transitions on offer, for error messages. */
export const transitionNames = (items: Record<string, unknown>[]): string[] =>
  items
    .map((i) => asText(get(i, 'to.name') ?? i.to_status ?? i.name))
    .filter((x): x is string => !!x);

/**
 * The Jira site (cloud id) from Atlassian's accessible-resources listing:
 * the first site whose scopes mention Jira, else the first site.
 */
export function pickAtlassianSite(json: unknown): string | null {
  let sites: Record<string, unknown>[];
  try {
    sites = extractItems(json);
  } catch {
    return null;
  }
  const scopes = (s: Record<string, unknown>) =>
    Array.isArray(s.scopes) ? s.scopes.map(String).join(' ') : '';
  const site = sites.find((s) => /jira/i.test(scopes(s))) ?? sites[0];
  return (site && (asText(site.id) ?? asText(site.url))) || null;
}

/** Client-side filters, applied when the tool doesn't filter by itself. */
export function matchesFilters(
  i: PmsIssue,
  f: { assignee?: string; labels?: string[]; status?: string[] },
): boolean {
  const eq = (a: string | null, b: string) => (a ?? '').toLowerCase() === b.toLowerCase();
  if (f.assignee && i.assignee && !eq(i.assignee, f.assignee)) return false;
  if (f.status?.length && i.status && !f.status.some((s) => eq(i.status, s))) return false;
  if (f.labels?.length && !f.labels.every((l) => i.labels.some((x) => eq(x, l)))) return false;
  return true;
}

// ─── Tool-map detection ──────────────────────────────────────────────────────

const OP_PATTERNS: Record<'list' | 'get' | 'updateStatus' | 'transitions' | 'comment', RegExp[]> = {
  // Before updateStatus, whose /transition/ pattern would otherwise claim it.
  transitions: [/(get|list)_?(issue_?)?transitions/i],
  list: [
    /^(jira_)?search(_issues)?$/i,
    /(list|search|find|query|get)_?(all_)?(issues|tasks|tickets|cards|work_?items|stories)/i,
    /list.*(issue|task|ticket|card|item)/i,
  ],
  get: [
    /^(get|read|fetch|view)_?(issue|task|ticket|card|work_?item|story)$/i,
    /(get|read|fetch).*(issue|task|ticket|card|work_?item)(?!s)/i,
  ],
  updateStatus: [
    /(transition|move)_?(issue|task|ticket|card)?/i,
    /(update|edit|set)_?(issue|task|ticket|card|work_?item)(_status|_state)?$/i,
    /(status|state)/i,
  ],
  comment: [/(add|create|post)_?(issue_|task_|ticket_|card_)?comment/i, /comment/i],
};

const props = (t: McpToolDto) =>
  Object.keys((t.inputSchema?.properties as Record<string, unknown>) ?? {});

const pickProp = (names: string[], patterns: RegExp[]) => {
  for (const re of patterns) {
    const hit = names.find((n) => re.test(n));
    if (hit) return hit;
  }
  return null;
};

function argsFor(op: keyof typeof OP_PATTERNS, tool: McpToolDto): Record<string, unknown> {
  const names = props(tool);
  const args: Record<string, unknown> = {};
  if (names.includes('owner') && names.includes('repo')) {
    args.owner = '{{owner}}';
    args.repo = '{{repo}}';
  } else {
    const project = pickProp(names, [
      /^project(_?key|_?id)?$/i,
      /^(team|board|list|workspace)(_?id|_?key)?$/i,
      /^repo/i,
    ]);
    if (project && op === 'list') args[project] = '{{project}}';
  }
  if (op === 'list') {
    const jql = pickProp(names, [/^jql$/i]);
    if (jql) args[jql] = 'project = {{project}} AND statusCategory != Done ORDER BY updated DESC';
    const limit = pickProp(names, [/^(limit|max_?results|per_?page|first|page_?size)$/i]);
    if (limit) args[limit] = '{{limit|number}}';
    const assignee = pickProp(names, [/^assignee/i]);
    if (assignee) args[assignee] = '{{filters.assignee}}';
    const labels = pickProp(names, [/^labels?$/i]);
    if (labels) args[labels] = '{{filters.labels}}';
  } else {
    const id = pickProp(names, [
      /^issue_?number$/i,
      /^(issue|task|ticket|card|work_?item)_?(id|key|number)$/i,
      /^(id|key|identifier)$/i,
    ]);
    if (id) args[id] = /number/i.test(id) ? '{{issueId|number}}' : '{{issueId}}';
    if (op === 'updateStatus') {
      const st = pickProp(names, [
        /^(status|state)(_?name)?$/i,
        /^transition(_?name|_?id)?$/i,
        /^(state|status)_?id$/i,
      ]);
      if (st) args[st] = '{{status}}';
    }
    if (op === 'comment') {
      const body = pickProp(names, [/^(body|comment|text|content|message)$/i]);
      if (body) args[body] = '{{body}}';
    }
  }
  return args;
}

/** Best-effort tool map from a server's tool list, for the user to review. */
export function detectToolMap(tools: McpToolDto[]): PmsToolMap {
  const used = new Set<string>();
  const find = (op: keyof typeof OP_PATTERNS): PmsOperation | undefined => {
    for (const re of OP_PATTERNS[op]) {
      const t = tools.find((x) => !used.has(x.name) && re.test(x.name));
      if (t) {
        used.add(t.name);
        return { tool: t.name, args: argsFor(op, t) };
      }
    }
    return undefined;
  };
  const list = find('list');
  const comment = find('comment');
  const transitions = find('transitions');
  const updateStatus = find('updateStatus');
  const get = find('get');
  return { list, get, updateStatus, transitions, comment, fields: {} };
}
