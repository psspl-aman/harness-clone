import { FolderKanban, Plug, Settings, type LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Two-key "g then x" shortcut. */
  shortcut: string;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Projects', icon: FolderKanban, shortcut: 'p' },
  { href: '/integrations', label: 'Integrations', icon: Plug, shortcut: 'i' },
  { href: '/settings', label: 'Settings', icon: Settings, shortcut: 's' },
];

export const isActivePath = (pathname: string, href: string) =>
  href === '/' ? pathname === '/' || pathname.startsWith('/projects') : pathname.startsWith(href);
