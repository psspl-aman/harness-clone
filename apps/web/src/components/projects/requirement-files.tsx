'use client';

import type { StagedAttachmentDto } from '@agentforge/shared';
import { useMutation } from '@tanstack/react-query';
import { FileText, Loader2, Paperclip, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api, ApiClientError } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Same limits as the daemon's multipart upload (and the chat's paperclip). */
export const MAX_REQUIREMENT_FILES = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Two files count as the same when their name and size match. */
const fileKey = (name: string, size: number) => `${name}\u0000${size}`;

const fmtSize = (n: number) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;

/**
 * Requirement documents for a project that doesn't exist yet: files are uploaded to the
 * daemon's staging area right away (so problems show up now) and attached on create.
 */
export function RequirementFiles({
  value,
  onChange,
}: {
  value: StagedAttachmentDto[];
  onChange: (files: StagedAttachmentDto[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // Original name + size of each upload, by staged id (the daemon sanitises stored names).
  const keys = useRef(new Map<string, string>());
  const keyOf = (f: StagedAttachmentDto) => keys.current.get(f.id) ?? fileKey(f.name, f.size);
  const upload = useMutation({
    mutationFn: (files: File[]) => api.attachments.stage(files),
    // The daemon returns one entry per file, in upload order.
    onSuccess: (staged, files) => {
      staged.forEach((s, i) => keys.current.set(s.id, fileKey(files[i]!.name, files[i]!.size)));
      onChange([...value, ...staged]);
    },
    onError: (e) =>
      toast.error('Upload failed', {
        description: e instanceof ApiClientError ? e.message : String(e),
      }),
  });

  const add = (list: FileList | File[]) => {
    // Skip files already attached, or picked twice in this batch (same name and size).
    const seen = new Set(value.map(keyOf));
    const files: File[] = [];
    const duplicates: string[] = [];
    for (const f of list) {
      const key = fileKey(f.name, f.size);
      if (seen.has(key)) duplicates.push(f.name);
      else {
        seen.add(key);
        files.push(f);
      }
    }
    if (duplicates.length)
      toast.info(
        `${[...new Set(duplicates)].join(', ')} ${duplicates.length > 1 ? 'are' : 'is'} already attached`,
      );
    if (!files.length) return;
    const tooBig = files.filter((f) => f.size > MAX_FILE_BYTES);
    if (tooBig.length) {
      toast.error(
        `${tooBig.map((f) => f.name).join(', ')} ${tooBig.length > 1 ? 'are' : 'is'} larger than 20 MB`,
      );
      return;
    }
    const room = MAX_REQUIREMENT_FILES - value.length;
    if (files.length > room) {
      toast.error(`Attach at most ${MAX_REQUIREMENT_FILES} files`);
      return;
    }
    upload.mutate(files);
  };

  const full = value.length >= MAX_REQUIREMENT_FILES;
  return (
    <div
      className={cn(
        'rounded-lg border border-dashed p-3 transition-colors',
        dragging && 'border-primary bg-primary/5',
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!full && !upload.isPending) add(e.dataTransfer.files);
      }}
    >
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label="Attach requirement documents"
        onChange={(e) => {
          if (e.target.files) add(e.target.files);
          e.target.value = '';
        }}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => input.current?.click()}
          disabled={full || upload.isPending}
        >
          {upload.isPending ? <Loader2 className="animate-spin" /> : <Paperclip />} Attach files
        </Button>
        <span className="text-muted-foreground text-xs">
          or drop them here — specs, briefs, designs (.md, .txt, .pdf, .docx, images…). Up to{' '}
          {MAX_REQUIREMENT_FILES} files, 20 MB each.
        </span>
      </div>
      {value.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Attached documents">
          {value.map((f) => (
            <li
              key={f.id}
              className="bg-muted flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs"
            >
              <FileText className="size-3.5 shrink-0" />
              <span className="truncate">{f.name}</span>
              <span className="text-muted-foreground shrink-0">{fmtSize(f.size)}</span>
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                className="hover:text-foreground text-muted-foreground shrink-0"
                onClick={() => {
                  keys.current.delete(f.id);
                  onChange(value.filter((x) => x.id !== f.id));
                }}
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
