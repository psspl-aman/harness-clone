import { create } from 'zustand';

export type PanelTab = 'agents' | 'terminals' | 'errors' | 'activity';

interface WorkspaceUi {
  panelOpen: boolean;
  panelTab: PanelTab;
  terminalId: string | null;
  panelHeight: number;
  setPanel: (
    p: Partial<Pick<WorkspaceUi, 'panelOpen' | 'panelTab' | 'terminalId' | 'panelHeight'>>,
  ) => void;
  /** Open the bottom panel on a terminal. */
  showTerminal: (terminalId: string) => void;
}

/** UI state of the project workspace's bottom panel (shared by header controls and the panel). */
export const useWorkspaceUi = create<WorkspaceUi>((set) => ({
  panelOpen: false,
  panelTab: 'terminals',
  terminalId: null,
  panelHeight: 300,
  setPanel: (p) => set(p),
  showTerminal: (terminalId) => set({ panelOpen: true, panelTab: 'terminals', terminalId }),
}));
