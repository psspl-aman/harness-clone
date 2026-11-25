'use client';

import type { AttachmentDto, RequirementIntent } from '@agentforge/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowUp, FileCode2, Hash, Loader2, Paperclip, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useDebounced } from '@/hooks/use-debounced';
import { api, ApiClientError, qk } from '@/lib/api';
import { cn } from '@/lib/utils';

const INTENTS: { value: RequirementIntent; label: string; hint: string }[] = [
  { value: 'generate_plan', label: 'Plan', hint: 'Generate a new plan' },
  { value: 'add_to_plan', label: 'Add tasks', hint: 'Add tasks to the current plan' },
  { value: 'discuss', label: 'Discuss', hint: 'Just talk — no tasks' },
];

export interface ComposerDraft {
  content: string;
  intent?: RequirementIntent;
  supersedesId?: string;
  skipQuestions?: boolean;
}

interface Props {
  projectId: string;
  hasPlan: boolean;
  busy: boolean;
  /** Initial content (edit, answer, retry). The parent remounts the composer with a new key to apply one. */
  initial?: ComposerDraft | null;
}

/** The token being typed at the caret: "@src/ap" → { trigger: '@', query: 'src/ap' }. */
function activeToken(text: string, caret: number) {
  const m = text.slice(0, caret).match(/(^|\s)([@#])([\w./-]*)$/);
  return m ? { trigger: m[2] as '@' | '#', query: m[3]!, start: caret - m[3]!.length - 1 } : null;
}

export function Composer({ projectId, hasPlan, busy, initial }: Props) {
  const [text, setText] = useState(initial?.content ?? '');
  const [intent, setIntent] = useState<RequirementIntent>(
    initial?.intent ?? (hasPlan ? 'add_to_plan' : 'generate_plan'),
  );
  const [intentTouched, setIntentTouched] = useState(!!initial?.intent);
  const [skipQuestions, setSkipQuestions] = useState(initial?.skipQuestions ?? false);
  const [editing, setEditing] = useState<string | null>(initial?.supersedesId ?? null);
  const [attachments, setAttachments] = useState<AttachmentDto[]>([]);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const effectiveIntent = intentTouched ? intent : hasPlan ? 'add_to_plan' : 'generate_plan';

  // Focus with the caret at the end when opened with a draft.
  useEffect(() => {
    if (!initial) return;
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [initial]);

  const token = activeToken(text, caret);
  const q = useDebounced(token?.query ?? '', 150);
  const suggestions = useQuery({
    queryKey: qk.references(projectId, q),
    queryFn: () => api.chat.references(projectId, q),
    enabled: !!token,
  });
  const items = token
    ? token.trigger === '@'
      ? (suggestions.data?.files ?? []).map((f) => ({
          insert: `@${f}`,
          label: f,
          sub: null as string | null,
        }))
      : (suggestions.data?.tasks ?? []).map((t) => ({
          insert: `#${t.key}`,
          label: t.key,
          sub: t.title,
        }))
    : [];

  const pick = (insert: string) => {
    if (!token) return;
    const next = `${text.slice(0, token.start)}${insert} ${text.slice(caret)}`;
    const pos = token.start + insert.length + 1;
    setText(next);
    setCaret(pos);
    requestAnimationFrame(() => ref.current?.setSelectionRange(pos, pos));
  };

  const upload = useMutation({
    mutationFn: (files: File[]) => api.chat.upload(projectId, files),
    onSuccess: (saved) => setAttachments((a) => [...a, ...saved]),
    onError: (e) =>
      toast.error('Upload failed', {
        description: e instanceof ApiClientError ? e.message : String(e),
      }),
  });
  const send = useMutation({
    mutationFn: () =>
      api.chat.send(projectId, {
        content: text.trim(),
        intent: effectiveIntent,
        attachmentIds: attachments.map((a) => a.id),
        skipQuestions,
        supersedesId: editing ?? undefined,
      }),
    onSuccess: () => {
      setText('');
      setAttachments([]);
      setEditing(null);
      setSkipQuestions(false);
    },
    onError: (e) =>
      toast.error('Could not send', {
        description: e instanceof ApiClientError ? e.message : String(e),
      }),
  });
  const canSend = !!text.trim() && !busy && !send.isPending && !upload.isPending;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => (h + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(items[Math.min(highlight, items.length - 1)]!.insert);
        return;
      }
      if (e.key === 'Escape') {
        setCaret(-1);
        return;
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSend) {
      e.preventDefault();
      send.mutate();
    }
  };

  const addFiles = (files: FileList | File[]) => {
    const list = [...files];
    if (list.length) upload.mutate(list);
  };

  return (
    <div
      className={cn(
        'bg-background relative border-t p-3',
        dragging && 'ring-primary ring-2 ring-inset',
      )}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      {items.length > 0 && (
        <ul
          role="listbox"
          aria-label={token?.trigger === '@' ? 'Files' : 'Tasks'}
          className="bg-popover absolute right-3 bottom-full left-3 z-20 mb-1 max-h-56 overflow-y-auto rounded-lg border p-1 shadow-lg"
        >
          {items.map((it, i) => (
            <li key={it.insert}>
              <button
                role="option"
                aria-selected={i === highlight}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(it.insert);
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
                  i === highlight && 'bg-accent',
                )}
              >
                {token?.trigger === '@' ? (
                  <FileCode2 className="text-muted-foreground size-3.5" />
                ) : (
                  <Hash className="text-muted-foreground size-3.5" />
                )}
                <span className="truncate font-mono">{it.label}</span>
                {it.sub && <span className="text-muted-foreground truncate">{it.sub}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <div className="text-muted-foreground mb-2 flex items-center justify-between text-xs">
          <span>Editing a requirement — sending creates a new version.</span>
          <button
            className="hover:text-foreground"
            onClick={() => {
              setEditing(null);
              setText('');
            }}
          >
            Cancel
          </button>
        </div>
      )}

      <div className="bg-card focus-within:ring-ring/40 rounded-xl border shadow-xs focus-within:ring-[3px]">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
            {attachments.map((a) => (
              <span
                key={a.id}
                className="bg-muted flex items-center gap-1 rounded-md px-2 py-0.5 text-xs"
              >
                <Paperclip className="size-3" /> {a.name}
                <button
                  aria-label={`Remove ${a.name}`}
                  onClick={() => setAttachments((xs) => xs.filter((x) => x.id !== a.id))}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          value={text}
          rows={3}
          aria-label="Message the Planner"
          placeholder={
            hasPlan
              ? 'Describe what to add or change… (@ files, # tasks)'
              : 'Describe what to build… (@ files, # tasks)'
          }
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            setHighlight(0);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              addFiles(e.clipboardData.files);
            }
          }}
          className="placeholder:text-muted-foreground block max-h-60 min-h-[76px] w-full resize-y bg-transparent px-3 py-2.5 text-sm outline-none"
        />
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-2 pb-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => e.target.files && addFiles(e.target.files)}
            aria-label="Attach files"
          />
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Attach files"
            onClick={() => fileInput.current?.click()}
            disabled={upload.isPending}
          >
            {upload.isPending ? <Loader2 className="animate-spin" /> : <Paperclip />}
          </Button>
          <div
            role="radiogroup"
            aria-label="What should the Planner do?"
            className="bg-muted flex max-w-full flex-wrap rounded-md border p-0.5"
          >
            {INTENTS.map((i) => (
              <button
                key={i.value}
                role="radio"
                aria-checked={effectiveIntent === i.value}
                title={i.hint}
                disabled={i.value === 'add_to_plan' && !hasPlan}
                onClick={() => {
                  setIntent(i.value);
                  setIntentTouched(true);
                }}
                className={cn(
                  'rounded-md px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors disabled:opacity-40',
                  effectiveIntent === i.value
                    ? 'bg-card shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {i.label}
              </button>
            ))}
          </div>
          {effectiveIntent !== 'discuss' && (
            <label className="text-muted-foreground flex items-center gap-1.5 text-xs whitespace-nowrap">
              <Checkbox
                checked={skipQuestions}
                onCheckedChange={(v) => setSkipQuestions(v === true)}
                aria-label="Don't ask questions"
              />
              No questions
            </label>
          )}
          <Button
            size="icon"
            className="ml-auto size-8 rounded-lg"
            aria-label="Send (⌘↵)"
            disabled={!canSend}
            onClick={() => send.mutate()}
          >
            {send.isPending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          </Button>
        </div>
      </div>
    </div>
  );
}
