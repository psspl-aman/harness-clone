'use client';

import {
  PMS_FIELDS,
  type PmsConnectionDto,
  type PmsIssue,
  type PmsProvider,
  type PmsProviderPreset,
  type PmsToolMap,
} from '@ai-harness/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Eye, Loader2, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { api, ApiClientError, qk } from '@/lib/api';
import { McpServerDialog, McpStatus, useMcpServers, type McpServerDraft } from './mcp-servers';

const errMsg = (e: unknown) => (e instanceof ApiClientError ? e.message : String(e));
type OpKey = 'list' | 'get' | 'updateStatus' | 'comment';
const OPS: { key: OpKey; label: string; hint: string }[] = [
  {
    key: 'list',
    label: 'List issues',
    hint: 'Required. Vars: {{project}}, {{owner}}, {{repo}}, {{limit}}, {{filters.*}}',
  },
  { key: 'get', label: 'Get one issue', hint: 'Optional. Vars: {{issueId}}' },
  {
    key: 'updateStatus',
    label: 'Change status',
    hint: 'For write-back. Vars: {{issueId}}, {{status}}',
  },
  { key: 'comment', label: 'Add a comment', hint: 'For write-back. Vars: {{issueId}}, {{body}}' },
];

export function usePmsProviders() {
  return useQuery({ queryKey: qk.pmsProviders, queryFn: api.pms.providers, staleTime: Infinity });
}
export function usePmsConnections() {
  return useQuery({ queryKey: qk.pmsConnections, queryFn: api.pms.connections });
}

interface OpDraft {
  tool: string;
  args: string;
  itemsPath: string;
}
const toDraft = (m: PmsToolMap): Record<OpKey, OpDraft> =>
  Object.fromEntries(
    OPS.map(({ key }) => [
      key,
      {
        tool: m[key]?.tool ?? '',
        args: m[key] ? JSON.stringify(m[key]!.args, null, 2) : '{}',
        itemsPath: m[key]?.itemsPath ?? '',
      },
    ]),
  ) as Record<OpKey, OpDraft>;

function fromDraft(ops: Record<OpKey, OpDraft>, fields: PmsToolMap['fields']): PmsToolMap {
  const out: PmsToolMap = {
    fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v?.trim())),
  };
  for (const { key, label } of OPS) {
    const o = ops[key];
    if (!o.tool.trim()) continue;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(o.args || '{}');
    } catch {
      throw new Error(`Arguments for "${label}" aren't valid JSON`);
    }
    out[key] = {
      tool: o.tool.trim(),
      args,
      ...(key === 'list' && o.itemsPath.trim() ? { itemsPath: o.itemsPath.trim() } : {}),
    };
  }
  return out;
}

const presetServer = (p: PmsProviderPreset): McpServerDraft | undefined =>
  p.server
    ? {
        name: p.label,
        transport: p.server.transport,
        command: p.server.command,
        args: p.server.args,
        url: p.server.url,
        env: p.server.env?.map((e) => ({ key: e.key, value: '', secret: e.secret, hint: e.hint })),
        headers: p.server.headers?.map((e) => ({
          key: e.key,
          value: '',
          secret: e.secret,
          hint: e.hint,
        })),
      }
    : undefined;

export function PmsConnectionDialog({
  open,
  onOpenChange,
  connection,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  connection?: PmsConnectionDto;
}) {
  const qc = useQueryClient();
  const providers = usePmsProviders().data ?? [];
  const servers = useMcpServers().data ?? [];
  const [provider, setProvider] = useState<PmsProvider>(connection?.provider ?? 'jira');
  const preset = providers.find((p) => p.id === provider);
  const [name, setName] = useState(connection?.name ?? '');
  const [serverId, setServerId] = useState(connection?.mcpServerId ?? '');
  const [ops, setOps] = useState(toDraft(connection?.toolMap ?? { fields: {} }));
  const [fields, setFields] = useState<PmsToolMap['fields']>(connection?.toolMap.fields ?? {});
  const [showFields, setShowFields] = useState(false);
  const [newServer, setNewServer] = useState(false);
  const [project, setProject] = useState('');
  const [preview, setPreview] = useState<{ issues: PmsIssue[]; total: number } | null>(null);
  const server = servers.find((s) => s.id === serverId);
  const tools = server?.tools ?? [];

  const detect = useMutation({
    mutationFn: () => api.pms.detect(serverId, provider),
    onSuccess: (m) => {
      setOps(toDraft(m));
      setFields(m.fields);
      const found = OPS.filter((o) => m[o.key]).length;
      toast.success(`Found ${found} of 4 operations`, {
        description:
          found < 4 ? 'Pick the missing tools by hand if the server has them.' : undefined,
      });
    },
    onError: (e) => toast.error('Could not read the server’s tools', { description: errMsg(e) }),
  });
  const runPreview = useMutation({
    mutationFn: () =>
      api.pms.preview({
        mcpServerId: serverId,
        toolMap: fromDraft(ops, fields),
        externalProject: project.trim(),
      }),
    onSuccess: setPreview,
    onError: (e) => {
      setPreview(null);
      toast.error('Preview failed', { description: errMsg(e) });
    },
  });
  const save = useMutation({
    mutationFn: () => {
      const input = {
        name: name.trim() || preset?.label || provider,
        provider,
        mcpServerId: serverId,
        toolMap: fromDraft(ops, fields),
      };
      return connection
        ? api.pms.updateConnection(connection.id, input)
        : api.pms.createConnection(input);
    },
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: qk.pmsConnections });
      toast.success(`${c.name} saved`);
      onOpenChange(false);
    },
    onError: (e) => toast.error('Could not save the connection', { description: errMsg(e) }),
  });
  const setOp = (k: OpKey, patch: Partial<OpDraft>) =>
    setOps((o) => ({ ...o, [k]: { ...o[k], ...patch } }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {connection ? `Edit ${connection.name}` : 'Connect an issue tracker'}
          </DialogTitle>
          <DialogDescription>
            Pick the MCP server that talks to your tracker, then tell AI Harness which of its tools
            list issues, change status and comment.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Tracker</Label>
              <Select
                value={provider}
                onValueChange={(v) => {
                  setProvider(v as PmsProvider);
                  const p = providers.find((x) => x.id === v);
                  if (!connection && p) {
                    setOps(toDraft(p.toolMap));
                    setFields(p.toolMap.fields);
                  }
                }}
              >
                <SelectTrigger aria-label="Tracker" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {preset?.docsUrl && (
                <a
                  href={preset.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary text-xs hover:underline"
                >
                  {preset.label} MCP server docs ↗
                </a>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pms-name">Name</Label>
              <Input
                id="pms-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={preset?.label ?? 'My tracker'}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>MCP server</Label>
            <div className="flex gap-2">
              <Select value={serverId} onValueChange={setServerId}>
                <SelectTrigger aria-label="MCP server" className="flex-1">
                  <SelectValue
                    placeholder={servers.length ? 'Choose a server' : 'No servers yet'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {servers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" variant="outline" onClick={() => setNewServer(true)}>
                <Plus /> New server
              </Button>
            </div>
            {server && <McpStatus server={server} />}
            {preset?.server && !serverId && (
              <p className="text-muted-foreground text-xs">
                “New server” is pre-filled with a suggested {preset.label} setup — check it against
                the docs.
              </p>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Tools</Label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!serverId || detect.isPending}
                onClick={() => detect.mutate()}
              >
                {detect.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />} Auto-detect
              </Button>
            </div>
            {OPS.map((o) => (
              <div key={o.key} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-32 text-sm font-medium">{o.label}</span>
                  {tools.length ? (
                    <Select
                      value={ops[o.key].tool || '__none'}
                      onValueChange={(v) => setOp(o.key, { tool: v === '__none' ? '' : v })}
                    >
                      <SelectTrigger
                        aria-label={`${o.label} tool`}
                        className="h-8 flex-1 font-mono text-xs"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none">Not used</SelectItem>
                        {tools.map((t) => (
                          <SelectItem key={t.name} value={t.name} className="font-mono text-xs">
                            {t.name}
                          </SelectItem>
                        ))}
                        {ops[o.key].tool && !tools.some((t) => t.name === ops[o.key].tool) && (
                          <SelectItem value={ops[o.key].tool} className="font-mono text-xs">
                            {ops[o.key].tool} (not on server)
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      value={ops[o.key].tool}
                      onChange={(e) => setOp(o.key, { tool: e.target.value })}
                      placeholder="tool name"
                      className="h-8 flex-1 font-mono text-xs"
                      aria-label={`${o.label} tool`}
                    />
                  )}
                </div>
                {ops[o.key].tool && (
                  <div className="mt-2 space-y-1">
                    <Textarea
                      value={ops[o.key].args}
                      onChange={(e) => setOp(o.key, { args: e.target.value })}
                      rows={Math.min(6, ops[o.key].args.split('\n').length)}
                      className="font-mono text-xs"
                      aria-label={`${o.label} arguments`}
                    />
                    <p className="text-muted-foreground text-[11px]">{o.hint}</p>
                    {o.key === 'list' && (
                      <Input
                        value={ops.list.itemsPath}
                        onChange={(e) => setOp('list', { itemsPath: e.target.value })}
                        placeholder="Path to the issue list in the result (auto)"
                        className="h-7 font-mono text-xs"
                        aria-label="Items path"
                      />
                    )}
                  </div>
                )}
              </div>
            ))}
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
              onClick={() => setShowFields((x) => !x)}
              aria-expanded={showFields}
            >
              <ChevronDown
                className={`size-3 transition-transform ${showFields ? 'rotate-180' : ''}`}
              />{' '}
              Field paths (when auto-mapping misses)
            </button>
            {showFields && (
              <div className="grid gap-2 sm:grid-cols-2">
                {PMS_FIELDS.map((f) => (
                  <div key={f} className="flex items-center gap-2">
                    <span className="w-20 text-xs">{f}</span>
                    <Input
                      value={fields[f] ?? ''}
                      onChange={(e) => setFields((x) => ({ ...x, [f]: e.target.value }))}
                      placeholder="auto"
                      className="h-7 font-mono text-xs"
                      aria-label={`${f} path`}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-muted/40 space-y-2 rounded-lg p-3">
            <Label htmlFor="pms-preview">Try it</Label>
            <div className="flex gap-2">
              <Input
                id="pms-preview"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                placeholder={`${preset?.projectLabel ?? 'Project'}: ${preset?.projectPlaceholder ?? ''}`}
                className="h-8"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!serverId || !project.trim() || !ops.list.tool || runPreview.isPending}
                onClick={() => runPreview.mutate()}
              >
                {runPreview.isPending ? <Loader2 className="animate-spin" /> : <Eye />} Preview
              </Button>
            </div>
            {preview && (
              <div className="text-sm">
                <p className="text-muted-foreground mb-1 text-xs">
                  {preview.total} issue{preview.total === 1 ? '' : 's'} found
                  {preview.total > preview.issues.length ? ` — first ${preview.issues.length}` : ''}
                </p>
                <ul
                  className="max-h-40 divide-y overflow-auto rounded border bg-background"
                  data-testid="pms-preview"
                >
                  {preview.issues.map((i) => (
                    <li key={i.id} className="flex items-center gap-2 px-2 py-1 text-xs">
                      <span className="font-mono font-medium">{i.id}</span>
                      <span className="truncate">{i.title}</span>
                      {i.status && (
                        <Badge variant="outline" className="ml-auto shrink-0 text-[10px]">
                          {i.status}
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!serverId || !ops.list.tool || save.isPending}
          >
            {save.isPending && <Loader2 className="animate-spin" />} Save connection
          </Button>
        </DialogFooter>
        {newServer && (
          <McpServerDialog
            open={newServer}
            onOpenChange={setNewServer}
            draft={preset ? presetServer(preset) : undefined}
            onSaved={(s) => setServerId(s.id)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConnectionRow({ connection: c, label }: { connection: PmsConnectionDto; label: string }) {
  const qc = useQueryClient();
  const [edit, setEdit] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.pms.removeConnection(c.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.pmsConnections }),
    onError: (e) => toast.error('Could not remove the connection', { description: errMsg(e) }),
  });
  return (
    <li className="flex flex-wrap items-center gap-3 py-3" data-testid={`pms-${c.name}`}>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{c.name}</div>
        <div className="text-muted-foreground text-xs">
          {label} via {c.mcpServerName}
        </div>
      </div>
      <div className="flex gap-1">
        {OPS.map((o) => (
          <Badge
            key={o.key}
            variant={c.toolMap[o.key] ? 'secondary' : 'outline'}
            className="gap-1 text-[10px] font-normal"
            title={c.toolMap[o.key]?.tool ?? 'not configured'}
          >
            {c.toolMap[o.key] && <Check className="size-3" />}
            {o.label}
          </Badge>
        ))}
      </div>
      <Button
        size="icon"
        variant="ghost"
        className="size-8"
        aria-label={`Edit ${c.name}`}
        onClick={() => setEdit(true)}
      >
        <Pencil className="size-3.5" />
      </Button>
      {confirm ? (
        <Button
          size="sm"
          variant="destructive"
          onClick={() => remove.mutate()}
          onBlur={() => setConfirm(false)}
        >
          Remove?
        </Button>
      ) : (
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label={`Remove ${c.name}`}
          onClick={() => setConfirm(true)}
        >
          <Trash2 className="size-3.5" />
        </Button>
      )}
      {edit && <PmsConnectionDialog open={edit} onOpenChange={setEdit} connection={c} />}
    </li>
  );
}

export function PmsConnectionsSection() {
  const conns = usePmsConnections();
  const providers = usePmsProviders().data ?? [];
  const [adding, setAdding] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          {conns.data?.length
            ? `${conns.data.length} tracker${conns.data.length === 1 ? '' : 's'} connected`
            : 'No trackers connected yet.'}
        </p>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus /> Connect tracker
        </Button>
      </div>
      {!!conns.data?.length && (
        <ul className="divide-y">
          {conns.data.map((c) => (
            <ConnectionRow
              key={c.id}
              connection={c}
              label={providers.find((p) => p.id === c.provider)?.label ?? c.provider}
            />
          ))}
        </ul>
      )}
      {adding && <PmsConnectionDialog open={adding} onOpenChange={setAdding} />}
    </div>
  );
}
