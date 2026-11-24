import type { Metadata } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { AppShell } from '@/components/shell/app-shell';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'AgentForge', template: '%s · AgentForge' },
  description: 'Local-first agentic coding harness and agent factory',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      {/* Browser extensions (e.g. ColorZilla's `cz-shortcut-listen`, Grammarly) add attributes
          to <body> before React hydrates. This only silences mismatches on <body>'s own
          attributes, one level deep — children still report real hydration bugs. */}
      <body suppressHydrationWarning>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
