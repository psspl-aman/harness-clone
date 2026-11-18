'use client';

import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUi } from '@/lib/stores';
import { ThemeToggle } from './theme-toggle';

export function Topbar() {
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  return (
    <header className="bg-background/80 sticky top-0 z-20 flex h-14 items-center gap-3 border-b px-4 backdrop-blur md:px-6">
      <Button
        variant="outline"
        onClick={() => setPaletteOpen(true)}
        className="text-muted-foreground h-8 w-full max-w-72 justify-start gap-2 rounded-lg px-3 text-sm font-normal shadow-none"
      >
        <Search className="size-3.5" />
        Search or jump to…
        <kbd className="bg-muted ml-auto rounded border px-1.5 font-mono text-[10px]">⌘K</kbd>
      </Button>
      <div className="ml-auto flex items-center gap-1">
        <ThemeToggle />
      </div>
    </header>
  );
}
