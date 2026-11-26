'use client';

import { useEffect } from 'react';

const MESSAGE = 'You have unsaved changes. Leave without saving?';

/**
 * Warn before unsaved edits are dropped: on tab close/reload (`beforeunload`) and on in-app
 * navigation (clicks on internal links and on tabs, which unmount the current view). The App
 * Router has no navigation events, so clicks are intercepted in the capture phase.
 */
export function useUnsavedGuard(dirty: boolean, scope?: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = MESSAGE;
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const target = e.target as Element | null;
      // Clicks inside the guarded card (its own Save button, pickers) are fine.
      if (scope?.current && target && scope.current.contains(target)) return;
      const link = target?.closest('a[href]') as HTMLAnchorElement | null;
      const leaving =
        (link &&
          link.target !== '_blank' &&
          !e.metaKey &&
          !e.ctrlKey &&
          new URL(link.href, location.href).origin === location.origin &&
          link.pathname + link.search !== location.pathname + location.search) ||
        !!target?.closest('[role="tab"]:not([aria-selected="true"])');
      if (leaving && !window.confirm(MESSAGE)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty, scope]);
}
