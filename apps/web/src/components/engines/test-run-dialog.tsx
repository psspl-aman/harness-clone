'use client';

import type { AgentEvent, EngineInfo } from '@ai-harness/shared';
import { CheckCircle2, CircleStop, Loader2, Play, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ApiClientError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useEngineTest } from './use-engine-test';

function describe(e: AgentEvent): { text: string; tone?: string } | null {
  switch (e.kind) {
    case 'session':
      return {
        text: `session ${e.sessionId.slice(0, 8)}…${e.model ? ` · ${e.model}` : ''}`,
        tone: 'text-muted-foreground',
      };
    case 'text':
      return { text: e.text };
    case 'thinking':
      return { text: `💭 ${e.text}`, tone: 'text-muted-foreground italic' };
    case 'tool_call':
      return { text: `→ ${e.name}`, tone: 'text-primary' };
    case 'tool_result':
      return {
        text: e.ok ? '  ✓ done' : `  ✗ ${e.output ?? 'failed'}`,
        tone: e.ok ? 'text-success' : 'text-destructive',
      };
    case 'usage':
      return {
        text: `tokens: ${e.usage.inputTokens.toLocaleString()} in · ${e.usage.outputTokens.toLocaleString()} out · ${e.usage.cacheReadTokens.toLocaleString()} cached${e.usage.costUsd ? ` · $${e.usage.costUsd.toFixed(4)}` : ''}`,
        tone: 'text-muted-foreground',
      };
    case 'rate_limit':
      return {
        text: `usage window: ${e.windows.map((w) => `${w.name} ${w.utilization !== null ? Math.round(w.utilization * 100) + '%' : '?'}`).join(', ')}`,
        tone: 'text-muted-foreground',
      };
    case 'error':
      return { text: e.message, tone: 'text-destructive' };
    case 'log':
      return e.stream === 'stderr' ? { text: e.line, tone: 'text-warning' } : null;
  }
}

/** Sends a tiny read-only prompt and streams the normalised events back. */
export function TestRunDialog({
  engine,
  open,
  onOpenChange,
}: {
  engine: EngineInfo;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [prompt, setPrompt] = useState('Reply with exactly: OK');
  const test = useEngineTest(engine.id);
  const { runId, events, result, start } = test;
  const running = !!runId && !result;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>Test {engine.displayName}</DialogTitle>
          <DialogDescription>
            Runs one read-only prompt in a scratch folder. This uses a small amount of your usage.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!running) start.mutate({ prompt, model: engine.defaultModel ?? undefined });
          }}
        >
          <Input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            aria-label="Test prompt"
          />
          {running ? (
            <Button type="button" variant="outline" onClick={test.cancel}>
              <CircleStop /> Stop
            </Button>
          ) : (
            <Button type="submit" disabled={!prompt.trim() || start.isPending}>
              <Play /> Run
            </Button>
          )}
        </form>
        <ScrollArea className="bg-muted/40 h-72 rounded-lg border">
          <div className="space-y-1 p-3 font-mono text-xs" aria-live="polite">
            {start.isError && (
              <p className="text-destructive">
                {start.error instanceof ApiClientError ? start.error.message : 'Could not start'}
              </p>
            )}
            {!runId && !start.isError && (
              <p className="text-muted-foreground">Output streams here.</p>
            )}
            {running && events.length === 0 && (
              <p className="text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="size-3 animate-spin" /> Waiting for {engine.displayName}…
              </p>
            )}
            {events.map((e, i) => {
              const d = describe(e);
              return d ? (
                <p key={i} className={cn('break-words whitespace-pre-wrap', d.tone)}>
                  {d.text}
                </p>
              ) : null;
            })}
          </div>
        </ScrollArea>
        {result && (
          <div
            role="status"
            className={cn(
              'flex items-start gap-2 rounded-lg border p-3 text-sm',
              result.status === 'succeeded'
                ? 'border-success/30 bg-success/10'
                : 'border-destructive/30 bg-destructive/10',
            )}
          >
            {result.status === 'succeeded' ? (
              <CheckCircle2 className="text-success mt-0.5 size-4" />
            ) : (
              <XCircle className="text-destructive mt-0.5 size-4" />
            )}
            <div className="min-w-0">
              <p className="font-medium">
                {result.status === 'succeeded'
                  ? `Works — answered “${result.finalText.trim().slice(0, 80)}”`
                  : result.status === 'cancelled'
                    ? 'Cancelled'
                    : `Failed (${result.error?.kind ?? 'error'})`}
                <span className="text-muted-foreground font-normal">
                  {' '}
                  · {(result.durationMs / 1000).toFixed(1)}s
                </span>
              </p>
              {result.error && (
                <p className="text-muted-foreground mt-0.5 text-xs break-words whitespace-pre-wrap">
                  {result.error.message}
                </p>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
