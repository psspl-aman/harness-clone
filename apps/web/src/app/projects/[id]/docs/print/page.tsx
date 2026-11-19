'use client';

import { Loader2, Printer } from 'lucide-react';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

function PrintView() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const docId = params.get('doc');
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = docId
      ? api.docs.get(id, docId).then((d) => d.content)
      : fetch(api.docs.exportUrl(id)).then((r) =>
          r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)),
        );
    load
      .then((c) => {
        if (cancelled) return;
        setContent(c);
        // Give the browser a frame to lay out before opening the print dialog.
        requestAnimationFrame(() => setTimeout(() => window.print(), 300));
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id, docId]);

  return (
    <div className="print-root bg-background fixed inset-0 z-50 overflow-auto">
      <div className="mx-auto max-w-3xl px-8 py-8">
        <div className="mb-6 flex items-center justify-between print:hidden">
          <p className="text-muted-foreground text-sm">Use “Save as PDF” in the print dialog.</p>
          <Button size="sm" onClick={() => window.print()} disabled={!content}>
            <Printer /> Print
          </Button>
        </div>
        {error ? (
          <p className="text-destructive text-sm">Could not load the document: {error}</p>
        ) : content === null ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> Preparing…
          </p>
        ) : (
          <Markdown className="text-[15px] [&_h1]:text-2xl [&_h2]:mt-6 [&_h2]:text-lg [&_pre]:whitespace-pre-wrap">
            {content}
          </Markdown>
        )}
      </div>
    </div>
  );
}

export default function DocsPrintPage() {
  return (
    <Suspense>
      <PrintView />
    </Suspense>
  );
}
