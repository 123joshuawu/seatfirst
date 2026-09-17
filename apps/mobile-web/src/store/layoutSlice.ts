import type { StateCreator } from "zustand";
import type { SeatfirstStore } from "./seatfirstStore";

export interface LayoutState {
  isFormCollapsed: boolean;
}

export interface LayoutActions {
  setFormCollapsed: (collapsed: boolean) => void;
  toggleFormCollapsed: () => void;
}

export type LayoutSlice = LayoutState & LayoutActions;

export const layoutInitialState: LayoutState = {
  isFormCollapsed: false,
};

export const createLayoutSlice: StateCreator<SeatfirstStore, [], [], LayoutSlice> = (set) => ({
  ...layoutInitialState,

  setFormCollapsed: (collapsed) => set({ isFormCollapsed: collapsed }),

  toggleFormCollapsed: () => set((s) => ({ isFormCollapsed: !s.isFormCollapsed })),
});
