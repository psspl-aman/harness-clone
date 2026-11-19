'use client';

import { useQuery } from '@tanstack/react-query';
import {
  ChevronRight,
  File,
  FileWarning,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, ApiClientError, qk } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Monaco loaded from this app's own /monaco copy (no CDN), client-side only. */
const Editor = dynamic(
  async () => {
    const m = await import('@monaco-editor/react');
    m.loader.config({ paths: { vs: '/monaco/vs' } });
    return m.Editor;
  },
  {
    ssr: false,
    loading: () => (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" /> Loading editor…
      </div>
    ),
  },
);

interface Node {
  name: string;
  path: string;
  children?: Map<string, Node>;
}

function buildTree(files: string[]): Node {
  const root: Node = { name: '', path: '', children: new Map() };
  for (const f of files) {
    const parts = f.split('/');
    let cur = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/');
      const leaf = i === parts.length - 1;
      let next = cur.children!.get(part);
      if (!next) {
        next = { name: part, path, ...(leaf ? {} : { children: new Map() }) };
        cur.children!.set(part, next);
      }
      cur = next;
    });
  }
  return root;
}

const sorted = (n: Node) =>
  [...n.children!.values()].sort(
    (a, b) => Number(!!b.children) - Number(!!a.children) || a.name.localeCompare(b.name),
  );

function TreeNode({
  node,
  depth,
  open,
  toggle,
  selected,
  onSelect,
}: {
  node: Node;
  depth: number;
  open: Set<string>;
  toggle: (p: string) => void;
  selected: string | null;
  onSelect: (p: string) => void;
}) {
  const isDir = !!node.children;
  const expanded = open.has(node.path);
  return (
    <>
      <button
        className={cn(
          'hover:bg-accent/60 flex w-full items-center gap-1 truncate rounded px-1.5 py-[3px] text-left text-[13px]',
          selected === node.path && 'bg-accent text-accent-foreground',
        )}
        style={{ paddingLeft: depth * 12 + 6 }}
        onClick={() => (isDir ? toggle(node.path) : onSelect(node.path))}
        title={node.path}
        role="treeitem"
        aria-expanded={isDir ? expanded : undefined}
        aria-selected={selected === node.path}
      >
        {isDir ? (
          <>
            <ChevronRight
              className={cn('size-3 shrink-0 transition-transform', expanded && 'rotate-90')}
            />
            {expanded ? (
              <FolderOpen className="text-primary size-3.5 shrink-0" />
            ) : (
              <Folder className="text-primary size-3.5 shrink-0" />
            )}
          </>
        ) : (
          <File className="text-muted-foreground ml-4 size-3.5 shrink-0" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {isDir &&
        expanded &&
        sorted(node).map((c) => (
          <TreeNode
            key={c.path}
            node={c}
            depth={depth + 1}
            open={open}
            toggle={toggle}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

/** Read-only code browser: git-aware file tree + Monaco. Secret files are never served. */
export function CodeTab({
  projectId,
  path,
  line,
  onSelect,
}: {
  projectId: string;
  path: string | null;
  line?: number | null;
  onSelect: (path: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  const tree = useQuery({
    queryKey: qk.files(projectId),
    queryFn: () => api.runtime.files(projectId),
  });
  const file = useQuery({
    queryKey: qk.file(projectId, path ?? ''),
    queryFn: () => api.runtime.file(projectId, path!),
    enabled: !!path,
    retry: false,
  });
  const [filter, setFilter] = useState('');
  const [manual, setManual] = useState<Set<string>>(new Set());
  const editorRef = useRef<{
    revealLineInCenter(l: number): void;
    setPosition(p: object): void;
  } | null>(null);

  const root = useMemo(() => buildTree(tree.data?.files ?? []), [tree.data]);
  const matches = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q
      ? (tree.data?.files ?? []).filter((f) => f.toLowerCase().includes(q)).slice(0, 200)
      : null;
  }, [filter, tree.data]);

  useEffect(() => {
    if (line && editorRef.current && file.data) {
      editorRef.current.revealLineInCenter(line);
      editorRef.current.setPosition({ lineNumber: line, column: 1 });
    }
  }, [line, file.data]);

  // Folders opened by hand, plus the selected file's ancestors (unless collapsed since it was selected).
  const [collapsed, setCollapsed] = useState<{ for: string | null; dirs: Set<string> }>({
    for: path,
    dirs: new Set(),
  });
  const collapsedDirs = collapsed.for === path ? collapsed.dirs : new Set<string>();
  const ancestors = (path ?? '')
    .split('/')
    .slice(0, -1)
    .map((_, i, a) => a.slice(0, i + 1).join('/'));
  const open = new Set([...manual, ...ancestors.filter((d) => !collapsedDirs.has(d))]);
  const toggle = (p: string) => {
    const isOpen = open.has(p);
    setManual((o) => {
      const n = new Set(o);
      if (isOpen) n.delete(p);
      else n.add(p);
      return n;
    });
    setCollapsed({
      for: path,
      dirs: new Set([...collapsedDirs].filter((d) => d !== p).concat(isOpen ? [p] : [])),
    });
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-64 shrink-0 flex-col border-r">
        <div className="flex items-center gap-1 border-b p-2">
          <div className="relative flex-1">
            <Search className="text-muted-foreground absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find file"
              className="h-7 pl-7 text-xs"
              aria-label="Find file"
            />
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="Refresh files"
            onClick={() => void tree.refetch()}
          >
            <RefreshCw className={cn('size-3.5', tree.isFetching && 'animate-spin')} />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1" role="tree" aria-label="Project files">
          {tree.isPending ? (
            <div className="text-muted-foreground p-3 text-xs">Loading files…</div>
          ) : tree.isError ? (
            <div className="text-destructive p-3 text-xs">Could not list files.</div>
          ) : matches ? (
            matches.length ? (
              matches.map((f) => (
                <button
                  key={f}
                  onClick={() => onSelect(f)}
                  className={cn(
                    'hover:bg-accent/60 block w-full truncate rounded px-2 py-[3px] text-left font-mono text-xs',
                    path === f && 'bg-accent',
                  )}
                  title={f}
                >
                  {f}
                </button>
              ))
            ) : (
              <div className="text-muted-foreground p-3 text-xs">No matching files.</div>
            )
          ) : root.children!.size ? (
            sorted(root).map((n) => (
              <TreeNode
                key={n.path}
                node={n}
                depth={0}
                open={open}
                toggle={toggle}
                selected={path}
                onSelect={onSelect}
              />
            ))
          ) : (
            <div className="text-muted-foreground p-3 text-xs">No files yet.</div>
          )}
          {tree.data?.truncated && (
            <div className="text-muted-foreground p-2 text-[11px]">
              Showing the first 20,000 files.
            </div>
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {!path ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            Select a file to view it.
          </div>
        ) : file.isPending ? (
          <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> Opening {path}…
          </div>
        ) : file.isError || file.data.binary ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm">
            <FileWarning className="size-6" />
            {file.isError
              ? file.error instanceof ApiClientError
                ? file.error.message
                : 'Could not open this file.'
              : 'This is a binary file.'}
          </div>
        ) : (
          <>
            <div className="text-muted-foreground flex items-center gap-2 border-b px-3 py-1.5 font-mono text-xs">
              <span className="truncate" data-testid="code-path">
                {file.data.path}
              </span>
              <span className="ml-auto shrink-0">
                {file.data.language} · {(file.data.size / 1024).toFixed(1)} KB · read-only
              </span>
            </div>
            {file.data.truncated && (
              <div className="bg-muted text-muted-foreground border-b px-3 py-1 text-xs">
                Large file — showing the first 1 MB.
              </div>
            )}
            <div className="min-h-0 flex-1">
              <Editor
                path={file.data.path}
                value={file.data.content}
                language={file.data.language}
                theme={resolvedTheme === 'dark' ? 'vs-dark' : 'light'}
                onMount={(ed) => {
                  editorRef.current = ed;
                  if (line) {
                    ed.revealLineInCenter(line);
                    ed.setPosition({ lineNumber: line, column: 1 });
                  }
                }}
                options={{
                  readOnly: true,
                  domReadOnly: true,
                  minimap: { enabled: false },
                  fontSize: 13,
                  scrollBeyondLastLine: false,
                  renderLineHighlight: 'line',
                  automaticLayout: true,
                }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
