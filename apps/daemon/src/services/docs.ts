import type { DocDto, DocKind, DocSummaryDto } from '@ai-harness/shared';
import { and, desc, eq } from 'drizzle-orm';
import { execa } from 'execa';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../db/client';
import { documents, projects, tasks } from '../db/schema';
import { badRequest, notFound } from '../http/errors';
import { isProjectDataPath } from '../lib/project-data-dir';
import type { FileService } from './files';

const FILE_PREFIX = 'file:';
const MAX_FILES = 150;

function kindOf(path: string): DocKind {
  const base = path.split('/').pop()!.toLowerCase();
  if (/^readme(\.|$)/.test(base)) return 'readme';
  if (/^(changelog|changes|history)(\.|$)/.test(base)) return 'changelog';
  if (/architecture|adr|design/.test(path.toLowerCase())) return 'architecture';
  return 'other';
}
const ORDER: Record<DocKind, number> = {
  readme: 0,
  changelog: 1,
  architecture: 2,
  other: 3,
  task_report: 4,
};

/** The Docs tab: task reports (stored) and the project's Markdown docs (read live from the folder). */
export class DocsService {
  constructor(
    private readonly db: Db,
    private readonly files: FileService,
  ) {}

  async list(projectId: string): Promise<DocSummaryDto[]> {
    const root = this.root(projectId);
    const reports = this.db
      .select({ d: documents, key: tasks.key })
      .from(documents)
      .leftJoin(tasks, eq(tasks.id, documents.taskId))
      .where(and(eq(documents.projectId, projectId), eq(documents.kind, 'task_report')))
      .orderBy(desc(documents.updatedAt))
      .all()
      .map(({ d, key }) => ({
        id: d.id,
        kind: 'task_report' as const,
        title: d.title,
        path: null,
        taskId: d.taskId,
        taskKey: key,
        updatedAt: d.updatedAt,
        size: d.content.length,
      }));
    const r = await execa(
      'git',
      [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        '*.md',
        '*.mdx',
        '*.markdown',
      ],
      {
        cwd: root,
        reject: false,
        timeout: 15_000,
      },
    );
    const paths = String(r.stdout ?? '')
      .split('\n')
      .filter(
        (p) =>
          p &&
          !isProjectDataPath(p) &&
          !/(^|\/)(node_modules|vendor|dist|build)\//.test(p) &&
          p.split('/').length <= 4,
      )
      .slice(0, MAX_FILES);
    const fileDocs: DocSummaryDto[] = [];
    for (const p of paths) {
      const st = await stat(join(root, p)).catch(() => null);
      if (!st?.isFile()) continue;
      fileDocs.push({
        id: `${FILE_PREFIX}${p}`,
        kind: kindOf(p),
        title: p,
        path: p,
        taskId: null,
        taskKey: null,
        updatedAt: st.mtimeMs,
        size: st.size,
      });
    }
    fileDocs.sort(
      (a, b) =>
        ORDER[a.kind] - ORDER[b.kind] ||
        a.path!.split('/').length - b.path!.split('/').length ||
        a.path!.localeCompare(b.path!),
    );
    return [...fileDocs, ...reports];
  }

  async get(projectId: string, id: string): Promise<DocDto> {
    if (id.startsWith(FILE_PREFIX)) {
      const path = id.slice(FILE_PREFIX.length);
      if (!/\.(md|mdx|markdown)$/i.test(path))
        throw badRequest('Only Markdown files are shown in Docs');
      const f = await this.files.read(projectId, path);
      return {
        id,
        kind: kindOf(f.path),
        title: f.path,
        path: f.path,
        taskId: null,
        taskKey: null,
        updatedAt: Date.now(),
        size: f.size,
        content: f.content,
      };
    }
    const row = this.db
      .select({ d: documents, key: tasks.key })
      .from(documents)
      .leftJoin(tasks, eq(tasks.id, documents.taskId))
      .where(and(eq(documents.id, id), eq(documents.projectId, projectId)))
      .get();
    if (!row) throw notFound('Document');
    return {
      id: row.d.id,
      kind: row.d.kind,
      title: row.d.title,
      path: row.d.path,
      taskId: row.d.taskId,
      taskKey: row.key,
      updatedAt: row.d.updatedAt,
      size: row.d.content.length,
      content: row.d.content,
    };
  }

  /** Every doc in one Markdown file: project docs first, then task reports (oldest first). */
  async exportAll(projectId: string): Promise<{ filename: string; content: string }> {
    const p = this.db.select().from(projects).where(eq(projects.id, projectId)).get()!;
    const list = await this.list(projectId);
    const files = list.filter((d) => d.kind !== 'task_report');
    const reports = list.filter((d) => d.kind === 'task_report').reverse();
    const parts: string[] = [
      `# ${p.name} — documentation`,
      `_Exported from AI Harness on ${new Date().toISOString().slice(0, 10)}._`,
      `## Contents\n\n${[...files.map((d) => `- ${d.path}`), ...reports.map((d) => `- ${d.title}`)].join('\n')}`,
    ];
    for (const d of [...files, ...reports]) {
      const doc = await this.get(projectId, d.id).catch(() => null);
      if (!doc) continue;
      // Shift headings down one level so each document nests under its own title.
      const body = doc.content.replace(/^(#{1,5}) /gm, '#$1 ');
      parts.push(`---\n\n## ${d.kind === 'task_report' ? d.title : d.path}\n\n${body.trim()}`);
    }
    return { filename: `${p.slug}-docs.md`, content: `${parts.join('\n\n')}\n` };
  }

  private root(projectId: string): string {
    const p = this.db
      .select({ path: projects.localPath })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    if (!p) throw notFound('Project');
    return p.path;
  }
}
