'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUp,
  Check,
  Eye,
  EyeOff,
  Folder,
  FolderGit2,
  FolderPlus,
  Home,
  Loader2,
} from 'lucide-react';
import { useLayoutEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiClientError, qk } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  initialPath?: string;
  onSelect: (path: string) => void;
}

/** Daemon-backed folder browser (the browser can't read local paths itself). */
export function DirectoryPicker({
  open,
  onOpenChange,
  title,
  description,
  initialPath,
  onSelect,
}: Props) {
  const queryClient = useQueryClient();
  const [path, setPath] = useState<string | undefined>(initialPath);
  const [hidden, setHidden] = useState(false);
  const [newName, setNewName] = useState<string | null>(null);
  const browse = useQuery({
    queryKey: qk.fsBrowse(path, hidden),
    queryFn: () => api.fs.browse(path, hidden),
    enabled: open,
    retry: false,
  });
  const data = browse.data;
  const mkdir = useMutation({
    mutationFn: (name: string) => api.fs.mkdir(data!.path, name),
    onSuccess: (res) => {
      setNewName(null);
      void queryClient.invalidateQueries({ queryKey: ['fs', 'browse'] });
      setPath(res.path);
    },
    onError: (err) =>
      toast.error(err instanceof ApiClientError ? err.message : 'Could not create folder'),
  });

  // Breadcrumbs for both POSIX (/home/you) and Windows (C:\Users\you) paths.
  const rawPath = data?.path ?? '';
  const win = /^[A-Za-z]:[\\/]/.test(rawPath);
  const sep = win ? '\\' : '/';
  const segments = rawPath ? rawPath.split(/[\\/]/).filter(Boolean) : [];
  const crumbTarget = (i: number) => {
    const parts = segments.slice(0, i + 1);
    return win ? (i === 0 ? parts[0] + sep : parts.join(sep)) : `/${parts.join('/')}`;
  };
  // Callback ref in state: the dialog content mounts through a portal after the
  // first render, so a plain ref would still be null when the path loads.
  const [crumbsEl, setCrumbsEl] = useState<HTMLElement | null>(null);
  // Keep the deepest segment (the current folder) in view.
  useLayoutEffect(() => {
    if (!crumbsEl) return;
    const id = requestAnimationFrame(() => (crumbsEl.scrollLeft = crumbsEl.scrollWidth));
    return () => cancelAnimationFrame(id);
  }, [crumbsEl, data?.path]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 sm:max-w-2xl [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Home folder"
            onClick={() => setPath(data?.home)}
          >
            <Home />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Parent folder"
            disabled={!data?.parent}
            onClick={() => setPath(data?.parent ?? undefined)}
          >
            <ArrowUp />
          </Button>
          <nav
            aria-label="Current folder"
            ref={setCrumbsEl}
            className="bg-muted/60 flex min-w-0 flex-1 items-center overflow-x-auto rounded-md px-2 py-1.5 font-mono text-xs whitespace-nowrap"
          >
            {!win && (
              <button className="hover:text-primary shrink-0" onClick={() => setPath('/')}>
                /
              </button>
            )}
            {segments.map((seg, i) => (
              <span key={i} className="flex shrink-0 items-center">
                {i > 0 && <span className="text-muted-foreground px-0.5">{sep}</span>}
                <button className="hover:text-primary" onClick={() => setPath(crumbTarget(i))}>
                  {seg}
                </button>
              </span>
            ))}
          </nav>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={hidden ? 'Hide hidden folders' : 'Show hidden folders'}
            onClick={() => setHidden((h) => !h)}
          >
            {hidden ? <EyeOff /> : <Eye />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="New folder"
            disabled={!data?.writable}
            onClick={() => setNewName('')}
          >
            <FolderPlus />
          </Button>
        </div>

        {newName !== null && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim()) mkdir.mutate(newName.trim());
            }}
          >
            <Input
              autoFocus
              placeholder="New folder name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="h-8"
              aria-label="New folder name"
            />
            <Button size="sm" type="submit" disabled={!newName.trim() || mkdir.isPending}>
              {mkdir.isPending ? <Loader2 className="animate-spin" /> : 'Create'}
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setNewName(null)}>
              Cancel
            </Button>
          </form>
        )}

        <ScrollArea className="h-80 rounded-lg border">
          {browse.isPending ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-7" />
              ))}
            </div>
          ) : browse.isError ? (
            <div className="text-destructive p-4 text-sm">
              {browse.error instanceof ApiClientError
                ? browse.error.message
                : 'Could not open folder'}
              <Button variant="link" size="sm" onClick={() => setPath(undefined)}>
                Go home
              </Button>
            </div>
          ) : data && data.entries.length === 0 ? (
            <p className="text-muted-foreground p-4 text-sm">
              No sub-folders
              {data.fileCount
                ? ` · ${data.fileCount} file${data.fileCount === 1 ? '' : 's'}`
                : ' · empty'}
            </p>
          ) : (
            <ul className="p-1" role="listbox" aria-label="Folders">
              {data?.entries.map((e) => (
                <li key={e.path}>
                  <button
                    role="option"
                    aria-selected={false}
                    onClick={() => setPath(e.path)}
                    className={cn(
                      'hover:bg-accent flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm',
                      e.hidden && 'text-muted-foreground',
                    )}
                  >
                    {e.isGitRepo ? (
                      <FolderGit2 className="text-primary size-4 shrink-0" />
                    ) : (
                      <Folder className="text-muted-foreground size-4 shrink-0" />
                    )}
                    <span className="truncate">{e.name}</span>
                    {e.isGitRepo && (
                      <span className="text-muted-foreground ml-auto text-[10px] uppercase">
                        git
                      </span>
                    )}
                  </button>
                </li>
              ))}
              {data?.truncated && (
                <li className="text-muted-foreground px-2.5 py-1.5 text-xs">
                  Showing the first 1000 folders
                </li>
              )}
            </ul>
          )}
        </ScrollArea>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <p
            className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs"
            title={data?.path}
          >
            {data?.path}
            {data && !data.writable && (
              <span className="text-destructive ml-2 font-sans">read-only</span>
            )}
          </p>
          <Button
            disabled={!data}
            onClick={() => {
              onSelect(data!.path);
              onOpenChange(false);
            }}
          >
            <Check /> Select this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
