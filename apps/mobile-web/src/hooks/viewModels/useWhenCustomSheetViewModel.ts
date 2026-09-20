import { useState, useEffect, useMemo } from "react";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { useFacetCounts } from "../useFacetCounts";
import { validateCustomDates, toggleBandInSelection } from "@/lib/whenPresets";
import { canonicalizeCustomDates, customDatesToRuns } from "@/lib/dates";
import { formatWhenReadout } from "@/lib/whenPresets";
import { localDateString } from "@/lib/dates";
import type { ChipItem } from "@/types/ui";

function todayIso(): string {
  return localDateString(new Date());
}

function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return localDateString(d);
}

function defaultDraftDates(): string[] {
  const t = todayIso();
  return canonicalizeCustomDates([t, addDaysIso(t, 1), addDaysIso(t, 2)]);
}

function expandRangeToDates(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(from + "T00:00:00");
  const end = new Date(to + "T00:00:00");
  for (let cur = new Date(start); cur <= end; cur.setDate(cur.getDate() + 1)) {
    out.push(localDateString(new Date(cur)));
  }
  return canonicalizeCustomDates(out);
}

export interface WhenCustomSheetViewModel {
  whenSheetOpen: boolean;
  /** UI22: canonical sorted unique draft set */
  draftDates: string[];
  /** Custom dialog draft band set (committed only on Apply) */
  draftBands: string[];
  /** Time-of-day chips bound to the draft, not the committed selection */
  bandChips: ChipItem[];
  /** @deprecated — derived from draftDates[0] for legacy callers */
  draftFrom: string;
  /** @deprecated — derived from draftDates[ last ] for legacy callers */
  draftTo: string;
  minIso: string;
  maxIso: string;
  /** UI23: DATE-axis facet counts keyed by ISO date (only while the sheet is open). */
  dateCounts?: Map<string, { count: number; coldTheatreCount: number }>;
  /** UI23: live selected-theatre count the facet request was scoped to. */
  totalTheatres?: number;
  error: string | null;
  spanDays: number;
  /** Human-readable runs for sheet summary (absolute dates) */
  draftReadout: string;
  actions: {
    onSelectDay: (iso: string) => void;
    onToggleBand: (band: string) => void;
    handleApply: () => void;
    handleCancel: () => void;
    /** Clear the in-progress draft to an empty selection (matches the button label). */
    handleClearDates: () => void;
  };
}

export function useWhenCustomSheetViewModel(): WhenCustomSheetViewModel {
  const whenSheetOpen = useSeatfirstStore((s) => s.whenSheetOpen);
  const selectedDates = useSeatfirstStore((s) => s.selectedDates);
  const selectedTheatres = useSeatfirstStore((s) => s.selectedTheatres);
  const legacyTheatre = useSeatfirstStore((s) => s.selectedTheatre);
  const selectedMovieId = useSeatfirstStore((s) => s.selectedMovieId);
  const selectedBands = useSeatfirstStore((s) => s.selectedBands);
  const applyCustomSelection = useSeatfirstStore((s) => s.applyCustomSelection);
  const setWhenSheetOpen = useSeatfirstStore((s) => s.setWhenSheetOpen);
  const cancelCustomEdit = useSeatfirstStore((s) => s.cancelCustomEdit);

  // UI24: the draft seeds from the single committed `selectedDates` truth.
  const [draftDates, setDraftDates] = useState<string[]>(() => {
    if (selectedDates.length > 0) return [...selectedDates];
    return defaultDraftDates();
  });
  const [draftBands, setDraftBands] = useState<string[]>(() => [...selectedBands]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (whenSheetOpen) {
      if (selectedDates.length > 0) {
        setDraftDates([...selectedDates]);
      } else {
        setDraftDates(defaultDraftDates());
      }
      setDraftBands([...selectedBands]);
      setError(null);
    }
  }, [whenSheetOpen, selectedDates, selectedBands]);

  const minIso = todayIso();
  const maxIso = addDaysIso(todayIso(), 29);
  // UI23: DATE-axis facet counts over the same 30-day window the calendar
  // iterates. Fires only while the sheet is open (null input = no request).
  const facetTheatreIds = useMemo(
    () =>
      (selectedTheatres.length > 0 ? selectedTheatres : legacyTheatre ? [legacyTheatre] : []).map(
        (t) => t.id,
      ),
    [selectedTheatres, legacyTheatre],
  );
  const dateCandidates = useMemo(() => expandRangeToDates(minIso, maxIso), [minIso, maxIso]);
  const dateFacet = useFacetCounts(
    whenSheetOpen && facetTheatreIds.length > 0 && dateCandidates.length > 0
      ? {
          theatreIds: facetTheatreIds,
          movieId: selectedMovieId,
          axes: [{ kind: "DATE", candidates: dateCandidates }],
        }
      : null,
  );

  const onSelectDay = (iso: string) => {
    setDraftDates((prev) => {
      const set = new Set(prev);
      if (set.has(iso)) {
        set.delete(iso);
      } else {
        set.add(iso);
      }
      return canonicalizeCustomDates([...set]);
    });
  };

  const onToggleBand = (band: string) => {
    setDraftBands((prev) => toggleBandInSelection(prev, band).bands);
  };

  const handleApply = () => {
    if (draftDates.length === 0) {
      setError("Pick at least one date");
      return;
    }
    const check = validateCustomDates(draftDates);
    if (!check.valid) {
      setError(check.error ?? "Invalid range");
      return;
    }
    const ok = applyCustomSelection(draftDates, draftBands);
    if (!ok) {
      setError("Custom span must be \u226430 days");
      return;
    }
    setWhenSheetOpen(false);
  };

  const handleCancel = () => {
    cancelCustomEdit();
  };

  const handleClearDates = () => {
    // The button reads "Clear dates", so it empties the draft. An empty draft
    // is safe everywhere downstream: Apply is guarded with a "Pick at least
    // one date" error, the summary line shows that same empty-state string,
    // spanDays/readout degrade to 0/"", and the deprecated draftFrom/draftTo
    // fall back to today.
    setDraftDates([]);
    setError(null);
  };

  const spanDays = useMemo(() => {
    if (draftDates.length === 0) return 0;
    try {
      const v = validateCustomDates(draftDates);
      return v.spanDays;
    } catch {
      return 0;
    }
  }, [draftDates]);

  const draftReadout = useMemo(() => {
    if (draftDates.length === 0) return "";
    try {
      return formatWhenReadout({ dates: draftDates, selectedBands: draftBands });
    } catch {
      const runs = customDatesToRuns(draftDates);
      return runs
        .map((r) => {
          if (r.from === r.to) return r.from;
          return `${r.from} – ${r.to}`;
        })
        .join(", ");
    }
  }, [draftDates, draftBands]);

  const BANDS = ["Any time", "Morning", "Afternoon", "Evening", "Late"] as const;
  const bandOrder = ["Morning", "Afternoon", "Evening", "Late"] as const;
  const bandChips: ChipItem[] = BANDS.map((b) => {
    let active = false;
    if (b === "Any time") active = draftBands.length === 0;
    else {
      const idx = bandOrder.indexOf(b);
      if (draftBands.length > 0) {
        const indices = draftBands
          .map((x) => bandOrder.indexOf(x as (typeof bandOrder)[number]))
          .filter((i) => i >= 0);
        if (indices.length > 0) {
          const lo = Math.min(...indices);
          const hi = Math.max(...indices);
          active = idx >= lo && idx <= hi;
        }
      }
    }
    return {
      label: b,
      active,
      onPress: () => onToggleBand(b),
    };
  });

  const draftFrom = draftDates.length > 0 ? draftDates[0]! : todayIso();
  const draftTo = draftDates.length > 0 ? draftDates[draftDates.length - 1]! : todayIso();

  return {
    whenSheetOpen,
    draftDates,
    draftBands,
    bandChips,
    draftFrom,
    draftTo,
    minIso,
    maxIso,
    dateCounts: dateFacet.countsMap,
    totalTheatres: facetTheatreIds.length,
    error,
    spanDays,
    draftReadout,
    actions: {
      onSelectDay,
      onToggleBand,
      handleApply,
      handleCancel,
      handleClearDates,
    },
  };
}
