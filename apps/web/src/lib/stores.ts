import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { LiveStatus } from './live';

interface ConnectionState {
  status: LiveStatus;
  setStatus: (s: LiveStatus) => void;
}

export const useConnection = create<ConnectionState>((set) => ({
  status: 'connecting',
  setStatus: (status) => set({ status }),
}));

const UI_STORAGE_KEY = 'ai-harness-ui';
/** Pre-rename (AgentForge) key: read once so existing UI preferences carry over. */
const LEGACY_UI_STORAGE_KEY = 'agentforge-ui';

/** localStorage that falls back to the legacy key until the new one has been written. */
const uiStorage = createJSONStorage(() => ({
  getItem: (name) => {
    try {
      return (
        localStorage.getItem(name) ??
        (name === UI_STORAGE_KEY ? localStorage.getItem(LEGACY_UI_STORAGE_KEY) : null)
      );
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch {
      // Storage unavailable (private mode, blocked): preferences just don't persist.
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch {
      // Same as above.
    }
  },
}));

interface UiState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  projectView: 'cards' | 'list';
  setProjectView: (view: UiState['projectView']) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      projectView: 'cards',
      setProjectView: (projectView) => set({ projectView }),
      paletteOpen: false,
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    }),
    {
      name: UI_STORAGE_KEY,
      storage: uiStorage,
      partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed, projectView: s.projectView }),
    },
  ),
);
