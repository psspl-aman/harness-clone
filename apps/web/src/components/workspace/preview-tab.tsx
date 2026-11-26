'use client';

import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Globe, Play, RotateCw } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, DAEMON_URL, qk } from '@/lib/api';
import { useProjectRun } from './run-controls';

/** Embedded preview of the running app (URL detected from the dev server's output, editable). */
export function PreviewTab({ projectId, onStart }: { projectId: string; onStart: () => void }) {
  const run = useProjectRun(projectId).data;
  const project = useQuery({
    queryKey: qk.project(projectId),
    queryFn: () => api.projects.get(projectId),
  });
  // A static site (root index.html, no run command) is served by the daemon with no dev server.
  const staticUrl = project.data?.hasStaticSite
    ? `${DAEMON_URL}/api/projects/${projectId}/site/`
    : null;
  const detected = run?.previewUrl ?? staticUrl;
  // The typed URL/override resets whenever the dev server reports a new URL.
  const [override, setOverride] = useState<{
    for: string | null;
    url: string;
    shown: string | null;
  }>({
    for: detected,
    url: detected ?? '',
    shown: detected,
  });
  const current =
    override.for === detected ? override : { for: detected, url: detected ?? '', shown: detected };
  const url = current.url;
  const shown = current.shown;
  const setUrl = (u: string) => setOverride({ ...current, url: u });
  const setShown = (u: string) => setOverride({ ...current, shown: u });
  const [nonce, setNonce] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);

  const live = run?.status === 'running' || run?.status === 'starting';
  const servers = (run?.services ?? []).filter(
    (s) => s.url && (s.status === 'running' || s.status === 'starting'),
  );
  if (!shown) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
        <div className="bg-muted rounded-full p-3">
          <Globe className="text-muted-foreground size-6" />
        </div>
        <h2 className="font-semibold">No preview yet</h2>
        <p className="text-muted-foreground max-w-sm text-sm">
          {live
            ? 'The app is running but hasn’t printed a local URL. Enter it below.'
            : 'Run the project — AgentForge picks up the local URL your dev server prints.'}
        </p>
        <div className="flex gap-2">
          {!live && (
            <Button size="sm" onClick={onStart}>
              <Play /> Run project
            </Button>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (/^https?:\/\//.test(url)) setShown(url);
            }}
          >
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:3000"
              className="h-8 w-56 font-mono text-xs"
              aria-label="Preview URL"
            />
            <Button size="sm" variant="outline" type="submit">
              Open
            </Button>
          </form>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <form
        className="flex items-center gap-2 border-b px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (/^https?:\/\//.test(url)) {
            setShown(url);
            setNonce((n) => n + 1);
          }
        }}
      >
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Reload preview"
          onClick={() => setNonce((n) => n + 1)}
        >
          <RotateCw className="size-3.5" />
        </Button>
        {servers.length > 1 && (
          <div className="flex gap-1" role="tablist" aria-label="Server to preview">
            {servers.map((s) => (
              <Button
                key={s.name}
                type="button"
                size="sm"
                role="tab"
                aria-selected={shown === s.url}
                variant={shown === s.url ? 'secondary' : 'ghost'}
                className="h-7 px-2 text-xs"
                onClick={() => setOverride({ for: detected, url: s.url!, shown: s.url })}
              >
                {s.name}
              </Button>
            ))}
          </div>
        )}
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="h-7 flex-1 font-mono text-xs"
          aria-label="Preview URL"
        />
        <Button asChild size="icon" variant="ghost" className="size-7">
          <a href={shown} target="_blank" rel="noreferrer" aria-label="Open in a new tab">
            <ExternalLink className="size-3.5" />
          </a>
        </Button>
      </form>
      {!live && shown !== staticUrl && (
        <div className="bg-muted text-muted-foreground border-b px-3 py-1.5 text-xs">
          The project isn’t running — the preview may be stale or unreachable.
        </div>
      )}
      {shown === staticUrl && (
        <div className="bg-muted text-muted-foreground border-b px-3 py-1.5 text-xs">
          Static site served from the project folder (index.html).
        </div>
      )}
      <iframe
        key={`${shown}#${nonce}`}
        ref={frame}
        src={shown}
        title="App preview"
        className="min-h-0 w-full flex-1 bg-white"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
      />
    </div>
  );
}
