import type { ReactElement } from "react";
import { Sheet } from "@/components/core/Sheet";
import { GhostResultCard } from "./GhostResultCard";

export interface HowItWorksSheetProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Mobile-only bottom sheet reproducing the State-1 ghost card on demand,
 * composed on the shared `Sheet` primitive (overlay/scrim/panel, Escape,
 * ARIA dialog wiring all live there now). No footer: the sheet never had a
 * footer-like action row, just the header Close. Never auto-opened;
 * open/closed state is local `useState` in `SearchForm`, never persisted.
 */
export function HowItWorksSheet({ open, onClose }: HowItWorksSheetProps): ReactElement | null {
  if (!open) return null;

  return (
    <Sheet open={open} onClose={onClose} ariaLabel="How Seatfirst works" maxWidth={400}>
      <Sheet.Header title="How it works" onClose={onClose} />
      <Sheet.Body>
        <GhostResultCard />
      </Sheet.Body>
    </Sheet>
  );
}
