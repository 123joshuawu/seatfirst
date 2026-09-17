/**
 * Zustand store for the Seatfirst demo flow.
 *
 * Split into six slices per UI1 + UI2 + UI7 Design (see docs/tasks/UI1-zustand-state-store/spec.md
 * and docs/tasks/UI2-trpc-session-theatre-bootstrap/spec.md and ADR 0025 Decision 4):
 * - searchFormSlice — form fields
 * - flowSlice — screen FSM + timers
 * - bootstrapSlice — session bootstrap + theatre selection (UI2)
 * - searchSlice — search lifecycle (UI3)
 * - recheckSlice — recheck/handoff (UI6)
 * - layoutSlice — responsive collapsing form (UI7)
 *
 * Composed by a single `create` call so UI2/UI3/UI5/UI6/UI7 can land on disjoint
 * slice files without contending on this file (except for the one-line
 * composition spread, which is trivially mergeable).
 */
import { create } from "zustand";
import { createSearchFormSlice, type SearchFormSlice } from "./searchFormSlice";
import { createFlowSlice, type FlowSlice } from "./flowSlice";
import { createBootstrapSlice, type BootstrapSlice } from "./bootstrapSlice";
import { createSearchSlice, type SearchSlice } from "./searchSlice";
import { createLayoutSlice, type LayoutSlice } from "./layoutSlice";
import { createRecheckSlice, type RecheckSlice } from "./recheckSlice";

export type SeatfirstStore = SearchFormSlice &
  FlowSlice &
  BootstrapSlice &
  SearchSlice &
  LayoutSlice &
  RecheckSlice;

export const useSeatfirstStore = create<SeatfirstStore>()((...a) => ({
  ...createSearchFormSlice(...a),
  ...createFlowSlice(...a),
  ...createBootstrapSlice(...a),
  ...createSearchSlice(...a),
  ...createLayoutSlice(...a),
  ...createRecheckSlice(...a),
}));
