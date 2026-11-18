'use client';

import '@xterm/xterm/css/xterm.css';
import type { Terminal } from '@xterm/xterm';
import { useTheme } from 'next-themes';
import { useEffect, useRef } from 'react';
import { useLiveEvent, useLiveTopic } from '@/components/live-provider';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const THEMES = {
  dark: {
    background: '#121318',
    foreground: '#e6e6ea',
    cursor: '#a78bfa',
    selectionBackground: '#a78bfa55',
  },
  light: {
    background: '#fbfbfd',
    foreground: '#1f2026',
    cursor: '#6d4aff',
    selectionBackground: '#6d4aff33',
  },
};

/**
 * Interactive view of a daemon PTY. Replays the scrollback on mount, then
 * appends live `terminal.output` events; keystrokes are batched (~8 ms) and
 * posted to the daemon; the PTY is resized to fit the container.
 */
export function XtermView({
  terminalId,
  className,
  onExit,
}: {
  terminalId: string;
  className?: string;
  onExit?: (code: number | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const pendingOutput = useRef<string[]>([]);
  const ready = useRef(false);
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === 'dark' ? THEMES.dark : THEMES.light;
  useLiveTopic(`terminal:${terminalId}`);

  useLiveEvent((e) => {
    if (e.type === 'terminal.output' && e.payload.terminalId === terminalId) {
      if (ready.current) term.current?.write(e.payload.data);
      else pendingOutput.current.push(e.payload.data);
    }
    if (e.type === 'terminal.exit' && e.payload.terminalId === terminalId) {
      term.current?.write(
        `\r\n\x1b[2m[process exited${e.payload.exitCode !== null ? ` with code ${e.payload.exitCode}` : ''}]\x1b[0m\r\n`,
      );
      onExit?.(e.payload.exitCode);
    }
  });

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed || !host.current) return;
      const t = new Terminal({
        // Canvas rendering can't resolve CSS variables, so pass the real font name.
        fontFamily: `${getComputedStyle(document.documentElement).getPropertyValue('--font-geist-mono').trim() || 'ui-monospace'}, ui-monospace, monospace`,
        fontSize: 13,
        cursorBlink: true,
        convertEol: false,
        scrollback: 5000,
        theme,
      });
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(host.current);
      fit.fit();
      term.current = t;

      // Scrollback first, then anything that streamed in meanwhile.
      try {
        const info = await api.terminals.get(terminalId);
        t.write(info.scrollback);
        if (info.status === 'exited')
          t.write(
            `\r\n\x1b[2m[process exited${info.exitCode !== null ? ` with code ${info.exitCode}` : ''}]\x1b[0m\r\n`,
          );
      } catch {
        t.write('\x1b[31mCould not load terminal output.\x1b[0m\r\n');
      }
      for (const chunk of pendingOutput.current.splice(0)) t.write(chunk);
      ready.current = true;

      let buf = '';
      let timer: ReturnType<typeof setTimeout> | null = null;
      const sub = t.onData((d) => {
        buf += d;
        timer ??= setTimeout(() => {
          const data = buf;
          buf = '';
          timer = null;
          void api.terminals.input(terminalId, data).catch(() => {});
        }, 8);
      });
      const resize = () => {
        fit.fit();
        void api.terminals.resize(terminalId, t.cols, t.rows).catch(() => {});
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(host.current);
      t.focus();
      cleanup = () => {
        ro.disconnect();
        sub.dispose();
        t.dispose();
      };
    })();
    return () => {
      disposed = true;
      ready.current = false;
      term.current = null;
      cleanup();
    };
    // Theme changes are applied below without re-creating the terminal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  useEffect(() => {
    if (term.current) term.current.options.theme = theme;
  }, [theme]);

  return (
    <div
      ref={host}
      className={cn('h-80 overflow-hidden rounded-lg border p-2', className)}
      style={{ background: theme.background }}
    />
  );
}
