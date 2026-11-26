'use client';

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useUi } from '@/lib/stores';
import { cn } from '@/lib/utils';
import { ForgeMark } from './forge-mark';
import { ConnectionStatus } from './connection-status';
import { isActivePath, NAV_ITEMS } from './nav';

export function AppSidebar() {
  const pathname = usePathname();
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggle = useUi((s) => s.toggleSidebar);

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 62 : 212 }}
      transition={{ type: 'spring', stiffness: 400, damping: 40 }}
      className="bg-sidebar text-sidebar-foreground border-sidebar-border hidden shrink-0 flex-col border-r md:flex"
    >
      <div
        className={cn(
          'flex h-14 shrink-0 items-center gap-2.5 px-[18px]',
          collapsed && 'justify-center px-0',
        )}
      >
        <ForgeMark />
        {!collapsed && (
          <span className="text-foreground text-base font-semibold tracking-tight">AI Harness</span>
        )}
      </div>

      <nav
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2.5 py-3"
        aria-label="Main"
      >
        {NAV_ITEMS.map((item) => {
          const active = isActivePath(pathname, item.href);
          const link = (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              aria-label={item.label}
              className={cn(
                'flex min-h-9 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors',
                'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                active && 'bg-sidebar-accent text-sidebar-accent-foreground font-semibold',
                collapsed && 'justify-center px-0',
              )}
            >
              <item.icon className="size-4 shrink-0" />
              {!collapsed && item.label}
            </Link>
          );
          return collapsed ? (
            <Tooltip key={item.href}>
              <TooltipTrigger asChild>{link}</TooltipTrigger>
              <TooltipContent side="right">{item.label}</TooltipContent>
            </Tooltip>
          ) : (
            link
          );
        })}
      </nav>

      <div
        className={cn(
          'border-sidebar-border mx-2.5 flex shrink-0 items-center gap-2 border-t py-2',
          collapsed ? 'flex-col' : 'justify-between',
        )}
      >
        <ConnectionStatus compact={collapsed} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={toggle}
              aria-label="Toggle sidebar"
            >
              {collapsed ? (
                <PanelLeftOpen className="size-4" />
              ) : (
                <PanelLeftClose className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Toggle sidebar (⌘B)</TooltipContent>
        </Tooltip>
      </div>
    </motion.aside>
  );
}
