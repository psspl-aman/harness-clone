'use client';

import { ArrowUpRight, Menu, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useUi } from '@/lib/stores';
import { isActivePath, NAV_ITEMS } from './nav';
import { ThemeToggle } from './theme-toggle';

export function Topbar() {
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  const pathname = usePathname();
  const current = NAV_ITEMS.find((item) => isActivePath(pathname, item.href));

  return (
    <header className="bg-card flex h-14 shrink-0 items-center gap-2 border-b px-3 md:gap-4 md:px-5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Open navigation">
            <Menu />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {NAV_ITEMS.map((item) => (
            <DropdownMenuItem key={item.href} asChild>
              <Link href={item.href} aria-current={item === current ? 'page' : undefined}>
                <item.icon /> {item.label}
              </Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {current && (
        <span className="text-foreground hidden shrink-0 text-[13px] font-semibold md:block">
          {current.label}
        </span>
      )}
      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        <Button
          variant="outline"
          onClick={() => setPaletteOpen(true)}
          aria-label="Search or jump to"
          className="bg-card text-muted-foreground h-8 min-w-0 shrink justify-start gap-2 px-2.5 text-xs font-normal shadow-none sm:w-64"
        >
          <Search className="size-3.5" />
          <span className="truncate">Search or jump to</span>
          <kbd className="bg-muted ml-auto hidden rounded border px-1.5 font-mono text-[10px] sm:inline">
            Ctrl / ⌘ K
          </kbd>
        </Button>
        <Button asChild variant="ghost" size="sm" className="text-muted-foreground px-2 text-xs">
          <a href="/welcome" aria-label="Welcome" title="Welcome">
            <span className="hidden sm:inline">Welcome</span>
            <ArrowUpRight className="size-3.5" />
          </a>
        </Button>
        <ThemeToggle />
      </div>
    </header>
  );
}
