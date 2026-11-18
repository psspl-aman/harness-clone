'use client';

import { useQuery } from '@tanstack/react-query';
import { FolderGit2, FolderOpen, Laptop, Moon, PanelLeft, Plus, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import { api, qk } from '@/lib/api';
import { useUi } from '@/lib/stores';
import { NAV_ITEMS } from './nav';

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

/** ⌘K palette plus global shortcuts: ⌘B sidebar, "g p" / "g s" navigation. */
export function CommandPalette() {
  const router = useRouter();
  const { setTheme } = useTheme();
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const gPressedAt = useRef(0);
  const projects = useQuery({ queryKey: qk.projects, queryFn: api.projects.list, enabled: open });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!useUi.getState().paletteOpen);
        return;
      }
      if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (mod || e.altKey || isTyping(e.target)) return;
      if (e.key === 'g') {
        gPressedAt.current = Date.now();
        return;
      }
      if (Date.now() - gPressedAt.current < 1000) {
        const item = NAV_ITEMS.find((n) => n.shortcut === e.key);
        if (item) {
          gPressedAt.current = 0;
          router.push(item.href);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router, setOpen, toggleSidebar]);

  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Jump anywhere or run a command"
    >
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Navigate">
          {NAV_ITEMS.map((n) => (
            <CommandItem
              key={n.href}
              value={`go ${n.label}`}
              onSelect={() => run(() => router.push(n.href))}
            >
              <n.icon /> {n.label}
              <CommandShortcut>G {n.shortcut.toUpperCase()}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Create">
          <CommandItem
            value="new project from scratch"
            onSelect={() => run(() => router.push('/projects/new?mode=scratch'))}
          >
            <Plus /> New project from scratch
          </CommandItem>
          <CommandItem
            value="attach existing project"
            onSelect={() => run(() => router.push('/projects/new?mode=existing'))}
          >
            <FolderOpen /> Attach existing project
          </CommandItem>
        </CommandGroup>
        {projects.data && projects.data.length > 0 && (
          <CommandGroup heading="Projects">
            {projects.data.map((p) => (
              <CommandItem
                key={p.id}
                value={`project ${p.name} ${p.localPath}`}
                onSelect={() => run(() => router.push(`/projects/${p.id}`))}
              >
                <FolderGit2 /> {p.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandSeparator />
        <CommandGroup heading="Preferences">
          <CommandItem value="theme light" onSelect={() => run(() => setTheme('light'))}>
            <Sun /> Light theme
          </CommandItem>
          <CommandItem value="theme dark" onSelect={() => run(() => setTheme('dark'))}>
            <Moon /> Dark theme
          </CommandItem>
          <CommandItem value="theme system" onSelect={() => run(() => setTheme('system'))}>
            <Laptop /> System theme
          </CommandItem>
          <CommandItem value="toggle sidebar" onSelect={() => run(toggleSidebar)}>
            <PanelLeft /> Toggle sidebar
            <CommandShortcut>⌘B</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
