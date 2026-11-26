'use client';

import type { McpServerDto, McpServerInput, McpTransport } from '@ai-harness/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CircleDashed,
  Loader2,
  Pencil,
  Plug,
  Plus,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiClientError, qk } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { KvEditor, toInput, type KvRow } from './kv-editor';

const errMsg = (e: unknown) => (e instanceof ApiClientError ? e.message : String(e));
const TRANSPORTS: { id: McpTransport; label: string }[] = [
  { id: 'stdio', label: 'Local command (stdio)' },
  { id: 'http', label: 'Remote (Streamable HTTP)' },
  { id: 'sse', label: 'Remote (SSE, legacy)' },
];

export function useMcpServers() {
  return useQuery({ queryKey: qk.mcpServers, queryFn: api.mcp.list });
}

export function McpStatus({ server: s }: { server: McpServerDto }) {
  if (s.lastStatus === 'ok')
    return (
      <span className="text-muted-foreground flex items-center gap-1 text-xs">
        <CheckCircle2 className="text-success size-3.5" /> Connected · {s.tools.length} tool
        {s.tools.length === 1 ? '' : 's'}
      </span>
    );
  if (s.lastStatus === 'error')
    return (
      <span className="text-destructive flex items-center gap-1 text-xs">
        <CircleAlert className="size-3.5" /> Connection failed
      </span>
    );
  return (
    <span className="text-muted-foreground flex items-center gap-1 text-xs">
      <CircleDashed className="size-3.5" /> Not tested
    </span>
  );
}

/** Prefill for a new server (e.g. from a PMS provider preset). */
export interface McpServerDraft {
  name?: string;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: KvRow[];
  headers?: KvRow[];
}

export function McpServerDialog({
  open,
  onOpenChange,
  server,
  draft,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  server?: McpServerDto;
  draft?: McpServerDraft;
  onSaved?: (s: McpServerDto) => void;
}) {
  const qc = useQueryClient();
  const fromDto = (kv: McpServerDto['env']): KvRow[] =>
    kv.map((x) => ({ key: x.key, value: x.value ?? '', secret: x.secret, saved: x.secret }));
  const [name, setName] = useState(server?.name ?? draft?.name ?? '');
  const [transport, setTransport] = useState<McpTransport>(
    server?.transport ?? draft?.transport ?? 'stdio',
  );
  const [command, setCommand] = useState(server?.command ?? draft?.command ?? '');
  const [args, setArgs] = useState((server?.args ?? draft?.args ?? []).join('\n'));
  const [url, setUrl] = useState(server?.url ?? draft?.url ?? '');
  const [env, setEnv] = useState<KvRow[]>(server ? fromDto(server.env) : (draft?.env ?? []));
  const [headers, setHeaders] = useState<KvRow[]>(
    server ? fromDto(server.headers) : (draft?.headers ?? []),
  );
  const [enabled, setEnabled] = useState(server?.enabled ?? true);

  const save = useMutation({
    mutationFn: async () => {
      const input: McpServerInput = {
        name: name.trim(),
        transport,
        command: transport === 'stdio' ? command.trim() : null,
        args:
          transport === 'stdio'
            ? args
                .split('\n')
                .map((a) => a.trim())
                .filter(Boolean)
            : [],
        env: transport === 'stdio' ? toInput(env) : [],
        url: transport === 'stdio' ? null : url.trim(),
        headers: transport === 'stdio' ? [] : toInput(headers),
        enabled,
      };
      const saved = server ? await api.mcp.update(server.id, input) : await api.mcp.create(input);
      return enabled ? api.mcp.test(saved.id) : saved;
    },
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: qk.mcpServers });
      if (s.lastStatus === 'ok')
        toast.success(`${s.name} connected`, { description: `${s.tools.length} tools available.` });
      else if (s.lastStatus === 'error')
        toast.warning(`${s.name} saved, but the connection failed`, {
          description: s.lastError ?? undefined,
        });
      else toast.success(`${s.name} saved`);
      onSaved?.(s);
      onOpenChange(false);
    },
    onError: (e) => toast.error('Could not save the server', { description: errMsg(e) }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{server ? `Edit ${server.name}` : 'Add MCP server'}</DialogTitle>
          <DialogDescription>
            AI Harness connects to MCP servers to reach your issue tracker. Secrets are encrypted on
            this machine.
          </DialogDescription>
        </DialogHeader>
        <form
          id="mcp-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="mcp-name">Name</Label>
              <Input
                id="mcp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jira"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>Transport</Label>
              <Select value={transport} onValueChange={(v) => setTransport(v as McpTransport)}>
                <SelectTrigger aria-label="Transport" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRANSPORTS.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {transport === 'stdio' ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-command">Command</Label>
                <Input
                  id="mcp-command"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx"
                  className="font-mono text-sm"
                  required
                />
                <p className="text-muted-foreground text-xs">
                  Run directly (no shell). Use a full path if it isn’t on PATH.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-args">Arguments (one per line)</Label>
                <Textarea
                  id="mcp-args"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  rows={3}
                  placeholder={'-y\n@scope/some-mcp-server'}
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Environment variables</Label>
                <KvEditor
                  rows={env}
                  onChange={setEnv}
                  addLabel="Add variable"
                  keyPlaceholder="API_TOKEN"
                />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-url">URL</Label>
                <Input
                  id="mcp-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/mcp"
                  className="font-mono text-sm"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label>Headers</Label>
                <KvEditor
                  rows={headers}
                  onChange={setHeaders}
                  addLabel="Add header"
                  keyPlaceholder="Authorization"
                />
              </div>
            </>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={enabled} onCheckedChange={setEnabled} /> Enabled
          </label>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="mcp-form" disabled={save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />} Save and test
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ServerRow({ server: s }: { server: McpServerDto }) {
  const qc = useQueryClient();
  const [edit, setEdit] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const test = useMutation({
    mutationFn: () => api.mcp.test(s.id),
    onSuccess: (x) =>
      x.lastStatus === 'ok'
        ? toast.success(`${x.name} connected`, {
            description: `${x.tools.length} tools available.`,
          })
        : toast.error(`${x.name}: connection failed`, { description: x.lastError ?? undefined }),
    onError: (e) => toast.error('Test failed', { description: errMsg(e) }),
  });
  const remove = useMutation({
    mutationFn: () => api.mcp.remove(s.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.mcpServers });
      void qc.invalidateQueries({ queryKey: qk.pmsConnections });
    },
    onError: (e) => toast.error('Could not remove the server', { description: errMsg(e) }),
  });
  return (
    <li className="py-3" data-testid={`mcp-${s.name}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{s.name}</span>
            <Badge variant="outline" className="font-normal">
              {s.transport === 'stdio' ? 'stdio' : s.transport === 'http' ? 'HTTP' : 'SSE'}
            </Badge>
            {!s.enabled && <Badge variant="secondary">Disabled</Badge>}
          </div>
          <div className="text-muted-foreground truncate font-mono text-xs">
            {s.transport === 'stdio' ? [s.command, ...s.args].join(' ') : s.url}
          </div>
        </div>
        <McpStatus server={s} />
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => test.mutate()}
            disabled={test.isPending || !s.enabled}
          >
            {test.isPending ? <Loader2 className="animate-spin" /> : <Plug />} Test
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={`Edit ${s.name}`}
            onClick={() => setEdit(true)}
          >
            <Pencil className="size-3.5" />
          </Button>
          {confirm ? (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              onBlur={() => setConfirm(false)}
            >
              Remove?
            </Button>
          ) : (
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              aria-label={`Remove ${s.name}`}
              onClick={() => setConfirm(true)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      {s.lastStatus === 'error' && s.lastError && (
        <pre className="bg-destructive/5 text-destructive mt-2 max-h-28 overflow-auto rounded p-2 text-[11px] whitespace-pre-wrap">
          {s.lastError}
        </pre>
      )}
      {s.tools.length > 0 && (
        <div className="mt-1.5">
          <button
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
            onClick={() => setShowTools((x) => !x)}
            aria-expanded={showTools}
          >
            <Wrench className="size-3" /> {showTools ? 'Hide' : 'Show'} tools
            <ChevronDown
              className={`size-3 transition-transform ${showTools ? 'rotate-180' : ''}`}
            />
            {s.lastCheckedAt && <span className="ml-1">· checked {timeAgo(s.lastCheckedAt)}</span>}
          </button>
          {showTools && (
            <ul className="mt-2 grid gap-1 sm:grid-cols-2">
              {s.tools.map((t) => (
                <li key={t.name} className="bg-muted/50 rounded px-2 py-1">
                  <div className="font-mono text-xs">{t.name}</div>
                  {t.description && (
                    <div className="text-muted-foreground line-clamp-2 text-[11px]">
                      {t.description}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {edit && <McpServerDialog open={edit} onOpenChange={setEdit} server={s} />}
    </li>
  );
}

export function McpServersSection() {
  const servers = useMcpServers();
  const [adding, setAdding] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          {servers.data?.length
            ? `${servers.data.length} server${servers.data.length === 1 ? '' : 's'}`
            : 'No MCP servers yet.'}
        </p>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus /> Add server
        </Button>
      </div>
      {!!servers.data?.length && (
        <ul className="divide-y">
          {servers.data.map((s) => (
            <ServerRow key={s.id} server={s} />
          ))}
        </ul>
      )}
      {adding && <McpServerDialog open={adding} onOpenChange={setAdding} />}
    </div>
  );
}
