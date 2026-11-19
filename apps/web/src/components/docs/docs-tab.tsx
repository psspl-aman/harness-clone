'use client';

import type { DocSummaryDto } from '@agentforge/shared';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Download, FileText, Loader2, Printer, ScrollText, Search } from 'lucide-react';
import { useState } from 'react';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, ApiClientError, qk } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

const KIND_LABEL: Record<DocSummaryDto['kind'], string> = {
  readme: 'README',
  changelog: 'Changelog',
  architecture: 'Architecture',
  other: 'Doc',
  task_report: 'Report',
};

/** Browse project docs (Markdown in the repo) and task reports; download or print to PDF. */
export function DocsTab({ projectId }: { projectId: string }) {
  const list = useQuery({ queryKey: qk.docs(projectId), queryFn: () => api.docs.list(projectId) });
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const docs = list.data ?? [];
  const current = selected ?? docs[0]?.id ?? null;
  const doc = useQuery({
    queryKey: qk.doc(projectId, current ?? ''),
    queryFn: () => api.docs.get(projectId, current!),
    enabled: !!current,
    retry: false,
  });
  const f = filter.trim().toLowerCase();
  const visible = docs.filter((d) => !f || d.title.toLowerCase().includes(f));
  const files = visible.filter((d) => d.kind !== 'task_report');
  const reports = visible.filter((d) => d.kind === 'task_report');
  const printUrl = (id: string | null) =>
    `/projects/${projectId}/docs/print?${new URLSearchParams(id ? { doc: id } : { all: '1' })}`;

  const Item = ({ d }: { d: DocSummaryDto }) => (
    <button
      onClick={() => setSelected(d.id)}
      className={cn(
        'hover:bg-accent/60 flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left',
        current === d.id && 'bg-accent',
      )}
      aria-current={current === d.id}
    >
      {d.kind === 'task_report' ? (
        <ScrollText className="text-primary mt-0.5 size-3.5 shrink-0" />
      ) : (
        <FileText className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
      )}
      <span className="min-w-0">
        <span
          className={cn(
            'block truncate text-[13px]',
            d.kind !== 'task_report' && 'font-mono text-xs',
          )}
        >
          {d.title}
        </span>
        <span className="text-muted-foreground text-[11px]">
          {KIND_LABEL[d.kind]} · {timeAgo(d.updatedAt)}
        </span>
      </span>
    </button>
  );

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-72 shrink-0 flex-col border-r" aria-label="Documents">
        <div className="flex items-center gap-1 border-b p-2">
          <div className="relative flex-1">
            <Search className="text-muted-foreground absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter docs"
              className="h-7 pl-7 text-xs"
              aria-label="Filter docs"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-2">
          {list.isPending ? (
            <p className="text-muted-foreground p-2 text-xs">Loading…</p>
          ) : (
            <>
              <section>
                <h3 className="text-muted-foreground px-2 pb-1 text-[11px] font-semibold tracking-wide uppercase">
                  Project docs
                </h3>
                {files.length ? (
                  files.map((d) => <Item key={d.id} d={d} />)
                ) : (
                  <p className="text-muted-foreground px-2 text-xs">No Markdown files yet.</p>
                )}
              </section>
              <section>
                <h3 className="text-muted-foreground px-2 pb-1 text-[11px] font-semibold tracking-wide uppercase">
                  Task reports
                </h3>
                {reports.length ? (
                  reports.map((d) => <Item key={d.id} d={d} />)
                ) : (
                  <p className="text-muted-foreground px-2 text-xs">
                    Reports appear as tasks finish.
                  </p>
                )}
              </section>
            </>
          )}
        </div>
        <div className="flex gap-1 border-t p-2">
          <Button asChild size="sm" variant="ghost" className="flex-1 text-xs">
            <a href={api.docs.exportUrl(projectId)} download>
              <Download /> Export all (.md)
            </a>
          </Button>
          <Button asChild size="sm" variant="ghost" className="flex-1 text-xs">
            <a href={printUrl(null)} target="_blank" rel="noreferrer">
              <Printer /> All as PDF
            </a>
          </Button>
        </div>
      </aside>
      <section className="min-w-0 flex-1 overflow-auto">
        {!current ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-10 text-center text-sm">
            <BookOpen className="size-6" />
            No documentation yet. The Documenter writes a report for every finished task and keeps
            README, CHANGELOG and docs up to date.
          </div>
        ) : doc.isPending ? (
          <div className="text-muted-foreground flex items-center gap-2 p-6 text-sm">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : doc.isError ? (
          <div className="text-destructive p-6 text-sm">
            {doc.error instanceof ApiClientError
              ? doc.error.message
              : 'Could not open this document.'}
          </div>
        ) : (
          <>
            <div className="bg-background/95 sticky top-0 z-10 flex items-center gap-2 border-b px-6 py-2 backdrop-blur">
              <span className="text-muted-foreground truncate text-xs" data-testid="doc-title">
                {doc.data.path ?? doc.data.title}
              </span>
              <div className="ml-auto flex gap-1">
                <Button asChild size="sm" variant="outline">
                  <a href={api.docs.downloadUrl(projectId, doc.data.id)} download>
                    <Download /> Markdown
                  </a>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <a href={printUrl(doc.data.id)} target="_blank" rel="noreferrer">
                    <Printer /> PDF
                  </a>
                </Button>
              </div>
            </div>
            <article className="mx-auto max-w-3xl px-6 py-6" data-testid="doc-content">
              <Markdown className="[&_h1]:text-2xl [&_h2]:mt-6 [&_h2]:text-lg [&_h3]:text-base text-[15px]">
                {doc.data.content}
              </Markdown>
            </article>
          </>
        )}
      </section>
    </div>
  );
}
