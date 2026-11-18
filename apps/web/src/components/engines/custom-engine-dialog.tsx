'use client';

import {
  CustomEngineConfigSchema,
  type CustomEngineConfig,
  type EngineInfo,
} from '@agentforge/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
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

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);

function F({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

/** Create or edit a custom CLI engine (argument template + output parser). */
export function CustomEngineDialog({
  open,
  onOpenChange,
  engine,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  engine?: EngineInfo;
}) {
  const queryClient = useQueryClient();
  const c = engine?.customConfig;
  const [name, setName] = useState(engine?.displayName ?? '');
  const [slug, setSlug] = useState(engine ? engine.id.replace(/^custom:/, '') : '');
  const [command, setCommand] = useState(c?.command ?? '');
  const [args, setArgs] = useState((c?.args ?? ['{{prompt}}']).join('\n'));
  const [promptVia, setPromptVia] = useState<CustomEngineConfig['promptVia']>(
    c?.promptVia ?? 'arg',
  );
  const [outputFormat, setOutputFormat] = useState<CustomEngineConfig['outputFormat']>(
    c?.outputFormat ?? 'text',
  );
  const [textPath, setTextPath] = useState(c?.textPath ?? '');
  const [sessionIdPath, setSessionIdPath] = useState(c?.sessionIdPath ?? '');
  const [inPath, setInPath] = useState(c?.usage?.inputTokensPath ?? '');
  const [outPath, setOutPath] = useState(c?.usage?.outputTokensPath ?? '');
  const [usageRegex, setUsageRegex] = useState(c?.usage?.regex ?? '');
  const [authCheck, setAuthCheck] = useState((c?.authCheckArgs ?? []).join(' '));
  const [loginArgs, setLoginArgs] = useState((c?.loginArgs ?? []).join(' '));
  const [apiKeyEnv, setApiKeyEnv] = useState(c?.apiKeyEnv ?? '');

  const config: CustomEngineConfig = {
    command: command.trim(),
    args: lines(args),
    promptVia,
    outputFormat,
    ...(outputFormat === 'jsonl' && textPath.trim() ? { textPath: textPath.trim() } : {}),
    ...(outputFormat === 'jsonl' && sessionIdPath.trim()
      ? { sessionIdPath: sessionIdPath.trim() }
      : {}),
    ...(inPath.trim() || outPath.trim() || usageRegex.trim()
      ? {
          usage: {
            ...(inPath.trim() ? { inputTokensPath: inPath.trim() } : {}),
            ...(outPath.trim() ? { outputTokensPath: outPath.trim() } : {}),
            ...(usageRegex.trim() ? { regex: usageRegex.trim() } : {}),
          },
        }
      : {}),
    ...(authCheck.trim() ? { authCheckArgs: words(authCheck) } : {}),
    ...(loginArgs.trim() ? { loginArgs: words(loginArgs) } : {}),
    ...(apiKeyEnv.trim() ? { apiKeyEnv: apiKeyEnv.trim() } : {}),
  };
  const valid = CustomEngineConfigSchema.safeParse(config);
  const slugOk = /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug);

  const save = useMutation({
    mutationFn: () =>
      engine
        ? api.engines.updateCustom(engine.id, { displayName: name.trim(), config })
        : api.engines.createCustom({ slug, displayName: name.trim(), config }),
    onSuccess: (e) => {
      void queryClient.invalidateQueries({ queryKey: qk.engines });
      toast.success(engine ? `Updated ${e.displayName}` : `Added ${e.displayName}`);
      onOpenChange(false);
    },
    onError: (err) =>
      toast.error('Could not save engine', {
        description: err instanceof ApiClientError ? err.message : String(err),
      }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {engine ? `Edit ${engine.displayName}` : 'Add a custom CLI engine'}
          </DialogTitle>
          <DialogDescription>
            Any agent CLI that takes a prompt and prints an answer. Commands run directly, never
            through a shell.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid.success && name.trim() && slugOk) save.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <F label="Display name" htmlFor="ce-name">
              <Input
                id="ce-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Aider"
              />
            </F>
            <F label="Id" htmlFor="ce-slug" hint={<code>custom:{slug || '…'}</code>}>
              <Input
                id="ce-slug"
                value={slug}
                disabled={!!engine}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                placeholder="aider"
                aria-invalid={!!slug && !slugOk}
              />
            </F>
          </div>
          <F label="Command" htmlFor="ce-cmd" hint="Executable name on PATH or an absolute path.">
            <Input
              id="ce-cmd"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              className="font-mono text-sm"
              placeholder="aider"
            />
          </F>
          <F
            label="Arguments (one per line)"
            htmlFor="ce-args"
            hint={
              <>
                Placeholders: <code>{'{{prompt}}'}</code> <code>{'{{cwd}}'}</code>{' '}
                <code>{'{{model}}'}</code> <code>{'{{sessionId}}'}</code>. A placeholder line that
                is empty is dropped with the flag before it.
              </>
            }
          >
            <Textarea
              id="ce-args"
              rows={4}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              className="font-mono text-xs"
            />
          </F>
          <div className="grid gap-4 sm:grid-cols-2">
            <F label="Prompt is passed via">
              <Select
                value={promptVia}
                onValueChange={(v) => setPromptVia(v as CustomEngineConfig['promptVia'])}
              >
                <SelectTrigger aria-label="Prompt is passed via">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="arg">{'{{prompt}} argument'}</SelectItem>
                  <SelectItem value="stdin">stdin</SelectItem>
                </SelectContent>
              </Select>
            </F>
            <F label="Output format">
              <Select
                value={outputFormat}
                onValueChange={(v) => setOutputFormat(v as CustomEngineConfig['outputFormat'])}
              >
                <SelectTrigger aria-label="Output format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">Plain text</SelectItem>
                  <SelectItem value="jsonl">JSON lines</SelectItem>
                </SelectContent>
              </Select>
            </F>
          </div>
          {outputFormat === 'jsonl' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <F label="Text path" htmlFor="ce-text" hint="e.g. message.content">
                <Input
                  id="ce-text"
                  value={textPath}
                  onChange={(e) => setTextPath(e.target.value)}
                  className="font-mono text-xs"
                />
              </F>
              <F label="Session id path" htmlFor="ce-sid">
                <Input
                  id="ce-sid"
                  value={sessionIdPath}
                  onChange={(e) => setSessionIdPath(e.target.value)}
                  className="font-mono text-xs"
                />
              </F>
              <F label="Input tokens path" htmlFor="ce-in">
                <Input
                  id="ce-in"
                  value={inPath}
                  onChange={(e) => setInPath(e.target.value)}
                  className="font-mono text-xs"
                />
              </F>
              <F label="Output tokens path" htmlFor="ce-out">
                <Input
                  id="ce-out"
                  value={outPath}
                  onChange={(e) => setOutPath(e.target.value)}
                  className="font-mono text-xs"
                />
              </F>
            </div>
          ) : (
            <F
              label="Token usage regex"
              htmlFor="ce-re"
              hint={
                <>
                  Optional, with named groups <code>input</code> and <code>output</code>.
                </>
              }
            >
              <Input
                id="ce-re"
                value={usageRegex}
                onChange={(e) => setUsageRegex(e.target.value)}
                className="font-mono text-xs"
                placeholder="in=(?<input>\d+) out=(?<output>\d+)"
              />
            </F>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <F label="Auth check args" htmlFor="ce-auth" hint="Exit 0 = signed in">
              <Input
                id="ce-auth"
                value={authCheck}
                onChange={(e) => setAuthCheck(e.target.value)}
                className="font-mono text-xs"
                placeholder="auth status"
              />
            </F>
            <F label="Login args" htmlFor="ce-login" hint="Run in a terminal">
              <Input
                id="ce-login"
                value={loginArgs}
                onChange={(e) => setLoginArgs(e.target.value)}
                className="font-mono text-xs"
                placeholder="login"
              />
            </F>
            <F label="API key env var" htmlFor="ce-env">
              <Input
                id="ce-env"
                value={apiKeyEnv}
                onChange={(e) => setApiKeyEnv(e.target.value.toUpperCase())}
                className="font-mono text-xs"
                placeholder="MY_CLI_API_KEY"
              />
            </F>
          </div>
          {!valid.success && command && (
            <p className="text-destructive text-xs">
              {valid.error.issues[0]?.path.join('.')}: {valid.error.issues[0]?.message}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!valid.success || !name.trim() || !slugOk || save.isPending}
            >
              {save.isPending && <Loader2 className="animate-spin" />}{' '}
              {engine ? 'Save' : 'Add engine'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
