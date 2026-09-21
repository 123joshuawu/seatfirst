import { useCallback, useEffect, useState } from "react";
import { useWindowDimensions } from "react-native";
import type { RecoveryOption, ResultGroup } from "@seatfirst/core";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { openHandoff, resolveDeepLinkForShowtime } from "@/lib/handoff";
import { formatPlacementLabel, formatShowtimeLocal, relaxationLabel } from "@/lib/presentation";

/** Shared mobile breakpoint — mirrors `MOBILE_BREAKPOINT` in
 *  `useSubmitSearchViewModel` (`vm.isMobile` is `width < 680`). */
export const RECOVERY_SHEET_MOBILE_BREAKPOINT = 680;

/** Consumer-friendly header for each recovery rung (mirrors ReplacementCard's
 *  `recoveryLevelLabel` copy). Display-only: never drives `option.level`. */
export function recoveryLevelHeader(level: RecoveryOption["level"]): string {
  switch (level) {
    case 1:
      return "Closest seats nearby";
    case 2:
      return "Same seats, different showtime";
    case 3:
      return "Different seats, same showtime";
    case 4:
      return "A different showtime";
  }
}

function showtimeLabelForOption(
  option: RecoveryOption,
  groups: readonly {
    readonly showtimes: readonly {
      readonly showtimeId: string;
      readonly showDateTimeUtc: string;
      readonly timezone: string;
    }[];
  }[],
): string | null {
  for (const group of groups) {
    const st = group.showtimes.find((s) => s.showtimeId === option.showtimeId);
    if (st) return formatShowtimeLocal(st.showDateTimeUtc, st.timezone);
  }
  return null;
}

/** First describable relaxation on the option (mirrors ReplacementCard's display pick). */
function relaxedDescription(option: RecoveryOption): string | null {
  for (const r of option.relaxed) {
    const label = relaxationLabel(r);
    if (label !== null && label.length > 0) return label;
  }
  return null;
}

export interface RecoverySheetOptionView {
  option: RecoveryOption;
  header: string;
  placementLabel: string;
  timeLabel: string | null;
  relaxed: string | null;
  requiresConsent: boolean;
  consented: boolean;
  ctaEnabled: boolean;
}

export interface RecoverySheetViewModel {
  /** True only while the store holds the sheet open on a GONE result. */
  open: boolean;
  movieTitle: string;
  originalShowtimeLabel: string | null;
  takenShowtimeId: string | null;
  /** Recovery options in L1→L4 order with display labels/headers. */
  options: RecoverySheetOptionView[];
  handoffError: string | null;
  isMobile: boolean;
  actions: {
    dismiss: () => void;
    toggleConsent: (level: number) => void;
    selectOption: (option: RecoveryOption) => void;
  };
}

/**
 * UI41 (ADR 0071): recovery-overlay state for `RecoverySheet`. Reads the
 * `recheckSlice` GONE result + persistent taken set, maps each
 * `RecoveryOption` to its display descriptor, owns the transient Level 4
 * consent + handoff-error state, and wraps `openHandoff` + `dismissRecovery`
 * for alternative handoff. Matches the established viewmodel-hook shape
 * (state fields + `actions` object, cf. `useHandoffViewModel`).
 */
export function useRecoverySheetViewModel(): RecoverySheetViewModel {
  const store = useSeatfirstStore();
  const { width } = useWindowDimensions();
  const isMobile = width < RECOVERY_SHEET_MOBILE_BREAKPOINT;

  const [consentedLevels, setConsentedLevels] = useState<Set<number>>(() => new Set());
  const [handoffError, setHandoffError] = useState<string | null>(null);

  const recheckResult = store.recheckResult;
  const takenShowtimeId = store.recheckSelectedShowtimeId;
  const open = store.recoverySheetOpen && recheckResult !== null && recheckResult.status === "GONE";

  // Transient UI-only state: reset whenever the sheet opens on a new target
  // or closes, so consent never leaks across taken showtimes.
  useEffect(() => {
    setConsentedLevels(new Set());
    setHandoffError(null);
  }, [open, takenShowtimeId]);

  // Same live+retained union the results surface renders rows from, so deep
  // links and time labels agree with the row the sheet was opened from.
  const groups: ResultGroup[] = [...store.groups, ...store.retainedGroups];

  const movieTitle = store.movie.trim() || "Choose a movie";
  const originalShowtimeLabel: string | null = (() => {
    if (takenShowtimeId === null) return null;
    for (const group of groups) {
      const st = group.showtimes.find((s) => s.showtimeId === takenShowtimeId);
      if (st !== undefined) return formatShowtimeLocal(st.showDateTimeUtc, st.timezone);
    }
    return (
      store.scheduleSkeleton.find((e) => e.showtimeId === takenShowtimeId)?.showDateTimeLocal ??
      null
    );
  })();

  const recovery: readonly RecoveryOption[] =
    open && recheckResult !== null && recheckResult.status === "GONE"
      ? [...recheckResult.recovery].sort((a, b) => a.level - b.level)
      : [];

  const options: RecoverySheetOptionView[] = recovery.map((option) => {
    const requiresConsent = option.level === 4 && option.requiresConsent === true;
    const consented = consentedLevels.has(option.level);
    return {
      option,
      header: recoveryLevelHeader(option.level),
      placementLabel: formatPlacementLabel(option.placement),
      timeLabel: showtimeLabelForOption(option, groups),
      relaxed: relaxedDescription(option),
      requiresConsent,
      consented,
      ctaEnabled: !requiresConsent || consented,
    };
  });
  const dismiss = useCallback(() => {
    useSeatfirstStore.getState().dismissRecovery();
  }, []);

  const toggleConsent = useCallback((level: number) => {
    setConsentedLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }, []);

  const selectOption = useCallback(
    (option: RecoveryOption) => {
      // Level 4 consent gate — must be checked before proceeding (ADR 0063 §5).
      if (
        option.level === 4 &&
        option.requiresConsent === true &&
        !consentedLevels.has(option.level)
      ) {
        return;
      }
      const live = useSeatfirstStore.getState();
      const deepLinkUrl = resolveDeepLinkForShowtime(option.showtimeId, [
        ...live.groups,
        ...live.retainedGroups,
      ]);
      if (deepLinkUrl === null) {
        setHandoffError("Couldn't open AMC for that time — pick another alternative.");
        return;
      }
      setHandoffError(null);
      void openHandoff(deepLinkUrl);
      live.dismissRecovery();
    },
    [consentedLevels],
  );

  return {
    open,
    movieTitle,
    originalShowtimeLabel,
    takenShowtimeId,
    options,
    handoffError,
    isMobile,
    actions: { dismiss, toggleConsent, selectOption },
  };
}
